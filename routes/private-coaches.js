const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { body, validationResult } = require('express-validator');
const { authenticate, requireRole } = require('../middleware/auth');

// ============================================
// PŘIŘADIT HRÁČE K PRIVÁTNÍMU TRENÉROVI
// ============================================

router.post('/:coachId/assign-player', authenticate, [
  body('playerId').isInt()
], async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { coachId } = req.params;
    const { playerId } = req.body;

    // Verify coach is private_coach
    const [coaches] = await connection.query(
      `SELECT id FROM users WHERE id = ? AND role = 'private_coach' AND is_active = TRUE`,
      [coachId]
    );

    if (coaches.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Privátní trenér nenalezen' });
    }

    // Verify player exists
    const [players] = await connection.query(
      `SELECT id, parent_id FROM users WHERE id = ? AND role = 'player' AND is_active = TRUE`,
      [playerId]
    );

    if (players.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Hráč nenalezen' });
    }

    const player = players[0];

    // Check authorization:
    // - If player is underage (has parent_id), must be parent or player
    // - If player is adult, must be player
    // - OR if caller is private_coach and player sent request

    const isParent = player.parent_id && player.parent_id === req.user.id;
    const isPlayer = playerId === req.user.id;
    const isCoach = coachId === req.user.id;

    if (!isParent && !isPlayer && !isCoach) {
      await connection.rollback();
      return res.status(403).json({ error: 'Nemáte oprávnění přiřadit tohoto hráče' });
    }

    // Check if relationship already exists
    const [existing] = await connection.query(
      `SELECT id FROM private_coach_players 
       WHERE coach_id = ? AND player_id = ? AND is_active = TRUE`,
      [coachId, playerId]
    );

    if (existing.length > 0) {
      await connection.rollback();
      return res.status(400).json({ error: 'Hráč už je přiřazen k tomuto trenérovi' });
    }

    // Create relationship
    await connection.query(
      `INSERT INTO private_coach_players (coach_id, player_id, assigned_by, is_active) 
       VALUES (?, ?, ?, TRUE)`,
      [coachId, playerId, req.user.id]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Hráč přiřazen k privátnímu trenérovi',
      relationship: {
        coachId,
        playerId
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
// ODEBRAT HRÁČE OD PRIVÁTNÍHO TRENÉRA
// ============================================

router.delete('/:coachId/remove-player/:playerId', authenticate, async (req, res, next) => {
  const connection = await db.getConnection();
  
  try {
    await connection.beginTransaction();
    
    const { coachId, playerId } = req.params;

    // Verify relationship exists
    const [relationships] = await connection.query(
      `SELECT pcp.*, u.parent_id 
       FROM private_coach_players pcp
       JOIN users u ON pcp.player_id = u.id
       WHERE pcp.coach_id = ? AND pcp.player_id = ? AND pcp.is_active = TRUE`,
      [coachId, playerId]
    );

    if (relationships.length === 0) {
      await connection.rollback();
      return res.status(404).json({ error: 'Vztah nenalezen' });
    }

    const relationship = relationships[0];

    // Check authorization
    const isParent = relationship.parent_id && relationship.parent_id === req.user.id;
    const isPlayer = parseInt(playerId) === req.user.id;
    const isCoach = parseInt(coachId) === req.user.id;

    if (!isParent && !isPlayer && !isCoach) {
      await connection.rollback();
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    // Deactivate relationship
    await connection.query(
      `UPDATE private_coach_players SET is_active = FALSE WHERE coach_id = ? AND player_id = ?`,
      [coachId, playerId]
    );

    await connection.commit();

    res.json({ message: 'Hráč odebrán od privátního trenéra' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// ============================================
// ZÍSKAT HRÁČE PRIVÁTNÍHO TRENÉRA
// ============================================

router.get('/:coachId/players', authenticate, async (req, res, next) => {
  try {
    const { coachId } = req.params;

    // Verify access
    if (parseInt(coachId) !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    // Get players
    const [players] = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.date_of_birth, u.avatar_url,
              pcp.assigned_at, pcp.notes,
              parent.first_name as parent_first_name, parent.last_name as parent_last_name,
              parent.email as parent_email
       FROM private_coach_players pcp
       JOIN users u ON pcp.player_id = u.id
       LEFT JOIN users parent ON u.parent_id = parent.id
       WHERE pcp.coach_id = ? AND pcp.is_active = TRUE
       ORDER BY u.last_name, u.first_name`,
      [coachId]
    );

    res.json({
      total: players.length,
      players: players.map(p => ({
        id: p.id,
        firstName: p.first_name,
        lastName: p.last_name,
        email: p.email,
        dateOfBirth: p.date_of_birth,
        avatarUrl: p.avatar_url,
        assignedAt: p.assigned_at,
        notes: p.notes,
        parent: p.parent_email ? {
          firstName: p.parent_first_name,
          lastName: p.parent_last_name,
          email: p.parent_email
        } : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// ZÍSKAT TRENÉRY HRÁČE
// ============================================

router.get('/player/:playerId/coaches', authenticate, async (req, res, next) => {
  try {
    const { playerId } = req.params;

    // Verify access - player himself, parent, or admin
    const [players] = await db.query(
      'SELECT parent_id FROM users WHERE id = ?',
      [playerId]
    );

    if (players.length === 0) {
      return res.status(404).json({ error: 'Hráč nenalezen' });
    }

    const player = players[0];
    const isPlayer = parseInt(playerId) === req.user.id;
    const isParent = player.parent_id && player.parent_id === req.user.id;

    if (!isPlayer && !isParent && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    // Get coaches
    const [coaches] = await db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.avatar_url,
              pcp.assigned_at, pcp.notes
       FROM private_coach_players pcp
       JOIN users u ON pcp.coach_id = u.id
       WHERE pcp.player_id = ? AND pcp.is_active = TRUE
       ORDER BY pcp.assigned_at DESC`,
      [playerId]
    );

    res.json({
      total: coaches.length,
      coaches: coaches.map(c => ({
        id: c.id,
        firstName: c.first_name,
        lastName: c.last_name,
        email: c.email,
        phone: c.phone,
        avatarUrl: c.avatar_url,
        assignedAt: c.assigned_at,
        notes: c.notes
      }))
    });
  } catch (error) {
    next(error);
  }
});

// ============================================
// AKTUALIZOVAT POZNÁMKY K HRÁČI
// ============================================

router.patch('/:coachId/player/:playerId/notes', authenticate, requireRole(['private_coach']), [
  body('notes').optional()
], async (req, res, next) => {
  try {
    const { coachId, playerId } = req.params;
    const { notes } = req.body;

    // Verify ownership
    if (parseInt(coachId) !== req.user.id) {
      return res.status(403).json({ error: 'Nemáte oprávnění' });
    }

    // Update notes
    await db.query(
      `UPDATE private_coach_players SET notes = ? WHERE coach_id = ? AND player_id = ? AND is_active = TRUE`,
      [notes || null, coachId, playerId]
    );

    res.json({ message: 'Poznámky aktualizovány' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
