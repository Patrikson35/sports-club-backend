const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { sendEmail } = require('../services/email');

// Helper: Generate random token
const generateToken = () => crypto.randomBytes(32).toString('hex');

// Helper: Calculate age from date of birth
const calculateAge = (dob) => {
  const today = new Date();
  const birthDate = new Date(dob);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
};

// ============================================
// 1. REGISTRACE KLUBU (CLUB_ADMIN)
// ============================================

router.post('/register-club', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim(),
  body('clubName').notEmpty().trim(),
  body('country').notEmpty(),
  body('city').optional()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, firstName, lastName, clubName, country, city, address, logoUrl } = req.body;

    // Check if email exists
    const [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // Create user with club_admin role
    const passwordHash = await bcrypt.hash(password, 10);
    const [userResult] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, is_verified) 
       VALUES (?, ?, ?, ?, 'club_admin', TRUE, FALSE)`,
      [email, passwordHash, firstName, lastName]
    );

    const userId = userResult.insertId;

    // Create club
    const [clubResult] = await connection.query(
      `INSERT INTO clubs (name, country, city, address, logo_url, owner_id, email, is_active) 
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE)`,
      [clubName, country, city || null, address || null, logoUrl || null, userId, email]
    );

    const clubId = clubResult.insertId;

    // Add user to club_members
    await connection.query(
      `INSERT INTO club_members (club_id, user_id, member_role, added_by) 
       VALUES (?, ?, 'club_admin', ?)`,
      [clubId, userId, userId]
    );

    // Create email verification token
    const verificationToken = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
    await connection.query(
      `INSERT INTO email_verifications (user_id, token, email, expires_at) 
       VALUES (?, ?, ?, ?)`,
      [userId, verificationToken, email, expiresAt]
    );

    // Send verification email
    await sendEmail({
      to: email,
      subject: 'Overte svoj email',
      html: `
        <h1>Vitajte v Sports Club!</h1>
        <p>Kliknite na odkaz pre overenie emailu:</p>
        <a href="${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}">Overiť email</a>
      `
    });

    await connection.commit();

    res.status(201).json({
      message: 'Klub úspěšně vytvořen. Zkontrolujte email pro ověření.',
      user: {
        id: userId,
        email,
        firstName,
        lastName,
        role: 'club_admin'
      },
      club: {
        id: clubId,
        name: clubName
      }
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// 2. REGISTRACE KLUBOVÉHO TRENÉRA (COACH)
// ============================================

router.post('/register-coach', [
  body('inviteCode').notEmpty(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { inviteCode, password, firstName, lastName, phone, dateOfBirth } = req.body;

    // Validate invite
    const [invites] = await connection.query(
      `SELECT * FROM invites 
       WHERE invite_code = ? AND invite_type = 'coach' AND status = 'pending' AND expires_at > NOW()`,
      [inviteCode]
    );

    if (invites.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Neplatná nebo expirovaná pozvánka' });
    }

    const invite = invites[0];

    // Check if email already exists
    const [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [invite.email]);
    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const [userResult] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, phone, date_of_birth, is_active, is_verified) 
       VALUES (?, ?, ?, ?, 'coach', ?, ?, TRUE, TRUE)`,
      [invite.email, passwordHash, firstName, lastName, phone || null, dateOfBirth || null]
    );

    const userId = userResult.insertId;

    // Add to club_members
    await connection.query(
      `INSERT INTO club_members (club_id, user_id, member_role, added_by) 
       VALUES (?, ?, 'coach', ?)`,
      [invite.club_id, userId, invite.invited_by]
    );

    // Mark invite as accepted
    await connection.query(
      `UPDATE invites SET status = 'accepted', accepted_at = NOW(), accepted_by = ? WHERE id = ?`,
      [userId, invite.id]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Trenér úspěšně registrován',
      user: {
        id: userId,
        email: invite.email,
        firstName,
        lastName,
        role: 'coach',
        clubId: invite.club_id
      }
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// 3. REGISTRACE PRIVÁTNÍHO TRENÉRA
// ============================================

router.post('/register-private-coach', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, firstName, lastName, phone, country, bio } = req.body;

    // Check if email exists
    const [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // Create user with private_coach role
    const passwordHash = await bcrypt.hash(password, 10);
    const [userResult] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, phone, is_active, is_verified) 
       VALUES (?, ?, ?, ?, 'private_coach', ?, TRUE, FALSE)`,
      [email, passwordHash, firstName, lastName, phone || null]
    );

    const userId = userResult.insertId;

    // Create verification token
    const verificationToken = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await connection.query(
      `INSERT INTO email_verifications (user_id, token, email, expires_at) 
       VALUES (?, ?, ?, ?)`,
      [userId, verificationToken, email, expiresAt]
    );

    // Send verification email
    await sendEmail({
      to: email,
      subject: 'Overte svoj email',
      html: `
        <h1>Vitajte ako privátny tréner!</h1>
        <p>Kliknite na odkaz pre overenie emailu:</p>
        <a href="${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}">Overiť email</a>
      `
    });

    await connection.commit();

    res.status(201).json({
      message: 'Privátny trenér registrován. Zkontrolujte email.',
      user: {
        id: userId,
        email,
        firstName,
        lastName,
        role: 'private_coach'
      }
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// 4. REGISTRACE ASISTENTA
// ============================================

router.post('/register-assistant', [
  body('inviteCode').notEmpty(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { inviteCode, password, firstName, lastName, phone } = req.body;

    // Validate invite
    const [invites] = await connection.query(
      `SELECT * FROM invites 
       WHERE invite_code = ? AND invite_type = 'assistant' AND status = 'pending' AND expires_at > NOW()`,
      [inviteCode]
    );

    if (invites.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Neplatná pozvánka' });
    }

    const invite = invites[0];

    // Check if email exists
    const [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [invite.email]);
    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // Create user
    const passwordHash = await bcrypt.hash(password, 10);
    const [userResult] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, phone, is_active, is_verified) 
       VALUES (?, ?, ?, ?, 'assistant', ?, TRUE, TRUE)`,
      [invite.email, passwordHash, firstName, lastName, phone || null]
    );

    const userId = userResult.insertId;

    // Add to club_members
    await connection.query(
      `INSERT INTO club_members (club_id, user_id, member_role, added_by) 
       VALUES (?, ?, 'assistant', ?)`,
      [invite.club_id, userId, invite.invited_by]
    );

    // Parse metadata for coach assignment
    const metadata = invite.metadata ? JSON.parse(invite.metadata) : {};
    if (metadata.coach_id) {
      await connection.query(
        `INSERT INTO coach_assistants (coach_id, assistant_id, club_id, team_id, assigned_by) 
         VALUES (?, ?, ?, ?, ?)`,
        [metadata.coach_id, userId, invite.club_id, metadata.team_id || null, invite.invited_by]
      );
    }

    // Mark invite as accepted
    await connection.query(
      `UPDATE invites SET status = 'accepted', accepted_at = NOW(), accepted_by = ? WHERE id = ?`,
      [userId, invite.id]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Asistent úspěšně registrován',
      user: {
        id: userId,
        email: invite.email,
        firstName,
        lastName,
        role: 'assistant',
        clubId: invite.club_id
      }
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// 5. REGISTRACE HRÁČE (s rodičem pokud < 16)
// ============================================

router.post('/register-player', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim(),
  body('dateOfBirth').isISO8601().toDate(),
  body('parentEmail').optional().isEmail().normalizeEmail(),
  body('parentFirstName').optional().trim(),
  body('parentLastName').optional().trim()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      email,
      password,
      firstName,
      lastName,
      dateOfBirth,
      position,
      preferredFoot,
      height,
      weight,
      parentEmail,
      parentFirstName,
      parentLastName,
      parentPassword,
      inviteCode
    } = req.body;

    // Calculate age
    const age = calculateAge(dateOfBirth);
    const requiresParent = age < 16;

    // Check if email exists
    const [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // If requires parent, validate parent data
    if (requiresParent && (!parentEmail || !parentFirstName || !parentLastName)) {
      await connection.rollback();
      return res.status(400).json({ error: 'Pre hráčov mladších ako 16 rokov je potrebný rodič' });
    }

    let parentId = null;

    // Create parent if needed
    if (requiresParent) {
      const [existingParents] = await connection.query('SELECT id FROM users WHERE email = ?', [parentEmail]);
      
      if (existingParents.length > 0) {
        parentId = existingParents[0].id;
      } else {
        const parentPasswordHash = await bcrypt.hash(parentPassword || crypto.randomBytes(16).toString('hex'), 10);
        const [parentResult] = await connection.query(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, is_verified) 
           VALUES (?, ?, ?, ?, 'parent', TRUE, FALSE)`,
          [parentEmail, parentPasswordHash, parentFirstName, parentLastName]
        );
        parentId = parentResult.insertId;

        // Send parent verification email
        const parentToken = generateToken();
        const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
        await connection.query(
          `INSERT INTO email_verifications (user_id, token, email, expires_at) 
           VALUES (?, ?, ?, ?)`,
          [parentId, parentToken, parentEmail, expiresAt]
        );

        await sendEmail({
          to: parentEmail,
          subject: 'Overte účet rodiča',
          html: `
            <h1>Váš syn/dcéra sa registruje do Sports Club</h1>
            <p>Overte váš email a dajte súhlas:</p>
            <a href="${process.env.FRONTEND_URL}/verify-parent?token=${parentToken}">Overiť a dať súhlas</a>
          `
        });
      }
    }

    // Create player
    const passwordHash = await bcrypt.hash(password, 10);
    const [playerResult] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, date_of_birth, parent_id, is_active, is_verified, coppa_consent_given) 
       VALUES (?, ?, ?, ?, 'player', ?, ?, TRUE, ?, ?)`,
      [email, passwordHash, firstName, lastName, dateOfBirth, parentId, !requiresParent, !requiresParent]
    );

    const playerId = playerResult.insertId;

    // Create parent-child link if parent exists
    if (parentId) {
      await connection.query(
        `INSERT INTO parent_child_links (parent_id, child_id, relationship_type, is_primary, can_manage, can_view) 
         VALUES (?, ?, 'parent', TRUE, TRUE, TRUE)`,
        [parentId, playerId]
      );
    }

    // Handle invite if provided
    let clubId = null;
    if (inviteCode) {
      const [invites] = await connection.query(
        `SELECT * FROM invites 
         WHERE invite_code = ? AND invite_type = 'player' AND status = 'pending' AND expires_at > NOW()`,
        [inviteCode]
      );

      if (invites.length > 0) {
        const invite = invites[0];
        clubId = invite.club_id;

        // Add to club_members
        await connection.query(
          `INSERT INTO club_members (club_id, user_id, member_role, added_by) 
           VALUES (?, ?, 'player', ?)`,
          [clubId, playerId, invite.invited_by]
        );

        // Add to team if specified
        if (invite.team_id) {
          await connection.query(
            `INSERT INTO team_memberships (team_id, user_id, position, is_active) 
             VALUES (?, ?, ?, TRUE)`,
            [invite.team_id, playerId, position || null]
          );
        }

        // Mark invite as accepted
        await connection.query(
          `UPDATE invites SET status = 'accepted', accepted_at = NOW(), accepted_by = ? WHERE id = ?`,
          [playerId, invite.id]
        );
      }
    }

    // Send player verification email if no parent required
    if (!requiresParent) {
      const verificationToken = generateToken();
      const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
      await connection.query(
        `INSERT INTO email_verifications (user_id, token, email, expires_at) 
         VALUES (?, ?, ?, ?)`,
        [playerId, verificationToken, email, expiresAt]
      );

      await sendEmail({
        to: email,
        subject: 'Overte svoj email',
        html: `
          <h1>Vitajte v Sports Club!</h1>
          <p>Kliknite na odkaz pre overenie emailu:</p>
          <a href="${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}">Overiť email</a>
        `
      });
    }

    await connection.commit();

    res.status(201).json({
      message: requiresParent 
        ? 'Hráč registrován. Rodič musí potvrdit email a dát souhlas.'
        : 'Hráč registrován. Zkontrolujte email.',
      user: {
        id: playerId,
        email,
        firstName,
        lastName,
        role: 'player',
        requiresParentConsent: requiresParent,
        clubId
      }
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// 6. REGISTRACE RODIČA
// ============================================

router.post('/register-parent', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, firstName, lastName, phone } = req.body;

    // Check if email exists
    const [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Email už existuje' });
    }

    // Create parent
    const passwordHash = await bcrypt.hash(password, 10);
    const [parentResult] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, phone, is_active, is_verified) 
       VALUES (?, ?, ?, ?, 'parent', ?, TRUE, FALSE)`,
      [email, passwordHash, firstName, lastName, phone || null]
    );

    const parentId = parentResult.insertId;

    // Create verification token
    const verificationToken = generateToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await connection.query(
      `INSERT INTO email_verifications (user_id, token, email, expires_at) 
       VALUES (?, ?, ?, ?)`,
      [parentId, verificationToken, email, expiresAt]
    );

    // Send verification email
    await sendEmail({
      to: email,
      subject: 'Overte svoj email',
      html: `
        <h1>Vitajte ako rodič!</h1>
        <p>Kliknite na odkaz pre overenie emailu:</p>
        <a href="${process.env.FRONTEND_URL}/verify-email?token=${verificationToken}">Overiť email</a>
      `
    });

    await connection.commit();

    res.status(201).json({
      message: 'Rodič registrován. Zkontrolujte email.',
      user: {
        id: parentId,
        email,
        firstName,
        lastName,
        role: 'parent'
      }
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
