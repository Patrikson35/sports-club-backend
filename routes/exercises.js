const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const ensureExercisesVisibilityColumns = async (connection = db) => {
  const statements = [
    "ALTER TABLE exercises ADD COLUMN category_id INT NULL",
    "ALTER TABLE exercises ADD COLUMN duration_minutes INT NULL",
    "ALTER TABLE exercises ADD COLUMN difficulty VARCHAR(80) NULL",
    "ALTER TABLE exercises ADD COLUMN equipment_needed TEXT NULL",
    "ALTER TABLE exercises ADD COLUMN youtube_url TEXT NULL",
    "ALTER TABLE exercises ADD COLUMN youtube_video_id VARCHAR(32) NULL",
    "ALTER TABLE exercises ADD COLUMN club_id INT NULL",
    "ALTER TABLE exercises ADD COLUMN created_by_user_id INT NULL",
    "ALTER TABLE exercises ADD COLUMN is_system BOOLEAN DEFAULT FALSE",
    "ALTER TABLE exercises ADD COLUMN custom_labels_json LONGTEXT NULL",
    "ALTER TABLE exercises ADD COLUMN sport_key VARCHAR(80) NULL"
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

const ensureExerciseCategoryVisibilityColumns = async (connection = db) => {
  const statements = [
    "ALTER TABLE exercise_categories ADD COLUMN club_id INT NULL",
    "ALTER TABLE exercise_categories ADD COLUMN created_by_user_id INT NULL",
    "ALTER TABLE exercise_categories ADD COLUMN is_system BOOLEAN DEFAULT TRUE",
    "ALTER TABLE exercise_categories ADD COLUMN sport_key VARCHAR(80) NULL"
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

const normalizeCustomLabels = (value) => {
  if (!Array.isArray(value)) return [];
  const normalized = value
    .map((label) => String(label || '').trim())
    .filter(Boolean)
    .slice(0, 20);
  return [...new Set(normalized)];
};

const normalizeSportKey = (value) => {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s_-]/g, '')
    .replace(/[\s-]+/g, '_')
    .replace(/^_+|_+$/g, '');

  return normalized || null;
};

const parseCustomLabels = (value) => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return normalizeCustomLabels(parsed);
  } catch {
    return [];
  }
};

const normalizeYoutubeUrl = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

const extractYoutubeVideoId = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return null;

  const directMatch = raw.match(/^[a-zA-Z0-9_-]{11}$/);
  if (directMatch) return directMatch[0];

  const patterns = [
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/shorts\/([a-zA-Z0-9_-]{11})/,
    /youtube\.com\/embed\/([a-zA-Z0-9_-]{11})/
  ];

  for (const pattern of patterns) {
    const match = raw.match(pattern);
    if (match?.[1]) return match[1];
  }

  return null;
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

