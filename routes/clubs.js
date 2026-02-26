const express = require('express');
const router = express.Router();
const db = require('../config/database');

// GET /api/clubs - Get all clubs
router.get('/', async (req, res, next) => {
  try {
    const [clubs] = await db.query(`
      SELECT 
        c.*,
        COUNT(DISTINCT t.id) as team_count,
        COUNT(DISTINCT tm.user_id) as player_count
      FROM clubs c
      LEFT JOIN teams t ON c.id = t.club_id
      LEFT JOIN team_memberships tm ON t.id = tm.team_id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `);

    res.json({
      total: clubs.length,
      clubs: clubs
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/clubs - Create new club
router.post('/', async (req, res, next) => {
  try {
    const { name, address, email, phone } = req.body;

    if (!name) {
      return res.status(400).json({ error: 'Název klubu je povinný' });
    }

    const [result] = await db.query(
      'INSERT INTO clubs (name, address, email, phone, created_at) VALUES (?, ?, ?, ?, NOW())',
      [name, address || null, email || null, phone || null]
    );

    const [club] = await db.query('SELECT * FROM clubs WHERE id = ?', [result.insertId]);

    res.status(201).json({
      message: 'Klub úspěšně vytvořen',
      club: club[0]
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
