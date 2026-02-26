const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { body, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');

// ============================================
// OVERIT EMAIL
// ============================================

router.post('/verify-email', [
  body('token').notEmpty()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token } = req.body;

    // Find verification token
    const [verifications] = await connection.query(
      `SELECT * FROM email_verifications 
       WHERE token = ? AND verified_at IS NULL AND expires_at > NOW()`,
      [token]
    );

    if (verifications.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Neplatný nebo exspirovaný token' });
    }

    const verification = verifications[0];

    // Update user as verified
    await connection.query(
      `UPDATE users SET is_verified = TRUE WHERE id = ?`,
      [verification.user_id]
    );

    // Mark verification as complete
    await connection.query(
      `UPDATE email_verifications SET verified_at = NOW() WHERE id = ?`,
      [verification.id]
    );

    await connection.commit();

    res.json({ message: 'Email úspěšně ověřen' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// OVERIT SOUHLAS RODIČE (COPPA)
// ============================================

router.post('/verify-parent-consent', [
  body('token').notEmpty(),
  body('consentGiven').isBoolean()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { token, consentGiven } = req.body;

    // Find verification token
    const [verifications] = await connection.query(
      `SELECT ev.*, u.role 
       FROM email_verifications ev
       JOIN users u ON ev.user_id = u.id
       WHERE ev.token = ? AND ev.verified_at IS NULL AND ev.expires_at > NOW() AND u.role = 'parent'`,
      [token]
    );

    if (verifications.length === 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Neplatný token' });
    }

    const verification = verifications[0];
    const parentId = verification.user_id;

    // Verify parent email
    await connection.query(
      `UPDATE users SET is_verified = TRUE WHERE id = ?`,
      [parentId]
    );

    await connection.query(
      `UPDATE email_verifications SET verified_at = NOW() WHERE id = ?`,
      [verification.id]
    );

    // Get all children of this parent
    const [children] = await connection.query(
      `SELECT id FROM users WHERE parent_id = ?`,
      [parentId]
    );

    if (consentGiven) {
      // Update all children to verified with COPPA consent
      for (const child of children) {
        await connection.query(
          `UPDATE users SET is_verified = TRUE, coppa_consent_given = TRUE, age_verified_at = NOW() WHERE id = ?`,
          [child.id]
        );

        // Record consent
        await connection.query(
          `INSERT INTO consent_records (user_id, consent_type, given_by, consent_given, consent_version) 
           VALUES (?, 'coppa', ?, TRUE, '1.0')`,
          [child.id, parentId]
        );
      }
    } else {
      // Parent declined - deactivate children accounts
      for (const child of children) {
        await connection.query(
          `UPDATE users SET is_active = FALSE WHERE id = ?`,
          [child.id]
        );
      }
    }

    await connection.commit();

    res.json({
      message: consentGiven 
        ? 'Souhlas udělen. Účet dítěte je aktivní.'
        : 'Souhlas zamítnut. Účet dítěte byl deaktivován.'
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// ZNOVU POSLAT VERIFICATION EMAIL
// ============================================

router.post('/resend-verification', [
  body('email').isEmail().normalizeEmail()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email } = req.body;

    // Find user
    const [users] = await connection.query(
      `SELECT id, first_name FROM users WHERE email = ? AND is_verified = FALSE`,
      [email]
    );

    if (users.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Uživatel nenalezen nebo už je ověřen' });
    }

    const user = users[0];

    // Invalidate old tokens
    await connection.query(
      `UPDATE email_verifications SET expires_at = NOW() WHERE user_id = ? AND verified_at IS NULL`,
      [user.id]
    );

    // Create new token
    const crypto = require('crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    await connection.query(
      `INSERT INTO email_verifications (user_id, token, email, expires_at) 
       VALUES (?, ?, ?, ?)`,
      [user.id, token, email, expiresAt]
    );

    // Send email
    const { sendEmail } = require('../services/email');
    await sendEmail({
      to: email,
      subject: 'Ověření emailu - Sports Club',
      html: `
        <h1>Ahoj ${user.first_name}!</h1>
        <p>Klikni na odkaz pro ověření emailu:</p>
        <a href="${process.env.FRONTEND_URL}/verify-email?token=${token}">Ověřit email</a>
      `
    });

    await connection.commit();

    res.json({ message: 'Verification email znovu odeslán' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
