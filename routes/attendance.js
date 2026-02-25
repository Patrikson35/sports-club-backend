const express = require('express');
const router = express.Router();
const db = require('../config/database');

// GET /api/attendance/:trainingId - Get attendance for training
router.get('/:trainingId', async (req, res, next) => {
  try {
    const [attendance] = await db.query(`
      SELECT 
        ar.*,
        p.id as player_id,
        p.jersey_number,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM attendance_records ar
      JOIN players p ON ar.player_id = p.id
      JOIN users u ON p.user_id = u.id
      WHERE ar.training_session_id = ?
      ORDER BY p.jersey_number
    `, [req.params.trainingId]);
    
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
router.post('/', async (req, res, next) => {
  try {
    const { trainingSessionId, playerId, status, minutesPresent, notes, date } = req.body;
    
    // Check if record exists
    const [existing] = await db.query(
      'SELECT id FROM attendance_records WHERE training_session_id = ? AND player_id = ? AND date = ?',
      [trainingSessionId, playerId, date || new Date()]
    );
    
    if (existing.length > 0) {
      // Update existing
      await db.query(
        'UPDATE attendance_records SET status = ?, minutes_present = ?, notes = ? WHERE id = ?',
        [status, minutesPresent || 0, notes, existing[0].id]
      );
      
      res.json({
        id: existing[0].id,
        message: 'Attendance updated successfully'
      });
    } else {
      // Create new
      const [result] = await db.query(
        'INSERT INTO attendance_records (training_session_id, player_id, status, minutes_present, notes, date) VALUES (?, ?, ?, ?, ?, ?)',
        [trainingSessionId, playerId, status, minutesPresent || 0, notes, date || new Date()]
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
router.get('/player/:playerId', async (req, res, next) => {
  try {
    const { limit = 50 } = req.query;
    
    const [attendance] = await db.query(`
      SELECT 
        ar.*,
        ts.name as training_name,
        ts.date as training_date,
        ts.location
      FROM attendance_records ar
      JOIN training_sessions ts ON ar.training_session_id = ts.id
      WHERE ar.player_id = ?
      ORDER BY ar.date DESC
      LIMIT ?
    `, [req.params.playerId, parseInt(limit)]);
    
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
        minutesPresent: a.minutes_present,
        notes: a.notes,
        date: a.date,
        training: {
          id: a.training_session_id,
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