const getCategoryVisibilitySql = (clubIds, alias = 'ec') => {
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
    await ensureExerciseCategoryVisibilityColumns();

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
        youtube: {
          url: ex.youtube_url || null,
          videoId: ex.youtube_video_id || extractYoutubeVideoId(ex.youtube_url)
        },
        isSystem: Boolean(ex.is_system),
        clubId: ex.club_id || null,
        sportKey: ex.sport_key || null,
        customLabels: parseCustomLabels(ex.custom_labels_json)
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
    await ensureExerciseCategoryVisibilityColumns();

    const accessibleClubIds = await getAccessibleClubIds(db, req.user);
    const categoryVisibility = getCategoryVisibilitySql(accessibleClubIds, 'ec');
    const exerciseVisibility = getExerciseVisibilitySql(accessibleClubIds, 'e');

    const [categories] = await db.query(`
      SELECT 
        ec.*,
        COUNT(e.id) as exercise_count,
        parent.name as parent_name
      FROM exercise_categories ec
      LEFT JOIN exercises e ON ec.id = e.category_id AND ${exerciseVisibility.sql}
      LEFT JOIN exercise_categories parent ON ec.parent_id = parent.id
      WHERE ${categoryVisibility.sql}
      GROUP BY ec.id, ec.name, ec.description, ec.parent_id, parent.name
      ORDER BY ec.parent_id IS NULL DESC, ec.name
    `, [...exerciseVisibility.params, ...categoryVisibility.params]);
    
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
        isSystem: Boolean(cat.is_system),
        clubId: cat.club_id || null,
        sportKey: cat.sport_key || null,
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

// POST /api/exercises/categories - Create exercise category
router.post('/categories', authenticateToken, requireRole(['club', 'coach', 'admin']), async (req, res, next) => {
  try {
    await ensureExerciseCategoryVisibilityColumns();

    const normalizedName = String(req.body?.name || '').trim();
    const normalizedDescription = String(req.body?.description || '').trim();
    const parentId = req.body?.parentId ? Number(req.body.parentId) : null;
    const normalizedSportKey = normalizeSportKey(req.body?.sportKey);
    const createAsSystem = req.user.role === 'admin' && Boolean(req.body?.isSystem);

    if (!normalizedName) {
      return res.status(400).json({ error: 'Názov kategórie je povinný' });
    }

    if (createAsSystem && !normalizedSportKey) {
      return res.status(400).json({ error: 'Pre systémovú kategóriu je povinný výber športu' });
    }

    let resolvedClubId = null;
    const accessibleClubIds = await getAccessibleClubIds(db, req.user);

    if (!createAsSystem) {
      if (!Array.isArray(accessibleClubIds) || accessibleClubIds.length === 0) {
        return res.status(403).json({ error: 'Nemáte prístup do žiadneho klubu pre vytvorenie kategórie' });
      }

      const requestedClubId = req.body?.clubId ? Number(req.body.clubId) : null;
      if (requestedClubId && accessibleClubIds.includes(requestedClubId)) {
        resolvedClubId = requestedClubId;
      } else {
        resolvedClubId = accessibleClubIds[0];
      }
    }

    if (parentId) {
      const categoryVisibility = getCategoryVisibilitySql(createAsSystem ? null : accessibleClubIds, 'ec');
      const [rows] = await db.query(
        `SELECT ec.id FROM exercise_categories ec WHERE ec.id = ? AND ${categoryVisibility.sql} LIMIT 1`,
        [parentId, ...categoryVisibility.params]
      );
      if (!Array.isArray(rows) || rows.length === 0) {
        return res.status(403).json({ error: 'Nadriadená kategória nie je dostupná' });
      }
    }

    const [result] = await db.query(
      `INSERT INTO exercise_categories (name, description, parent_id, club_id, created_by_user_id, is_system, sport_key)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedName,
        normalizedDescription || null,
        parentId || null,
        resolvedClubId,
        req.user.id,
        createAsSystem,
        normalizedSportKey
      ]
    );

    return res.status(201).json({
      id: result.insertId,
      message: createAsSystem ? 'Základná kategória bola vytvorená' : 'Klubová kategória bola vytvorená',
      category: {
        id: result.insertId,
        name: normalizedName,
        description: normalizedDescription,
        parentId: parentId || null,
        isSystem: createAsSystem,
        clubId: resolvedClubId,
        sportKey: normalizedSportKey
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/exercises/:id - Get exercise detail
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    await ensureExercisesVisibilityColumns();
    await ensureExerciseCategoryVisibilityColumns();

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
      youtube: {
        url: exercise.youtube_url || null,
        videoId: exercise.youtube_video_id || extractYoutubeVideoId(exercise.youtube_url)
      },
      isSystem: Boolean(exercise.is_system),
      clubId: exercise.club_id || null,
      sportKey: exercise.sport_key || null,
      customLabels: parseCustomLabels(exercise.custom_labels_json)
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/exercises - Create exercise
router.post('/', authenticateToken, requireRole(['club', 'coach', 'admin']), async (req, res, next) => {
  try {
    await ensureExercisesVisibilityColumns();
    await ensureExerciseCategoryVisibilityColumns();

    const {
      title,
      description,
      categoryId,
      duration,
      difficulty,
      equipment,
      youtubeUrl,
      clubId,
      isSystem,
      sportKey,
      customLabels
    } = req.body;

    const normalizedTitle = String(title || '').trim();
    if (!normalizedTitle) {
      return res.status(400).json({ error: 'Názov cviku je povinný' });
    }

    const createAsSystem = req.user.role === 'admin' && Boolean(isSystem);
    const normalizedSportKey = normalizeSportKey(sportKey);

    if (createAsSystem && !normalizedSportKey) {
      return res.status(400).json({ error: 'Pre systémové cvičenie je povinný výber športu' });
    }

    let resolvedClubId = null;
    const accessibleClubIds = await getAccessibleClubIds(db, req.user);
    if (!createAsSystem) {
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

    const normalizedCategoryId = categoryId ? Number(categoryId) : null;
    if (normalizedCategoryId) {
      const categoryVisibility = getCategoryVisibilitySql(createAsSystem ? null : accessibleClubIds, 'ec');
      const [categoryRows] = await db.query(
        `SELECT ec.id FROM exercise_categories ec WHERE ec.id = ? AND ${categoryVisibility.sql} LIMIT 1`,
        [normalizedCategoryId, ...categoryVisibility.params]
      );

      if (!Array.isArray(categoryRows) || categoryRows.length === 0) {
        return res.status(403).json({ error: 'Vybraná kategória nie je pre vás dostupná' });
      }
    }

    const normalizedCustomLabels = normalizeCustomLabels(customLabels);
    const normalizedYoutubeUrl = normalizeYoutubeUrl(youtubeUrl);
    const normalizedYoutubeVideoId = extractYoutubeVideoId(normalizedYoutubeUrl);

    const [result] = await db.query(
      `INSERT INTO exercises
        (title, description, category_id, duration_minutes, difficulty, equipment_needed, youtube_url, youtube_video_id, club_id, created_by_user_id, is_system, sport_key, custom_labels_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        normalizedTitle,
        description || null,
        normalizedCategoryId || null,
        duration || null,
        difficulty || null,
        equipment || null,
        normalizedYoutubeUrl,
        normalizedYoutubeVideoId,
        resolvedClubId,
        req.user.id,
        createAsSystem,
        normalizedSportKey,
        JSON.stringify(normalizedCustomLabels)
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
        youtube: {
          url: normalizedYoutubeUrl,
          videoId: normalizedYoutubeVideoId
        },
        isSystem: createAsSystem,
        clubId: resolvedClubId,
        sportKey: normalizedSportKey,
        customLabels: normalizedCustomLabels
      }
    });
  } catch (error) {
    next(error);
  }
});

