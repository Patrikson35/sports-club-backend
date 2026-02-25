const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// GET /api/players - Get all players
router.get('/', async (req, res, next) => {
  try {
    const { teamId, search } = req.query;
    
    let query = `
      SELECT 
        p.id,
        p.jersey_number,
        p.position,
        p.is_active,
        u.id as user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.date_of_birth,
        u.avatar_url,
        t.id as team_id,
        t.name as team_name,
        t.age_group
      FROM players p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN teams t ON p.team_id = t.id
      WHERE p.is_active = TRUE
    `;
    
    const params = [];
    
    if (teamId) {
      query += ' AND p.team_id = ?';
      params.push(teamId);
    }
    
    if (search) {
      query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY u.last_name, u.first_name';
    
    const [players] = await db.query(query, params);
    
    res.json({
      total: players.length,
      players: players.map(p => ({
        id: p.id,
        userId: p.user_id,
        firstName: p.first_name,
        lastName: p.last_name,
        name: `${p.first_name} ${p.last_name}`,
        email: p.email,
        dateOfBirth: p.date_of_birth,
        avatar: p.avatar_url,
        jerseyNumber: p.jersey_number,
        position: p.position,
        team: p.team_id ? {
          id: p.team_id,
          name: p.team_name,
          ageGroup: p.age_group
        } : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/players/:id - Get player detail
router.get('/:id', async (req, res, next) => {
  try {
    const [players] = await db.query(`
      SELECT 
        p.*,
        u.first_name,
        u.last_name,
        u.email,
        u.date_of_birth,
        u.phone,
        u.avatar_url,
        t.name as team_name,
        t.age_group
      FROM players p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN teams t ON p.team_id = t.id
      WHERE p.id = ?
    `, [req.params.id]);
    
    if (players.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    const player = players[0];
    
    // Get player stats
    const [matchStats] = await db.query(`
      SELECT 
        COUNT(DISTINCT ml.match_id) as matches_played,
        COUNT(CASE WHEN me.event_type = 'goal' THEN 1 END) as goals,
        COUNT(CASE WHEN me.event_type = 'yellow_card' THEN 1 END) as yellow_cards,
        COUNT(CASE WHEN me.event_type = 'red_card' THEN 1 END) as red_cards
      FROM match_lineups ml
      LEFT JOIN match_events me ON ml.player_id = me.player_id
      WHERE ml.player_id = ?
    `, [req.params.id]);
    
    const [attendance] = await db.query(`
      SELECT 
        COUNT(*) as total_trainings,
        SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as attended
      FROM attendance_records
      WHERE player_id = ?
    `, [req.params.id]);
    
    res.json({
      id: player.id,
      userId: player.user_id,
      firstName: player.first_name,
      lastName: player.last_name,
      name: `${player.first_name} ${player.last_name}`,
      email: player.email,
      phone: player.phone,
      dateOfBirth: player.date_of_birth,
      avatar: player.avatar_url,
      jerseyNumber: player.jersey_number,
      position: player.position,
      team: player.team_id ? {
        id: player.team_id,
        name: player.team_name,
        ageGroup: player.age_group
      } : null,
      stats: {
        matchesPlayed: matchStats[0].matches_played,
        goals: matchStats[0].goals,
        yellowCards: matchStats[0].yellow_cards,
        redCards: matchStats[0].red_cards,
        trainingAttendance: attendance[0].total_trainings > 0 
          ? Math.round((attendance[0].attended / attendance[0].total_trainings) * 100) 
          : 0
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
