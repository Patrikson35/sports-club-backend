const express = require('express');
const router = express.Router();
const db = require('../config/database');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { sendEmail } = require('../services/email');
const { authenticate, requireRole } = require('../middleware/auth');

// Helper: Generate invite code
const generateInviteCode = () => crypto.randomBytes(32).toString('hex');

// ============================================
// VYTVOŘIT POZVÁNKU
// ============================================

router.post('/send', authenticate, [
  body('email').isEmail().normalizeEmail(),
  body('inviteType').isIn(['coach', 'assistant', 'player', 'parent']),
  body('clubId').optional().isInt(),
  body('teamId').optional().isInt()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, inviteType, clubId, teamId, playerId, metadata = {} } = req.body;
    const invitedBy = req.user.id;

    // Validate permissions based on invite type
    if (inviteType === 'coach' && req.user.role !== 'club_admin') {
      await connection.rollback();
      return res.status(403).json({ error: 'Pouze club_admin může zvát trenéry' });
    }

    if (inviteType === 'assistant' && !['club_admin', 'coach'].includes(req.user.role)) {
      await connection.rollback();
      return res.status(403).json({ error: 'Pouze club_admin nebo coach může zvát asistenty' });
    }

    // Check if email already exists
    const [existingUsers] = await connection.query('SELECT id FROM users WHERE email = ?', [email]);
    if (existingUsers.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Tento email už je registrovaný' });
    }

    // Check for existing pending invite
    const [existingInvites] = await connection.query(
      `SELECT id FROM invites 
       WHERE email = ? AND status = 'pending' AND expires_at > NOW()`,
      [email]
    );

    if (existingInvites.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Pozvánka pro tento email již existuje' });
    }

    // Create invite
    const inviteCode = generateInviteCode();
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

    const [inviteResult] = await connection.query(
      `INSERT INTO invites (invite_code, invite_type, email, invited_by, club_id, team_id, player_id, metadata, expires_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        inviteCode,
        inviteType,
        email,
        invitedBy,
        clubId || null,
        teamId || null,
        playerId || null,
        JSON.stringify(metadata),
        expiresAt
      ]
    );

    // Get club and inviter info for email
    let clubName = '';
    if (clubId) {
      const [clubs] = await connection.query('SELECT name FROM clubs WHERE id = ?', [clubId]);
      clubName = clubs[0]?.name || '';
    }

    const [inviters] = await connection.query(
      'SELECT first_name, last_name FROM users WHERE id = ?',
      [invitedBy]
    );
    const inviterName = `${inviters[0].first_name} ${inviters[0].last_name}`;

    // Send invite email
    const inviteTypeLabels = {
      coach: 'trenér',
      assistant: 'asistent',
      player: 'hráč',
      parent: 'rodič'
    };

    await sendEmail({
      to: email,
      subject: `Pozvánka do Sports Club - ${inviteTypeLabels[inviteType]}`,
      html: `
        <h1>Boli ste pozvaný do Sports Club!</h1>
        <p>${inviterName} vás pozval ako <strong>${inviteTypeLabels[inviteType]}</strong>${clubName ? ` do klubu ${clubName}` : ''}.</p>
        <p>Pre dokončení registrácie kliknite na odkaz:</p>
        <a href="${process.env.FRONTEND_URL}/register?invite=${inviteCode}">Dokončiť registráciu</a>
        <p><small>Platnosť do: ${expiresAt.toLocaleDateString('sk-SK')}</small></p>
      `
    });

    await connection.commit();

    res.status(201).json({
      message: 'Pozvánka odeslána',
      invite: {
        id: inviteResult.insertId,
        inviteCode,
        email,
        inviteType,
        expiresAt
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
// ZÍSKAT DETAIL POZVÁNKY
// ============================================

router.get('/:inviteCode', async (req, res, next) => {
  try {
    const { inviteCode } = req.params;

    const [invites] = await db.query(
      `SELECT i.*, c.name as club_name, t.name as team_name,
              u.first_name as inviter_first_name, u.last_name as inviter_last_name
       FROM invites i
       LEFT JOIN clubs c ON i.club_id = c.id
       LEFT JOIN teams t ON i.team_id = t.id
       LEFT JOIN users u ON i.invited_by = u.id
       WHERE i.invite_code = ?`,
      [inviteCode]
    );

    if (invites.length === 0) {
      return res.status(404).json({ error: 'Pozvánka nenalezena' });
    }

    const invite = invites[0];

    // Check if expired
    if (new Date(invite.expires_at) < new Date()) {
      return res.status(400).json({ error: 'Pozvánka vypršela' });
    }

    // Check if already accepted
    if (invite.status !== 'pending') {
      return res.status(400).json({ error: 'Pozvánka už byla použita' });
    }

    res.json({
      invite: {
        inviteCode: invite.invite_code,
        inviteType: invite.invite_type,
        email: invite.email,
        clubName: invite.club_name,
        teamName: invite.team_name,
        inviterName: `${invite.inviter_first_name} ${invite.inviter_last_name}`,
        expiresAt: invite.expires_at
      }
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// ZRUŠIT POZVÁNKU
// ============================================

router.delete('/:inviteId', authenticate, async (req, res, next) => {
  try {
    const { inviteId } = req.params;

    // Verify ownership
    const [invites] = await db.query(
      'SELECT invited_by FROM invites WHERE id = ?',
      [inviteId]
    );

    if (invites.length === 0) {
      return res.status(404).json({ error: 'Pozvánka nenalezena' });
    }

    if (invites[0].invited_by !== req.user.id && req.user.role !== 'club_admin') {
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    // Update status to expired
    await db.query(
      `UPDATE invites SET status = 'expired' WHERE id = ?`,
      [inviteId]
    );

    res.json({ message: 'Pozvánka zrušena' });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SEZNAM POZVÁNEK (pro klub)
// ============================================

router.get('/club/:clubId', authenticate, async (req, res, next) => {
  try {
    const { clubId } = req.params;

    // Verify access to club
    const [members] = await db.query(
      'SELECT id FROM club_members WHERE club_id = ? AND user_id = ? AND is_active = TRUE',
      [clubId, req.user.id]
    );

    if (members.length === 0 && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto klubu' });
    }

    // Get invites
    const [invites] = await db.query(
      `SELECT i.*, 
              u.first_name as inviter_first_name, 
              u.last_name as inviter_last_name
       FROM invites i
       LEFT JOIN users u ON i.invited_by = u.id
       WHERE i.club_id = ?
       ORDER BY i.created_at DESC`,
      [clubId]
    );

    res.json({
      total: invites.length,
      invites: invites.map(inv => ({
        id: inv.id,
        inviteCode: inv.invite_code,
        email: inv.email,
        inviteType: inv.invite_type,
        status: inv.status,
        inviterName: `${inv.inviter_first_name} ${inv.inviter_last_name}`,
        createdAt: inv.created_at,
        expiresAt: inv.expires_at
      }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
