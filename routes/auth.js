const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { sendVerificationEmail } = require('../services/email');

// POST /api/auth/login - User login
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').notEmpty()
], async (req, res, next) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Get user from database
    const [users] = await db.query(
      'SELECT * FROM users WHERE email = ? AND is_active = TRUE',
      [email]
    );

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

    // Update last login
    await db.query('UPDATE users SET last_login = NOW() WHERE id = ?', [user.id]);

    res.json({
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        role: user.role,
        avatar: user.avatar_url
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/auth/register - User registration (multi-step)
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
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
      // Club data (optional)
      clubName, address, city, country, logo,
      // Trainer data (optional)
      clubId, isClubTrainer, isPersonalTrainer,
      // Player data (optional)
      dateOfBirth, position, preferredFoot
    } = req.body;

    // Check if email already exists
    const [existingUsers] = await db.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);

    // Determine role based on registrationType
    let role = 'player';
    if (registrationType === 'club') {
      role = 'club';
    } else if (registrationType === 'club_coach') {
      role = 'coach'; // Klubový tréner má rolu 'coach'
    } else if (registrationType === 'private_coach') {
      role = 'private_coach';
    } else if (registrationType === 'player') {
      role = 'player';
    } else {
      role = 'player'; // default
    }

    // Insert user (is_verified = FALSE = waiting for email verification)
    const [userResult] = await db.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, date_of_birth, is_active, is_verified) 
       VALUES (?, ?, ?, ?, ?, ?, TRUE, FALSE)`,
      [email, passwordHash, firstName, lastName, role, dateOfBirth || null]
    );

    const userId = userResult.insertId;

    // Handle specific registration types
    if (registrationType === 'club') {
      // Create club
      if (!clubName) {
        return res.status(400).json({ error: 'Meno klubu je povinné' });
      }

      await db.query(
        `INSERT INTO clubs (name, address, city, country, owner_id, email, is_active) 
         VALUES (?, ?, ?, ?, ?, ?, TRUE)`,
        [clubName, address || null, city || null, country || 'SK', userId, email]
      );
    } 
    else if (registrationType === 'coach') {
      // Trainer registration - optionally associate with club
      // TODO: Add trainer-specific data if needed
      // For now, just create user with coach role
    } 
    else if (registrationType === 'player') {
      // Player registration - will be added to team after approval
      // Store position in user record or wait for team assignment
    }

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

    res.status(201).json({
      message: 'Registrácia úspešná! Skontrolujte svoj email pre dokončenie registrácie.',
      user: {
        id: userId,
        email,
        firstName,
        lastName,
        role,
        isVerified: false
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/auth/pending - Get pending registrations (admin only)
router.get('/pending', async (req, res, next) => {
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
router.post('/approve/:id', async (req, res, next) => {
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
router.post('/reject/:id', async (req, res, next) => {
  try {
    const userId = req.params.id;

    // Delete user and associated data
    await db.query('DELETE FROM users WHERE id = ?', [userId]);

    res.json({ message: 'Registrácia zamietnutá' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
