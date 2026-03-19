const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const ensureExercisesVisibilityColumns = async (connection = db) => {
  const statements = [
    "ALTER TABLE exercises ADD COLUMN club_id INT NULL",
    "ALTER TABLE exercises ADD COLUMN created_by_user_id INT NULL",
    "ALTER TABLE exercises ADD COLUMN is_system BOOLEAN DEFAULT FALSE"
  ];

  for (const statement of statements) {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  }
};

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

const getAccessibleClubIds = async (connection, user) => {
  if (user?.role === 'admin') {
    return null;
  }

  const clubIds = new Set();

  const [memberRows] = await connection.query(
    `SELECT club_id
     FROM club_members
     WHERE user_id = ? AND is_active = TRUE`,
    [user.id]
  );
  memberRows.forEach((row) => clubIds.add(row.club_id));

  try {
    const [ownedRows] = await connection.query('SELECT id FROM clubs WHERE owner_id = ?', [user.id]);
    ownedRows.forEach((row) => clubIds.add(row.id));
  } catch {}

  try {
    const [userClubRows] = await connection.query('SELECT club_id FROM users WHERE id = ? AND club_id IS NOT NULL', [user.id]);
    userClubRows.forEach((row) => clubIds.add(row.club_id));
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      throw error;
    }
  }

  if (user?.role === 'player') {
    const [teamRows] = await connection.query(
      `SELECT DISTINCT t.club_id
       FROM team_memberships tm
       JOIN teams t ON t.id = tm.team_id
       WHERE tm.user_id = ? AND tm.is_active = TRUE AND t.club_id IS NOT NULL`,
      [user.id]
    );
    teamRows.forEach((row) => clubIds.add(row.club_id));
  }

  if (user?.role === 'parent') {
    const childIds = await getParentScopedChildUserIds(connection, user.id);
    if (childIds.length) {
      const [teamRows] = await connection.query(
        `SELECT DISTINCT t.club_id
         FROM team_memberships tm
         JOIN teams t ON t.id = tm.team_id
         WHERE tm.user_id IN (${childIds.map(() => '?').join(',')})
           AND tm.is_active = TRUE
           AND t.club_id IS NOT NULL`,
        childIds
      );
      teamRows.forEach((row) => clubIds.add(row.club_id));
    }
  }

  return [...clubIds].filter((clubId) => Number.isInteger(Number(clubId)));
};

const getExerciseVisibilitySql = (clubIds, alias = 'e') => {
  if (clubIds === null) {
    return { sql: '1=1', params: [] };
  }

  if (!Array.isArray(clubIds) || clubIds.length === 0) {
    return { sql: `${alias}.is_system = TRUE`, params: [] };
  }

  return {
    sql: `(${alias}.is_system = TRUE OR ${alias}.club_id IN (${clubIds.map(() => '?').join(',')}))`,
    params: [...clubIds]
  };
};

