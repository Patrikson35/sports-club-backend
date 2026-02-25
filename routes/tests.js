const express = require('express');
const router = express.Router();
const db = require('../config/database');

// GET /api/tests/categories - Get test categories
router.get('/categories', async (req, res, next) => {
  try {
    const { type } = req.query;
    
    let query = 'SELECT * FROM test_categories WHERE 1=1';
    const params = [];
    
    if (type) {
      query += ' AND category_type = ?';
      params.push(type);
    }
    
    query += ' ORDER BY category_type, name';
    
    const [categories] = await db.query(query, params);
    
    res.json({
      total: categories.length,
      categories: categories.map(c => ({
        id: c.id,
        name: c.name,
        categoryType: c.category_type,
        unit: c.unit,
        description: c.description
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/tests/results - Get test results
router.get('/results', async (req, res, next) => {
  try {
    const { playerId, categoryId, limit = 100 } = req.query;
    
    let query = `
      SELECT 
        tr.*,
        tc.name as test_name,
        tc.category_type,
        tc.unit,
        tm.jersey_number,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM test_results tr
      JOIN test_categories tc ON tr.test_category_id = tc.id
      JOIN users u ON tr.user_id = u.id
      LEFT JOIN team_memberships tm ON tr.user_id = tm.user_id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (playerId) {
      query += ' AND tr.user_id = ?';
      params.push(playerId);
    }
    
    if (categoryId) {
      query += ' AND tr.test_category_id = ?';
      params.push(categoryId);
    }
    
    query += ' ORDER BY tr.test_date DESC, tc.name LIMIT ?';
    params.push(parseInt(limit));
    
    const [results] = await db.query(query, params);
    
    res.json({
      total: results.length,
      results: results.map(r => ({
        id: r.id,
        value: r.value,
        unit: r.unit,
        testDate: r.test_date,
        notes: r.notes,
        test: {
          id: r.test_category_id,
          name: r.test_name,
          categoryType: r.category_type,
          unit: r.unit
        },
        player: {
          id: r.player_id,
          jerseyNumber: r.jersey_number,
          firstName: r.first_name,
          lastName: r.last_name,
          name: `${r.first_name} ${r.last_name}`,
          avatar: r.avatar_url
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/tests/players/:id - Get player's test results
router.get('/players/:id', async (req, res, next) => {
  try {
    const [results] = await db.query(`
      SELECT 
        tr.*,
        tc.name as test_name,
        tc.category_type,
        tc.unit
      FROM test_results tr
      JOIN test_categories tc ON tr.test_category_id = tc.id
      WHERE tr.player_id = ?
      ORDER BY tr.test_date DESC, tc.name
    `, [req.params.id]);
    
    res.json({
      total: results.length,
      playerId: req.params.id,
      results: results.map(r => ({
        id: r.id,
        value: r.value,
        unit: r.unit,
        testDate: r.test_date,
        notes: r.notes,
        test: {
          id: r.test_category_id,
          name: r.test_name,
          categoryType: r.category_type,
          unit: r.unit
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/tests/results - Create test result
router.post('/results', async (req, res, next) => {
  try {
    const { playerId, testCategoryId, value, testDate, notes } = req.body;
    
    const [result] = await db.query(`
      INSERT INTO test_results 
      (player_id, test_category_id, value, test_date, notes, unit)
      SELECT ?, ?, ?, ?, ?, tc.unit
      FROM test_categories tc
      WHERE tc.id = ?
    `, [playerId, testCategoryId, value, testDate || new Date(), notes, testCategoryId]);
    
    res.status(201).json({
      id: result.insertId,
      message: 'Test result created successfully'
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/tests/stats/:categoryType - Get test statistics by category type
router.get('/stats/:categoryType', async (req, res, next) => {
  try {
    const { teamId } = req.query;
    
    let query = `
      SELECT 
        u.id as player_id,
        tm.jersey_number,
        u.first_name,
        u.last_name,
        u.avatar_url,
        tc.id as test_id,
        tc.name as test_name,
        tc.unit,
        tr.result_value as value,
        tr.recorded_at as test_date
      FROM team_memberships tm
      JOIN users u ON tm.user_id = u.id
      CROSS JOIN test_categories tc
      LEFT JOIN test_results tr ON u.id = tr.user_id AND tc.id = tr.test_category_id
        AND tr.recorded_at = (
          SELECT MAX(recorded_at) 
          FROM test_results 
          WHERE user_id = u.id AND test_category_id = tc.id
        )
      WHERE tc.category_type = ? AND tm.is_active = TRUE
    `;
    
    const params = [req.params.categoryType];
    
    if (teamId) {
      query += ' AND tm.team_id = ?';
      params.push(teamId);
    }
    
    query += ' ORDER BY tm.jersey_number, tc.name';
    
    const [stats] = await db.query(query, params);
    
    // Group by player
    const playerMap = {};
    stats.forEach(s => {
      if (!playerMap[s.player_id]) {
        playerMap[s.player_id] = {
          player: {
            id: s.player_id,
            jerseyNumber: s.jersey_number,
            firstName: s.first_name,
            lastName: s.last_name,
            name: `${s.first_name} ${s.last_name}`,
            avatar: s.avatar_url
          },
          tests: []
        };
      }
      
      playerMap[s.player_id].tests.push({
        testId: s.test_id,
        testName: s.test_name,
        unit: s.unit,
        value: s.value,
        testDate: s.test_date
      });
    });
    
    res.json({
      categoryType: req.params.categoryType,
      players: Object.values(playerMap)
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
