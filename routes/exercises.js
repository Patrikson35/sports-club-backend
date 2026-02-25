const express = require('express');
const router = express.Router();
const db = require('../config/database');

// GET /api/exercises - Get all exercises
router.get('/', async (req, res, next) => {
  try {
    const { categoryId, difficulty, search } = req.query;
    
    let query = `
      SELECT 
        e.*,
        ec.name as category_name,
        ec.description as category_description
      FROM exercises e
      LEFT JOIN exercise_categories ec ON e.category_id = ec.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (categoryId) {
      query += ' AND e.category_id = ?';
      params.push(categoryId);
    }
    
    if (difficulty) {
      query += ' AND e.difficulty_level = ?';
      params.push(difficulty);
    }
    
    if (search) {
      query += ' AND (e.name LIKE ? OR e.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY ec.name, e.name';
    
    const [exercises] = await db.query(query, params);
    
    res.json({
      total: exercises.length,
      exercises: exercises.map(ex => ({
        id: ex.id,
        name: ex.name,
        description: ex.description,
        category: {
          id: ex.category_id,
          name: ex.category_name,
          description: ex.category_description
        },
        duration: ex.duration_minutes,
        difficulty: ex.difficulty_level,
        equipment: ex.required_equipment
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/exercises/categories - Get exercise categories
router.get('/categories', async (req, res, next) => {
  try {
    const [categories] = await db.query(`
      SELECT 
        ec.*,
        COUNT(e.id) as exercise_count,
        parent.name as parent_name
      FROM exercise_categories ec
      LEFT JOIN exercises e ON ec.id = e.category_id
      LEFT JOIN exercise_categories parent ON ec.parent_id = parent.id
      GROUP BY ec.id
      ORDER BY ec.parent_id IS NULL DESC, ec.name
    `);
    
    // Build hierarchy
    const categoryMap = {};
    const rootCategories = [];
    
    categories.forEach(cat => {
      categoryMap[cat.id] = {
        id: cat.id,
        name: cat.name,
        description: cat.description,
        parentId: cat.parent_id,
        parentName: cat.parent_name,
        exerciseCount: cat.exercise_count,
        subcategories: []
      };
    });
    
    categories.forEach(cat => {
      if (cat.parent_id) {
        if (categoryMap[cat.parent_id]) {
          categoryMap[cat.parent_id].subcategories.push(categoryMap[cat.id]);
        }
      } else {
        rootCategories.push(categoryMap[cat.id]);
      }
    });
    
    res.json({
      total: rootCategories.length,
      categories: rootCategories
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/exercises/:id - Get exercise detail
router.get('/:id', async (req, res, next) => {
  try {
    const [exercises] = await db.query(`
      SELECT 
        e.*,
        ec.name as category_name,
        ec.description as category_description
      FROM exercises e
      LEFT JOIN exercise_categories ec ON e.category_id = ec.id
      WHERE e.id = ?
    `, [req.params.id]);
    
    if (exercises.length === 0) {
      return res.status(404).json({ error: 'Exercise not found' });
    }
    
    const exercise = exercises[0];
    
    res.json({
      id: exercise.id,
      name: exercise.name,
      description: exercise.description,
      category: {
        id: exercise.category_id,
        name: exercise.category_name,
        description: exercise.category_description
      },
      duration: exercise.duration_minutes,
      difficulty: exercise.difficulty_level,
      equipment: exercise.required_equipment
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