// GET /api/exercises - Get all exercises
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    await ensureExercisesVisibilityColumns();

    const accessibleClubIds = await getAccessibleClubIds(db, req.user);
    const visibility = getExerciseVisibilitySql(accessibleClubIds, 'e');
    const { categoryId, difficulty, search } = req.query;
    
    let query = `
      SELECT 
        e.*,
        ec.name as category_name,
        ec.description as category_description
      FROM exercises e
      LEFT JOIN exercise_categories ec ON e.category_id = ec.id
      WHERE ${visibility.sql}
    `;
    
    const params = [...visibility.params];
    
    if (categoryId) {
      query += ' AND e.category_id = ?';
      params.push(categoryId);
    }
    
    if (difficulty) {
      query += ' AND e.difficulty = ?';
      params.push(difficulty);
    }
    
    if (search) {
      query += ' AND (e.title LIKE ? OR e.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    
    query += ' ORDER BY ec.name, e.title';
    
    const [exercises] = await db.query(query, params);
    
    res.json({
      total: exercises.length,
      exercises: exercises.map(ex => ({
        id: ex.id,
        name: ex.title,
        title: ex.title,
        description: ex.description,
        category: {
          id: ex.category_id,
          name: ex.category_name,
          description: ex.category_description
        },
        duration: ex.duration_minutes,
        difficulty: ex.difficulty,
        equipment: ex.equipment_needed,
        isSystem: Boolean(ex.is_system),
        clubId: ex.club_id || null
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/exercises/categories - Get exercise categories
router.get('/categories', authenticateToken, async (req, res, next) => {
  try {
    await ensureExercisesVisibilityColumns();

    const accessibleClubIds = await getAccessibleClubIds(db, req.user);
    const visibility = getExerciseVisibilitySql(accessibleClubIds, 'e');

    const [categories] = await db.query(`
      SELECT 
        ec.*,
        COUNT(e.id) as exercise_count,
        parent.name as parent_name
      FROM exercise_categories ec
      LEFT JOIN exercises e ON ec.id = e.category_id AND ${visibility.sql}
      LEFT JOIN exercise_categories parent ON ec.parent_id = parent.id
      GROUP BY ec.id, ec.name, ec.description, ec.parent_id, parent.name
      ORDER BY ec.parent_id IS NULL DESC, ec.name
    `, visibility.params);
    
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
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    await ensureExercisesVisibilityColumns();

    const accessibleClubIds = await getAccessibleClubIds(db, req.user);
    const visibility = getExerciseVisibilitySql(accessibleClubIds, 'e');

    const [exercises] = await db.query(`
      SELECT 
        e.*,
        ec.name as category_name,
        ec.description as category_description
      FROM exercises e
      LEFT JOIN exercise_categories ec ON e.category_id = ec.id
      WHERE e.id = ? AND ${visibility.sql}
    `, [req.params.id, ...visibility.params]);
    
    if (exercises.length === 0) {
      return res.status(404).json({ error: 'Exercise not found' });
    }
    
    const exercise = exercises[0];
    
    res.json({
      id: exercise.id,
      name: exercise.title,
      title: exercise.title,
      description: exercise.description,
      category: {
        id: exercise.category_id,
        name: exercise.category_name,
        description: exercise.category_description
      },
      duration: exercise.duration_minutes,
      difficulty: exercise.difficulty,
      equipment: exercise.equipment_needed,
      isSystem: Boolean(exercise.is_system),
      clubId: exercise.club_id || null
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/exercises - Create exercise
router.post('/', authenticateToken, requireRole(['club', 'coach', 'admin']), async (req, res, next) => {
  try {
    await ensureExercisesVisibilityColumns();

    const {
      title,
      description,
      categoryId,
      duration,
      difficulty,
      equipment,
      clubId,
      isSystem
    } = req.body;

    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) {
      return res.status(400).json({ error: 'Názov cviku je povinný' });
    }

    const createAsSystem = req.user.role === 'admin' && Boolean(isSystem);

    let resolvedClubId = null;
    if (!createAsSystem) {
      const accessibleClubIds = await getAccessibleClubIds(db, req.user);
      if (!Array.isArray(accessibleClubIds) || accessibleClubIds.length === 0) {
        return res.status(403).json({ error: 'Nemáte prístup do žiadneho klubu pre vytvorenie interného cviku' });
      }

      if (clubId) {
        const parsedClubId = Number(clubId);
        if (!accessibleClubIds.includes(parsedClubId)) {
          return res.status(403).json({ error: 'Nemáte oprávnenie vytvoriť cvik v tomto klube' });
        }
        resolvedClubId = parsedClubId;
      } else {
        resolvedClubId = accessibleClubIds[0];
      }
    }

    const [result] = await db.query(
      `INSERT INTO exercises
        (title, description, category_id, duration_minutes, difficulty, equipment_needed, club_id, created_by_user_id, is_system)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedTitle,
        description || null,
        categoryId || null,
        duration || null,
        difficulty || null,
        equipment || null,
        resolvedClubId,
        req.user.id,
        createAsSystem
      ]
    );

    res.status(201).json({
      id: result.insertId,
      message: createAsSystem
        ? 'Systémový cvik bol úspešne vytvorený'
        : 'Interný klubový cvik bol úspešne vytvorený',
      exercise: {
        id: result.insertId,
        title: normalizedTitle,
        isSystem: createAsSystem,
        clubId: resolvedClubId
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
