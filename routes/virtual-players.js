const express = require('express');
const router = express.Router();
const db = require('../config/database');
const crypto = require('crypto');
const { body, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');
const { sendEmail } = require('../services/email');

// ============================================
// VYTVOŘIT VIRTUÁLNÍHO HRÁČE
// ============================================

router.post('/create-virtual', authenticate, requireRole(['club_admin', 'coach']), [
  body('firstName').notEmpty().trim(),
  body('lastName').notEmpty().trim(),
  body('teamId').isInt(),
  body('dateOfBirth').optional().isISO8601().toDate(),
  body('position').optional(),
  body('jerseyNumber').optional().isInt()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const {
      firstName,
      lastName,
      dateOfBirth,
      position,
      jerseyNumber,
      teamId,
      height,
      weight,
      preferredFoot
    } = req.body;

    // Verify team access
    const [teams] = await connection.query(
      `SELECT t.club_id FROM teams t
       JOIN club_members cm ON t.club_id = cm.club_id
       WHERE t.id = ? AND cm.user_id = ? AND cm.is_active = TRUE`,
      [teamId, req.user.id]
    );

    if (teams.length === 0) {
      await connection.rollback();
      return res.status(403).json({ error: 'Nemáte přístup k tomuto týmu' });
    }

    const clubId = teams[0].club_id;

    // Generate unique virtual email
    const virtualEmail = `virtual_${crypto.randomBytes(8).toString('hex')}@sportsclub.local`;

    // Create virtual player
    const [playerResult] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, date_of_birth, is_virtual, is_active, is_verified) 
       VALUES (?, '', ?, ?, 'player', ?, TRUE, FALSE, FALSE)`,
      [virtualEmail, firstName, lastName, dateOfBirth || null]
    );

    const playerId = playerResult.insertId;

    // Add to club_members
    await connection.query(
      `INSERT INTO club_members (club_id, user_id, member_role, added_by) 
       VALUES (?, ?, 'player', ?)`,
      [clubId, playerId, req.user.id]
    );

    // Add to team
    await connection.query(
      `INSERT INTO team_memberships (team_id, user_id, jersey_number, position, is_active) 
       VALUES (?, ?, ?, ?, TRUE)`,
      [teamId, playerId, jerseyNumber || null, position || null]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Virtuální hráč vytvořen',
      player: {
        id: playerId,
        firstName,
        lastName,
        isVirtual: true,
        teamId
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
// CONVERT VIRTUAL → REAL PLAYER
// ============================================

router.post('/:playerId/convert-to-real', authenticate, requireRole(['club_admin', 'coach']), [
  body('parentEmail').isEmail().normalizeEmail(),
  body('parentFirstName').notEmpty().trim(),
  body('parentLastName').notEmpty().trim()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { playerId } = req.params;
    const { parentEmail, parentFirstName, parentLastName, playerEmail } = req.body;

    // Verify player is virtual
    const [players] = await connection.query(
      `SELECT u.*, cm.club_id 
       FROM users u
       JOIN club_members cm ON u.id = cm.user_id
       WHERE u.id = ? AND u.is_virtual = TRUE AND u.role = 'player'`,
      [playerId]
    );

    if (players.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Virtuální hráč nenalezen' });
    }

    const player = players[0];
    const clubId = player.club_id;

    // Check if parent email already exists
    const [existingParents] = await connection.query(
      'SELECT id FROM users WHERE email = ?',
      [parentEmail]
    );

    let parentId;

    if (existingParents.length > 0) {
      parentId = existingParents[0].id;
    } else {
      // Create parent account
      const parentPasswordHash = require('bcrypt').hashSync(crypto.randomBytes(16).toString('hex'), 10);
      const [parentResult] = await connection.query(
        `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, is_verified) 
         VALUES (?, ?, ?, ?, 'parent', TRUE, FALSE)`,
        [parentEmail, parentPasswordHash, parentFirstName, parentLastName]
      );
      parentId = parentResult.insertId;
    }

    // Update player - assign parent, update email if provided
    const updateFields = ['parent_id = ?', 'is_virtual = FALSE'];
    const updateValues = [parentId];

    if (playerEmail) {
      // Check if player email already exists
      const [existingPlayers] = await connection.query(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [playerEmail, playerId]
      );

      if (existingPlayers.length > 0) {
        await connection.rollback();
        return res.status(400).json({ error: 'Email hráče již existuje' });
      }

      updateFields.push('email = ?');
      updateValues.push(playerEmail);
    }

    updateValues.push(playerId);

    await connection.query(
      `UPDATE users SET ${updateFields.join(', ')} WHERE id = ?`,
      updateValues
    );

    // Create parent-child link
    await connection.query(
      `INSERT INTO parent_child_links (parent_id, child_id, relationship_type, is_primary) 
       VALUES (?, ?, 'parent', TRUE)
       ON DUPLICATE KEY UPDATE is_primary = TRUE`,
      [parentId, playerId]
    );

    // Create invite for parent to complete registration
    const inviteCode = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000); // 14 days

    await connection.query(
      `INSERT INTO invites (invite_code, invite_type, email, invited_by, club_id, player_id, metadata, expires_at) 
       VALUES (?, 'parent', ?, ?, ?, ?, ?, ?)`,
      [
        inviteCode,
        parentEmail,
        req.user.id,
        clubId,
        playerId,
        JSON.stringify({ playerFirstName: player.first_name, playerLastName: player.last_name }),
        expiresAt
      ]
    );

    // Send email to parent
    await sendEmail({
      to: parentEmail,
      subject: 'Dokončete registráciu vášho dieťaťa - Sports Club',
      html: `
        <h1>Ahoj ${parentFirstName}!</h1>
        <p>Vaše dieťa <strong>${player.first_name} ${player.last_name}</strong> bolo pridané do športového klubu.</p>
        <p>Pre dokončenie registrácie a aktiváciu účtu kliknite na odkaz:</p>
        <a href="${process.env.FRONTEND_URL}/complete-parent-registration?invite=${inviteCode}">Dokončiť registráciu</a>
        <p><small>Budete musieť overiť email a dať súhlas s podmienkami.</small></p>
      `
    });

    await connection.commit();

    res.json({
      message: 'Virtuální hráč konvertován. Email odeslán rodiči.',
      player: {
        id: playerId,
        firstName: player.first_name,
        lastName: player.last_name,
        isVirtual: false,
        parentEmail
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
// ZÍSKAT VIRTUÁLNÍ HRÁČE TÝMU
// ============================================

router.get('/team/:teamId/virtual-players', authenticate, async (req, res, next) => {
  try {
    const { teamId } = req.params;

    // Verify access to team
    const [access] = await db.query(
      `SELECT t.club_id FROM teams t
       JOIN club_members cm ON t.club_id = cm.club_id
       WHERE t.id = ? AND cm.user_id = ? AND cm.is_active = TRUE`,
      [teamId, req.user.id]
    );

    if (access.length === 0) {
      return res.status(403).json({ error: 'Nemáte přístup k tomuto týmu' });
    }

    // Get virtual players
    const [players] = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.date_of_birth,
              tm.jersey_number, tm.position, tm.joined_date
       FROM users u
       JOIN team_memberships tm ON u.id = tm.user_id
       WHERE tm.team_id = ? AND u.is_virtual = TRUE AND tm.is_active = TRUE
       ORDER BY u.last_name, u.first_name`,
      [teamId]
    );

    res.json({
      total: players.length,
      players: players.map(p => ({
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        dateOfBirth: p.date_of_birth,
        jerseyNumber: p.jersey_number,
        position: p.position,
        joinedDate: p.joined_date,
        isVirtual: true
      }))
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// SMAZAT VIRTUÁLNÍHO HRÁČE
// ============================================

router.delete('/:playerId', authenticate, requireRole(['club_admin', 'coach']), async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { playerId } = req.params;

    // Verify player is virtual and user has access
    const [players] = await connection.query(
      `SELECT u.id, cm.club_id 
       FROM users u
       JOIN club_members cm ON u.id = cm.user_id
       WHERE u.id = ? AND u.is_virtual = TRUE`,
      [playerId]
    );

    if (players.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Virtuální hráč nenalezen' });
    }

    // Verify user has access to club
    const [userAccess] = await connection.query(
      `SELECT id FROM club_members 
       WHERE club_id = ? AND user_id = ? AND is_active = TRUE`,
      [players[0].club_id, req.user.id]
    );

    if (userAccess.length === 0 && req.user.role !== 'admin') {
      await connection.rollback();
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    // Delete player (cascade will handle related records)
    await connection.query('DELETE FROM users WHERE id = ?', [playerId]);

    await connection.commit();

    res.json({ message: 'Virtuální hráč smazán' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
