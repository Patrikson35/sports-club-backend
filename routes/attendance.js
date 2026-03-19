const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const getParentScopedChildUserIds = async (connection, parentUserId) => {
  const childIds = new Set();

  try {
    const [rows] = await connection.query(
      'SELECT id FROM users WHERE parent_id = ?',
      [parentUserId]
    );
    rows.forEach((row) => childIds.add(row.id));
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      throw error;
    }
  }

  try {
    const [rows] = await connection.query(
      'SELECT child_id AS child_user_id FROM parent_child_links WHERE parent_id = ?',
      [parentUserId]
    );
    rows.forEach((row) => childIds.add(row.child_user_id));
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR' && error?.code !== 'ER_NO_SUCH_TABLE') {
      throw error;
    }
  }

  return [...childIds];
};

// GET /api/attendance/:trainingId - Get attendance for training
router.get('/:trainingId', authenticateToken, async (req, res, next) => {
  try {
    const role = req.user?.role;
    let query = `
      SELECT 
        ar.*,
        u.id as player_id,
        p.jersey_number,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM attendance ar
      JOIN users u ON ar.user_id = u.id
      LEFT JOIN team_memberships p ON ar.user_id = p.user_id
      WHERE ar.training_id = ?
    `;

    const params = [req.params.trainingId];

    if (role === 'player') {
      query += ' AND ar.user_id = ?';
      params.push(req.user.id);
    }

    if (role === 'parent') {
      const childUserIds = await getParentScopedChildUserIds(db, req.user.id);
      if (!childUserIds.length) {
        return res.json({ total: 0, attendance: [] });
      }
      query += ` AND ar.user_id IN (${childUserIds.map(() => '?').join(',')})`;
      params.push(...childUserIds);
    }

    query += ' ORDER BY p.jersey_number';

    const [attendance] = await db.query(query, params);
    
    res.json({
      total: attendance.length,
      attendance: attendance.map(a => ({
        id: a.id,
        status: a.status,
        minutesPresent: a.minutes_present,
        notes: a.notes,
        date: a.date,
        player: {
          id: a.player_id,
          jerseyNumber: a.jersey_number,
          firstName: a.first_name,
          lastName: a.last_name,
          name: `${a.first_name} ${a.last_name}`,
          avatar: a.avatar_url
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/attendance - Record attendance
router.post('/', authenticateToken, requireRole(['club', 'coach']), async (req, res, next) => {
  try {
    const { trainingSessionId, playerId, status, minutesPresent, notes, date } = req.body;
    
    // Check if record exists
    const [existing] = await db.query(
      'SELECT id FROM attendance WHERE training_id = ? AND user_id = ?',
      [trainingSessionId, playerId]
    );
    
    if (existing.length > 0) {
      // Update existing
      await db.query(
        'UPDATE attendance SET status = ?, minutes_participated = ?, notes = ? WHERE id = ?',
        [status, minutesPresent || 0, notes, existing[0].id]
      );
      
      res.json({
        id: existing[0].id,
        message: 'Attendance updated successfully'
      });
    } else {
      // Create new
      const [result] = await db.query(
        'INSERT INTO attendance (training_id, user_id, status, minutes_participated, notes) VALUES (?, ?, ?, ?, ?)',
        [trainingSessionId, playerId, status, minutesPresent || 0, notes]
      );
      
      res.status(201).json({
        id: result.insertId,
        message: 'Attendance recorded successfully'
      });
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/attendance/player/:playerId - Get player attendance history
router.get('/player/:playerId', authenticateToken, async (req, res, next) => {
  try {
    const requestedPlayerId = Number(req.params.playerId);
    const role = req.user?.role;

    if (role === 'player' && requestedPlayerId !== req.user.id) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto hráčovi' });
    }

    if (role === 'parent') {
      const childUserIds = await getParentScopedChildUserIds(db, req.user.id);
      if (!childUserIds.includes(requestedPlayerId)) {
        return res.status(403).json({ error: 'Nemáte prístup k tomuto hráčovi' });
      }
    }

    const { limit = 50 } = req.query;
    
    const [attendance] = await db.query(`
      SELECT 
        ar.*,
        ts.title as training_name,
        ts.date as training_date,
        ts.location
      FROM attendance ar
      JOIN training_sessions ts ON ar.training_id = ts.id
      WHERE ar.user_id = ?
      ORDER BY ts.date DESC
      LIMIT ?
    `, [requestedPlayerId, parseInt(limit)]);
    
    // Calculate stats
    const total = attendance.length;
    const present = attendance.filter(a => a.status === 'present').length;
    const absent = attendance.filter(a => a.status === 'absent').length;
    const late = attendance.filter(a => a.status === 'late').length;
    const excused = attendance.filter(a => a.status === 'excused').length;
    
    res.json({
      total,
      stats: {
        present,
        absent,
        late,
        excused,
        attendanceRate: total > 0 ? Math.round((present / total) * 100) : 0
      },
      records: attendance.map(a => ({
        id: a.id,
        status: a.status,
        minutesPresent: a.minutes_participated,
        notes: a.notes,
        date: a.recorded_at,
        training: {
          id: a.training_id,
          name: a.training_name,
          date: a.training_date,
          location: a.location
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
