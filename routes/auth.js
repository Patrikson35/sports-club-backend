const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { sendVerificationEmail } = require('../services/email');
const { authenticate, requireRole } = require('../middleware/auth');

const normalizeRole = (role) => (role === 'club_admin' ? 'club' : role);

const normalizeSportKey = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
};

const resolveFrontendBaseUrl = (req) => {
  const configured = String(process.env.FRONTEND_URL || '').trim();
  const configuredIsLocal = /localhost|127\.0\.0\.1/i.test(configured);
  if (configured && !configuredIsLocal) {
    return configured.replace(/\/$/, '');
  }

  const corsOrigin = String(process.env.CORS_ORIGIN || '').trim();
  const corsOriginIsLocal = /localhost|127\.0\.0\.1/i.test(corsOrigin);
  if (corsOrigin && !corsOriginIsLocal && /^https?:\/\//i.test(corsOrigin)) {
    return corsOrigin.replace(/\/$/, '');
  }

  const forwardedProtoRaw = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHostRaw = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim();
  const protocol = forwardedProtoRaw || 'https';

  if (forwardedHostRaw) {
    if (/railway\.app$/i.test(forwardedHostRaw)) {
      return 'https://ppsport.pro';
    }
    return `${protocol}://${forwardedHostRaw}`;
  }

  return 'https://ppsport.pro';
};