// PATCH /api/exercises/:id/custom-categories - Update custom exercise labels
router.patch('/:id/custom-categories', authenticateToken, requireRole(['club', 'coach', 'admin']), async (req, res, next) => {
  try {
    await ensureExercisesVisibilityColumns();

    const exerciseId = Number(req.params.id);
    if (!Number.isFinite(exerciseId) || exerciseId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID cvičenia' });
    }

    const accessibleClubIds = await getAccessibleClubIds(db, req.user);
    const visibility = getExerciseVisibilitySql(accessibleClubIds, 'e');
    const [rows] = await db.query(
      `SELECT e.id, e.club_id, e.is_system FROM exercises e WHERE e.id = ? AND ${visibility.sql} LIMIT 1`,
      [exerciseId, ...visibility.params]
    );

    if (!Array.isArray(rows) || rows.length === 0) {
      return res.status(404).json({ error: 'Cvičenie sa nenašlo alebo k nemu nemáte prístup' });
    }

    const exercise = rows[0];
    const isAdmin = req.user?.role === 'admin';
    const isOwnerScoped = !exercise.is_system && Array.isArray(accessibleClubIds) && accessibleClubIds.includes(Number(exercise.club_id));
    if (!isAdmin && !isOwnerScoped) {
      return res.status(403).json({ error: 'Nemáte oprávnenie upraviť vlastné kategórie tohto cvičenia' });
    }

    const normalizedCustomLabels = normalizeCustomLabels(req.body?.customLabels);
    await db.query(
      'UPDATE exercises SET custom_labels_json = ? WHERE id = ? LIMIT 1',
      [JSON.stringify(normalizedCustomLabels), exerciseId]
    );

    return res.json({
      message: 'Vlastné kategórie cvičenia boli uložené',
      exercise: {
        id: exerciseId,
        customLabels: normalizedCustomLabels
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
