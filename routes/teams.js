const express = require('express');
const router = express.Router();
const db = require('../config/database');

// GET /api/teams - Get all teams
router.get('/', async (req, res, next) => {
  try {
    const [teams] = await db.query(`
      SELECT 
        t.*,
        c.name as club_name,
        COUNT(DISTINCT p.id) as player_count
      FROM teams t
      LEFT JOIN clubs c ON t.club_id = c.id
      LEFT JOIN team_memberships p ON t.id = p.team_id AND p.is_active = TRUE
      GROUP BY t.id
      ORDER BY t.age_group
    `);
    
    res.json({
      total: teams.length,
      teams: teams.map(t => ({
        id: t.id,
        name: t.name,
        ageGroup: t.age_group,
        season: t.season,
        playerCount: t.player_count,
        club: {
          id: t.club_id,
          name: t.club_name
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/teams/:id - Get team detail
router.get('/:id', async (req, res, next) => {
  try {
    const [teams] = await db.query(`
      SELECT t.*, c.name as club_name
      FROM teams t
      LEFT JOIN clubs c ON t.club_id = c.id
      WHERE t.id = ?
    `, [req.params.id]);
    
    if (teams.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const team = teams[0];
    
    // Get players
    const [players] = await db.query(`
      SELECT 
        p.id,
        p.jersey_number,
        p.position,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM team_memberships p
      JOIN users u ON p.user_id = u.id
      WHERE p.team_id = ? AND p.is_active = TRUE
      ORDER BY p.jersey_number
    `, [req.params.id]);
    
    res.json({
      id: team.id,
      name: team.name,
      ageGroup: team.age_group,
      season: team.season,
      club: {
        id: team.club_id,
        name: team.club_name
      },
      players: players.map(p => ({
        id: p.id,
        jerseyNumber: p.jersey_number,
        position: p.position,
        firstName: p.first_name,
        lastName: p.last_name,
        name: `${p.first_name} ${p.last_name}`,
        avatar: p.avatar_url
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/teams/:id/players - Get team players
router.get('/:id/players', async (req, res, next) => {
  try {
    const [players] = await db.query(`
      SELECT 
        p.id,
        p.jersey_number,
        p.position,
        u.first_name,
        u.last_name,
        u.email,
        u.date_of_birth,
        u.avatar_url
      FROM team_memberships p
      JOIN users u ON p.user_id = u.id
      WHERE p.team_id = ? AND p.is_active = TRUE
      ORDER BY p.jersey_number
    `, [req.params.id]);
    
    res.json({
      total: players.length,
      players: players.map(p => ({
        id: p.id,
        jerseyNumber: p.jersey_number,
        position: p.position,
        firstName: p.first_name,
        lastName: p.last_name,
        name: `${p.first_name} ${p.last_name}`,
        email: p.email,
        dateOfBirth: p.date_of_birth,
        avatar: p.avatar_url
      }))
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