const ensureParentTables = async () => {
  await db.query(`
    CREATE TABLE IF NOT EXISTS parents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS parent_child_links (
      id INT AUTO_INCREMENT PRIMARY KEY,
      parent_id INT NOT NULL,
      child_user_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_parent_child (parent_id, child_user_id),
      FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE,
      FOREIGN KEY (child_user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
};

const getUsersTableColumnSet = async () => {
  const [columns] = await db.query('SHOW COLUMNS FROM users');
  return new Set(columns.map((column) => column.Field));
};

const createUserWithCompatibleColumns = async ({
  email,
  passwordHash,
  firstName,
  lastName,
  role,
  sportKey
}) => {
  const usersColumns = await getUsersTableColumnSet();
  const columnNames = ['email', 'password_hash', 'first_name', 'last_name', 'role'];
  const values = [email, passwordHash, firstName, lastName, role];

  if (usersColumns.has('sport')) {
    columnNames.push('sport');
    values.push(sportKey);
  }

  if (usersColumns.has('is_active')) {
    columnNames.push('is_active');
    values.push(true);
  }

  if (usersColumns.has('is_verified')) {
    columnNames.push('is_verified');
    values.push(false);
  }

  const placeholders = columnNames.map(() => '?').join(', ');
  const sql = `INSERT INTO users (${columnNames.join(', ')}) VALUES (${placeholders})`;
  const [result] = await db.query(sql, values);
  return result;
};

// POST /api/auth/login - User login
router.post('/login', [
  body('email').isEmail().customSanitizer((value) => String(value || '').trim().toLowerCase()),
  body('password').notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Get user from database. Some DB snapshots do not have `is_active` yet.
    let users;
    try {
      const [rows] = await db.query(
        'SELECT * FROM users WHERE email = ? AND is_active = TRUE',
        [email]
      );
      users = rows;
    } catch (queryError) {
      if (queryError && queryError.code === 'ER_BAD_FIELD_ERROR') {
        const [rows] = await db.query(
          'SELECT * FROM users WHERE email = ?',
          [email]
        );
        users = rows;
      } else {
        throw queryError;
      }
    }

    if (users.length === 0) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users[0];

    // Verify password
    const validPassword = await bcrypt.compare(password, user.password_hash);
    if (!validPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Create JWT token
    const token = jwt.sign(
      { 
        id: user.id, 
        email: user.email, 
        role: user.role 
      },
      process.env.JWT_SECRET,
      { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
    );

    // Update last login when the column exists (older DB snapshots may not have it).
    try {
      await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);
    } catch (queryError) {
      if (!queryError || queryError.code !== 'ER_BAD_FIELD_ERROR') {
        throw queryError;
      }
    }

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: normalizeRole(user.role),
        avatar: user.avatar_url
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/register - User registration (multi-step)
router.post('/register', [
  body('email').isEmail().customSanitizer((value) => String(value || '').trim().toLowerCase()),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { 
      email, password, firstName, lastName, 
      registrationType, // 'player', 'coach', 'club', 'parent'
      sport,
      isPlayerOlderThan18,
      isPlayerOlderThan15,
      parentFirstName,
      parentLastName,
      parentEmail,
      // Club data (optional)
      clubName, address, city, country, logo,
      // Trainer data (optional)
      clubId, isClubTrainer, isPersonalTrainer,
      // Player data (optional)
      dateOfBirth, position, preferredFoot
    } = req.body;

    const playerIsOlderThan18 = registrationType === 'player'
      ? (typeof isPlayerOlderThan18 === 'boolean'
        ? isPlayerOlderThan18
        : (typeof isPlayerOlderThan15 === 'boolean'
          ? isPlayerOlderThan15
          : String(isPlayerOlderThan18 ?? isPlayerOlderThan15).toLowerCase() !== 'false'))
      : true;

    if (registrationType === 'club' && !normalizeSportKey(sport)) {
      return res.status(400).json({ error: 'Pri registrácii klubu je výber športu povinný' });
    }

    if (registrationType === 'player' && !playerIsOlderThan18) {
      if (!parentFirstName || !parentLastName || !parentEmail) {
        return res.status(400).json({ error: 'Pri hráčovi mladšom ako 18 rokov sú údaje rodiča povinné' });
      }
    }

    // Check if email already exists
    const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Determine role based on registrationType
    let role = registrationType || 'player'; // club, coach, or player
    const sportKey = normalizeSportKey(sport);

    // Insert user using only columns present in the current DB snapshot.
    const userResult = await createUserWithCompatibleColumns({
      email,
      passwordHash,
      firstName,
      lastName,
      role,
      sportKey
    });

    const userId = userResult.insertId;

    if (registrationType === 'player' && !playerIsOlderThan18) {
      await ensureParentTables();

      const [existingParents] = await db.query(
        'SELECT id FROM parents WHERE email = ? LIMIT 1',
        [parentEmail]
      );

      let parentId;
      if (existingParents.length > 0) {
        parentId = existingParents[0].id;
        await db.query(
          'UPDATE parents SET first_name = ?, last_name = ? WHERE id = ?',
          [parentFirstName, parentLastName, parentId]
        );
      } else {
        const [parentResult] = await db.query(
          `INSERT INTO parents (first_name, last_name, email)
           VALUES (?, ?, ?)`,
          [parentFirstName, parentLastName, parentEmail]
        );
        parentId = parentResult.insertId;
      }

      await db.query(
        `INSERT INTO parent_child_links (parent_id, child_user_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE created_at = created_at`,
        [parentId, userId]
      );
    }

    // Note: For club registration, the club entity will be created later
    // (after email verification and profile completion)
    // For now, we only create the user with role='club'

    // Create email verification token
    const verificationToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24); // Token expires in 24 hours

    await db.query(
      `INSERT INTO email_verifications (user_id, token, email, expires_at) 
       VALUES (?, ?, ?, ?)`,
      [userId, verificationToken, email, expiresAt]
    );

    // Send verification email
    try {
      await sendVerificationEmail(email, verificationToken, firstName);
      console.log(`✅ Verification email sent to ${email}`);
    } catch (emailError) {
      console.error(`⚠️ Failed to send verification email to ${email}:`, emailError.message);
      // Continue anyway - user is registered, they can request resend later
    }

    const frontendUrl = resolveFrontendBaseUrl(req);
    const verificationLink = `${frontendUrl}/verify-email?token=${verificationToken}`;

    res.status(201).json({
      message: 'Registrácia úspešná! Skontrolujte svoj email pre dokončenie registrácie.',
      user: {
        id: userId,
        email,
        firstName,
        lastName,
        role,
        isVerified: false
      },
      verification: {
        token: verificationToken,
        link: verificationLink
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/registration-context - Registration context for current user
router.get('/registration-context', authenticate, async (req, res, next) => {
  try {
    const isPlayer = req.user?.role === 'player';

    if (!isPlayer) {
      return res.json({
        role: normalizeRole(req.user?.role || null),
        isParentFlow: false
      });
    }

    await ensureParentTables();

    const [links] = await db.query(
      `SELECT id FROM parent_child_links WHERE child_user_id = ? LIMIT 1`,
      [req.user.id]
    );

    return res.json({
      role: normalizeRole(req.user.role),
      isParentFlow: links.length > 0
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/pending - Get pending registrations (admin only)
router.get('/pending', authenticate, requireRole(['admin']), async (req, res, next) => {
  try {
    const [pendingUsers] = await db.query(`
      SELECT 
        u.id, 
        u.email, 
        u.first_name, 
        u.last_name, 
        u.role, 
        u.created_at,
        c.name as club_name
      FROM users u
      LEFT JOIN clubs c ON u.id = c.owner_id
      WHERE u.is_verified = FALSE
      ORDER BY u.created_at DESC
    `);

    res.json({
      total: pendingUsers.length,
      users: pendingUsers
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/approve/:id - Approve user registration (admin only)
router.post('/approve/:id', authenticate, requireRole(['admin']), async (req, res, next) => {
  try {
    const userId = req.params.id;

    await db.query(
      'UPDATE users SET is_verified = TRUE WHERE id = ?',
      [userId]
    );

    res.json({ message: 'Užívateľ schválený' });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/reject/:id - Reject user registration (admin only)
router.post('/reject/:id', authenticate, requireRole(['admin']), async (req, res, next) => {
  try {
    const userId = req.params.id;

    // Delete user and associated data
    await db.query('DELETE FROM users WHERE id = ?', [userId]);

    res.json({ message: 'Registrácia zamietnutá' });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/parent-child-links - Parent-child links (admin only)
router.get('/parent-child-links', authenticate, requireRole(['admin']), async (req, res, next) => {
  try {
    await ensureParentTables();

    const { parentEmail, childEmail } = req.query;
    const conditions = [];
    const params = [];

    if (parentEmail) {
      conditions.push('p.email = ?');
      params.push(parentEmail);
    }

    if (childEmail) {
      conditions.push('u.email = ?');
      params.push(childEmail);
    }

    const whereSql = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const [rows] = await db.query(
      `SELECT 
         pcl.id,
         pcl.parent_id,
         pcl.child_user_id,
         pcl.created_at,
         p.first_name AS parent_first_name,
         p.last_name AS parent_last_name,
         p.email AS parent_email,
         u.first_name AS child_first_name,
         u.last_name AS child_last_name,
         u.email AS child_email
       FROM parent_child_links pcl
       JOIN parents p ON p.id = pcl.parent_id
       JOIN users u ON u.id = pcl.child_user_id
       ${whereSql}
       ORDER BY pcl.created_at DESC`,
      params
    );

    res.json({
      total: rows.length,
      links: rows.map((row) => ({
        id: row.id,
        createdAt: row.created_at,
        parent: {
          id: row.parent_id,
          firstName: row.parent_first_name,
          lastName: row.parent_last_name,
          email: row.parent_email
        },
        child: {
          id: row.child_user_id,
          firstName: row.child_first_name,
          lastName: row.child_last_name,
          email: row.child_email
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
