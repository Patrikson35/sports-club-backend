const express = require('express');
const router = express.Router();
const db = require('../config/database');

// GET /api/trainings - Get all training sessions
router.get('/', async (req, res, next) => {
  try {
    const { teamId, status, limit = 50 } = req.query;
    
    let query = `
      SELECT 
        ts.id,
        ts.team_id,
        ts.name,
        ts.date,
        ts.start_time,
        ts.end_time,
        ts.location,
        ts.status,
        ts.notes,
        t.name as team_name,
        t.age_group,
        u.first_name as coach_first_name,
        u.last_name as coach_last_name,
        COUNT(DISTINCT te.id) as exercise_count,
        COUNT(DISTINCT ar.id) as attendance_count
      FROM training_sessions ts
      LEFT JOIN teams t ON ts.team_id = t.id
      LEFT JOIN coaches c ON t.id = c.team_id
      LEFT JOIN users u ON c.user_id = u.id
      LEFT JOIN training_exercises te ON ts.id = te.training_session_id
      LEFT JOIN attendance_records ar ON ts.id = ar.training_session_id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (teamId) {
      query += ' AND ts.team_id = ?';
      params.push(teamId);
    }
    
    if (status) {
      query += ' AND ts.status = ?';
      params.push(status);
    }
    
    query += ' GROUP BY ts.id ORDER BY ts.date DESC, ts.start_time DESC LIMIT ?';
    params.push(parseInt(limit));
    
    const [trainings] = await db.query(query, params);
    
    res.json({
      total: trainings.length,
      trainings: trainings.map(tr => ({
        id: tr.id,
        name: tr.name,
        date: tr.date,
        startTime: tr.start_time,
        endTime: tr.end_time,
        location: tr.location,
        status: tr.status,
        notes: tr.notes,
        team: {
          id: tr.team_id,
          name: tr.team_name,
          ageGroup: tr.age_group
        },
        coach: tr.coach_first_name ? {
          firstName: tr.coach_first_name,
          lastName: tr.coach_last_name,
          name: `${tr.coach_first_name} ${tr.coach_last_name}`
        } : null,
        exerciseCount: tr.exercise_count,
        attendanceCount: tr.attendance_count
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/trainings/:id - Get training detail
router.get('/:id', async (req, res, next) => {
  try {
    const [trainings] = await db.query(`
      SELECT 
        ts.*,
        t.name as team_name,
        t.age_group,
        u.first_name as coach_first_name,
        u.last_name as coach_last_name
      FROM training_sessions ts
      LEFT JOIN teams t ON ts.team_id = t.id
      LEFT JOIN coaches c ON t.id = c.team_id
      LEFT JOIN users u ON c.user_id = u.id
      WHERE ts.id = ?
    `, [req.params.id]);
    
    if (trainings.length === 0) {
      return res.status(404).json({ error: 'Training not found' });
    }
    
    const training = trainings[0];
    
    // Get exercises
    const [exercises] = await db.query(`
      SELECT 
        te.id,
        te.sequence_order,
        te.duration_minutes,
        te.notes,
        e.name,
        e.description,
        e.difficulty_level,
        ec.name as category_name
      FROM training_exercises te
      JOIN exercises e ON te.exercise_id = e.id
      LEFT JOIN exercise_categories ec ON e.category_id = ec.id
      WHERE te.training_session_id = ?
      ORDER BY te.sequence_order
    `, [req.params.id]);
    
    // Get attendance
    const [attendance] = await db.query(`
      SELECT 
        ar.id,
        ar.status,
        ar.minutes_present,
        ar.notes,
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
    `, [req.params.id]);
    
    res.json({
      id: training.id,
      name: training.name,
      date: training.date,
      startTime: training.start_time,
      endTime: training.end_time,
      location: training.location,
      status: training.status,
      notes: training.notes,
      team: {
        id: training.team_id,
        name: training.team_name,
        ageGroup: training.age_group
      },
      coach: training.coach_first_name ? {
        firstName: training.coach_first_name,
        lastName: training.coach_last_name,
        name: `${training.coach_first_name} ${training.coach_last_name}`
      } : null,
      exercises: exercises.map(ex => ({
        id: ex.id,
        name: ex.name,
        description: ex.description,
        category: ex.category_name,
        difficulty: ex.difficulty_level,
        duration: ex.duration_minutes,
        order: ex.sequence_order,
        notes: ex.notes
      })),
      attendance: attendance.map(att => ({
        id: att.id,
        status: att.status,
        minutesPresent: att.minutes_present,
        notes: att.notes,
        player: {
          id: att.player_id,
          jerseyNumber: att.jersey_number,
          firstName: att.first_name,
          lastName: att.last_name,
          name: `${att.first_name} ${att.last_name}`,
          avatar: att.avatar_url
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/trainings - Create training session
router.post('/', async (req, res, next) => {
  try {
    const { 
      teamId, 
      name, 
      date, 
      startTime, 
      endTime, 
      location, 
      notes, 
      exercises = [] 
    } = req.body;
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      
      // Insert training session
      const [result] = await connection.query(`
        INSERT INTO training_sessions 
        (team_id, name, date, start_time, end_time, location, notes, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled')
      `, [teamId, name, date, startTime, endTime, location, notes]);
      
      const trainingId = result.insertId;
      
      // Insert exercises
      if (exercises.length > 0) {
        for (let i = 0; i < exercises.length; i++) {
          const ex = exercises[i];
          await connection.query(`
            INSERT INTO training_exercises 
            (training_session_id, exercise_id, sequence_order, duration_minutes, notes)
            VALUES (?, ?, ?, ?, ?)
          `, [trainingId, ex.exerciseId, i + 1, ex.duration, ex.notes || null]);
        }
      }
      
      await connection.commit();
      
      res.status(201).json({
        id: trainingId,
        message: 'Training session created successfully'
      });
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  } catch (error) {
    next(error);
  }
});

// GET /api/trainings/:id/exercises - Get training exercises
router.get('/:id/exercises', async (req, res, next) => {
  try {
    const [exercises] = await db.query(`
      SELECT 
        te.id,
        te.sequence_order,
        te.duration_minutes,
        te.notes,
        e.id as exercise_id,
        e.name,
        e.description,
        e.difficulty_level,
        e.required_equipment,
        ec.name as category_name
      FROM training_exercises te
      JOIN exercises e ON te.exercise_id = e.id
      LEFT JOIN exercise_categories ec ON e.category_id = ec.id
      WHERE te.training_session_id = ?
      ORDER BY te.sequence_order
    `, [req.params.id]);
    
    res.json({
      total: exercises.length,
      exercises: exercises.map(ex => ({
        id: ex.id,
        exerciseId: ex.exercise_id,
        name: ex.name,
        description: ex.description,
        category: ex.category_name,
        difficulty: ex.difficulty_level,
        equipment: ex.required_equipment,
        duration: ex.duration_minutes,
        order: ex.sequence_order,
        notes: ex.notes
      }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
