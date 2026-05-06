const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const PLANNER_META_MARKER = '[[PLANNER_META]]';

const parsePlannerMetaInput = (recurrenceRule, sessionType, indicatorCode) => {
  let recurrence = {};

  if (typeof recurrenceRule === 'string' && recurrenceRule.trim()) {
    try {
      const parsed = JSON.parse(recurrenceRule);
      if (parsed && typeof parsed === 'object') {
        recurrence = parsed;
      }
    } catch {
      recurrence = {};
    }
  } else if (recurrenceRule && typeof recurrenceRule === 'object') {
    recurrence = recurrenceRule;
  }

  const resolvedSessionType = String(sessionType || recurrence.sessionType || recurrence.session_type || '').trim();
  const resolvedIndicatorCode = String(indicatorCode || recurrence.indicatorCode || '').trim().toUpperCase();

  const meta = {
    ...recurrence,
  };

  if (resolvedSessionType) {
    meta.sessionType = resolvedSessionType;
  }
  if (resolvedIndicatorCode) {
    meta.indicatorCode = resolvedIndicatorCode;
  }

  return meta;
};

const extractPlannerMetaFromDescription = (rawDescription) => {
  const source = String(rawDescription || '');
  const markerIndex = source.indexOf(PLANNER_META_MARKER);
  if (markerIndex === -1) {
    return {
      cleanDescription: source,
      plannerMeta: {},
    };
  }

  const cleanDescription = source.slice(0, markerIndex).replace(/\s+$/g, '');
  const rawMeta = source.slice(markerIndex + PLANNER_META_MARKER.length).trim();

  try {
    const parsedMeta = JSON.parse(rawMeta);
    return {
      cleanDescription,
      plannerMeta: parsedMeta && typeof parsedMeta === 'object' ? parsedMeta : {},
    };
  } catch {
    return {
      cleanDescription: source,
      plannerMeta: {},
    };
  }
};

const buildDescriptionWithPlannerMeta = (description, plannerMeta) => {
  const cleanDescription = String(description || '').trim();
  const meta = plannerMeta && typeof plannerMeta === 'object' ? plannerMeta : {};
  if (Object.keys(meta).length === 0) {
    return cleanDescription || null;
  }

  const suffix = `${PLANNER_META_MARKER}${JSON.stringify(meta)}`;
  return cleanDescription ? `${cleanDescription}\n${suffix}` : suffix;
};

const resolveTrainingDateColumn = async (connection = db) => {
  const [columns] = await connection.query('SHOW COLUMNS FROM training_sessions');
  const columnNames = columns.map((column) => String(column?.Field || '').trim());
  const lowered = new Set(columnNames.map((name) => name.toLowerCase()));

  if (lowered.has('date')) return columnNames.find((name) => name.toLowerCase() === 'date');
  if (lowered.has('scheduled_date')) return columnNames.find((name) => name.toLowerCase() === 'scheduled_date');
  if (lowered.has('training_date')) return columnNames.find((name) => name.toLowerCase() === 'training_date');
  if (lowered.has('session_date')) return columnNames.find((name) => name.toLowerCase() === 'session_date');
  if (lowered.has('event_date')) return columnNames.find((name) => name.toLowerCase() === 'event_date');

  const dynamicDateColumn = columnNames.find((name) => {
    const normalized = name.toLowerCase();
    if (normalized === 'created_at' || normalized === 'updated_at') return false;
    return normalized.includes('date') || normalized.endsWith('_day') || normalized === 'day';
  });

  return dynamicDateColumn || 'date';
};

const ensureTrainingSessionScheduleColumns = async (connection = db) => {
  const [columns] = await connection.query('SHOW COLUMNS FROM training_sessions');
  const columnSet = new Set(columns.map((column) => String(column?.Field || '').trim().toLowerCase()));

  const hasDateColumn = ['date', 'scheduled_date', 'training_date', 'session_date', 'event_date']
    .some((columnName) => columnSet.has(columnName));

  if (!hasDateColumn) {
    try {
      await connection.query('ALTER TABLE training_sessions ADD COLUMN training_date DATE NULL');
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  }

  if (!columnSet.has('start_time')) {
    try {
      await connection.query('ALTER TABLE training_sessions ADD COLUMN start_time TIME NULL');
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  }

  if (!columnSet.has('end_time')) {
    try {
      await connection.query('ALTER TABLE training_sessions ADD COLUMN end_time TIME NULL');
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  }
};

const resolveExistingColumn = async (connection, tableName, candidateColumns) => {
  try {
    const [columns] = await connection.query(`SHOW COLUMNS FROM ${tableName}`);
    const available = new Set(columns.map((column) => String(column?.Field || '').toLowerCase()));
    return candidateColumns.find((column) => available.has(String(column).toLowerCase())) || null;
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw error;
  }
};

const resolveTrainingExercisesForeignKeyColumn = async (connection = db) => (
  resolveExistingColumn(connection, 'training_exercises', [
    'training_session_id',
    'training_id',
    'session_id',
    'trainingId',
  ])
);

const resolveTrainingExercisesSectionColumn = async (connection = db) => (
  resolveExistingColumn(connection, 'training_exercises', [
    'section_id',
    'section',
    'sectionId',
  ])
);

const resolveTrainingExercisesSectionColumnMeta = async (connection = db) => {
  const sectionColumn = await resolveTrainingExercisesSectionColumn(connection);
  if (!sectionColumn) return null;

  try {
    const [columns] = await connection.query('SHOW COLUMNS FROM training_exercises');
    const meta = (Array.isArray(columns) ? columns : []).find((column) => (
      String(column?.Field || '').toLowerCase() === String(sectionColumn).toLowerCase()
    ));

    if (!meta) return { name: sectionColumn, type: '' };
    return {
      name: sectionColumn,
      type: String(meta?.Type || '').toLowerCase(),
    };
  } catch {
    return { name: sectionColumn, type: '' };
  }
};

const resolveTrainingExerciseSectionValue = (exercise, sectionMeta) => {
  if (!sectionMeta?.name) return null;

  const rawValue = String(
    exercise?.section
    || exercise?.section_id
    || exercise?.sectionId
    || 'main'
  ).trim();

  const normalized = rawValue.toLowerCase();
  const sectionIndexByKey = {
    warmup: 1,
    prep: 1,
    preparation: 1,
    main: 2,
    core: 2,
    end: 3,
    finish: 3,
    cool: 3,
  };

  if (String(sectionMeta.type || '').includes('int')) {
    const parsed = Number(rawValue);
    if (Number.isFinite(parsed) && parsed > 0) return Math.trunc(parsed);
    return sectionIndexByKey[normalized] || 2;
  }

  return rawValue || 'main';
};

const ensureTrainingExercisesSchema = async (connection = db) => {
  const ensureTableExists = async () => {
    try {
      await connection.query('SHOW COLUMNS FROM training_exercises');
      return;
    } catch (error) {
      if (error?.code !== 'ER_NO_SUCH_TABLE') {
        throw error;
      }
    }

    await connection.query(`
      CREATE TABLE IF NOT EXISTS training_exercises (
        id INT AUTO_INCREMENT PRIMARY KEY,
        training_session_id INT NULL,
        exercise_id INT NULL,
        sequence_order INT NULL,
        duration_minutes INT NULL,
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
  };

  const ensureColumn = async (columnName, columnDefinition) => {
    try {
      await connection.query(`ALTER TABLE training_exercises ADD COLUMN ${columnName} ${columnDefinition}`);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await ensureTableExists();

  await ensureColumn('exercise_id', 'INT NULL');
  await ensureColumn('sequence_order', 'INT NULL');
  await ensureColumn('duration_minutes', 'INT NULL');
  await ensureColumn('notes', 'TEXT NULL');
  await ensureColumn('section_id', 'VARCHAR(64) NULL');

  let fkColumn = await resolveTrainingExercisesForeignKeyColumn(connection);
  if (!fkColumn) {
    await ensureColumn('training_session_id', 'INT NULL');
    fkColumn = await resolveTrainingExercisesForeignKeyColumn(connection);
  }

  return fkColumn;
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

const getScopedTeamIds = async (connection, reqUser) => {
  const role = reqUser?.role;

  if (!['player', 'parent'].includes(role)) {
    return null;
  }

  let scopedUserIds = [];
  if (role === 'player') {
    scopedUserIds = [reqUser.id];
  } else {
    scopedUserIds = await getParentScopedChildUserIds(connection, reqUser.id);
  }

  if (!scopedUserIds.length) {
    return [];
  }

  const [rows] = await connection.query(
    `SELECT DISTINCT team_id
     FROM team_memberships
     WHERE is_active = TRUE
       AND user_id IN (${scopedUserIds.map(() => '?').join(',')})
       AND team_id IS NOT NULL`,
    scopedUserIds
  );

  return rows.map((row) => row.team_id);
};

const ensureTrainingAccess = async (connection, reqUser, trainingId) => {
  const scopedTeamIds = await getScopedTeamIds(connection, reqUser);

  if (!Array.isArray(scopedTeamIds)) {
    return { allowed: true };
  }

  if (!scopedTeamIds.length) {
    return { allowed: false };
  }

  const [trainings] = await connection.query(
    'SELECT team_id FROM training_sessions WHERE id = ? LIMIT 1',
    [trainingId]
  );

  if (!trainings.length) {
    return { allowed: false, notFound: true };
  }

  return { allowed: scopedTeamIds.includes(trainings[0].team_id), notFound: false };
};

// GET /api/trainings - Get all training sessions
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { teamId, status, limit = 50 } = req.query;
    await ensureTrainingSessionScheduleColumns(db);
    const dateColumn = await resolveTrainingDateColumn(db);
    const trainingExercisesFkColumn = await resolveTrainingExercisesForeignKeyColumn(db);
    const scopedTeamIds = await getScopedTeamIds(db, req.user);

    if (Array.isArray(scopedTeamIds) && scopedTeamIds.length === 0) {
      return res.json({ total: 0, trainings: [] });
    }
    
    // Map legacy status value 'scheduled' to 'planned'
    const dbStatus = status === 'scheduled' ? 'planned' : status;
    
    let query = `
      SELECT 
        ts.id,
        ts.team_id,
        ts.title,
        ts.${dateColumn} AS date,
        ts.start_time,
        ts.end_time,
        ts.location,
        ts.status,
        ts.description,
        ${trainingExercisesFkColumn ? 'COALESCE(tec.exercise_count, 0)' : '0'} AS exercise_count,
        t.name as team_name,
        t.age_group
      FROM training_sessions ts
      LEFT JOIN teams t ON ts.team_id = t.id
      ${trainingExercisesFkColumn
    ? `LEFT JOIN (
        SELECT ${trainingExercisesFkColumn} AS training_ref_id, COUNT(*) AS exercise_count
        FROM training_exercises
        GROUP BY ${trainingExercisesFkColumn}
      ) tec ON tec.training_ref_id = ts.id`
    : ''}
      WHERE 1=1
    `;
    
    const params = [];
    
    if (teamId) {
      if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(Number(teamId))) {
        return res.json({ total: 0, trainings: [] });
      }

      query += ' AND ts.team_id = ?';
      params.push(teamId);
    }

    if (Array.isArray(scopedTeamIds) && !teamId) {
      query += ` AND ts.team_id IN (${scopedTeamIds.map(() => '?').join(',')})`;
      params.push(...scopedTeamIds);
    }
    
    if (dbStatus) {
      query += ' AND ts.status = ?';
      params.push(dbStatus);
    }
    
    query += ` ORDER BY ts.${dateColumn} DESC, ts.start_time DESC LIMIT ?`;
    params.push(parseInt(limit));
    
    const [trainings] = await db.query(query, params);
    
    res.json({
      total: trainings.length,
      trainings: trainings.map(tr => ({
        ...(() => {
          const meta = extractPlannerMetaFromDescription(tr.description);
          return {
            notes: meta.cleanDescription,
            recurrenceRule: JSON.stringify(meta.plannerMeta || {}),
            recurrence_rule: JSON.stringify(meta.plannerMeta || {}),
            sessionType: String(meta.plannerMeta?.sessionType || tr.session_type || ''),
            session_type: String(meta.plannerMeta?.sessionType || tr.session_type || ''),
          };
        })(),
        id: tr.id,
        name: tr.title,
        date: tr.date,
        startTime: tr.start_time,
        endTime: tr.end_time,
        location: tr.location,
        status: tr.status,
        team: {
          id: tr.team_id,
          name: tr.team_name,
          ageGroup: tr.age_group
        },
        coach: null,
        exerciseCount: Number(tr.exercise_count || 0),
        attendanceCount: 0
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/trainings/:id - Get training detail
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const trainingId = Number(req.params.id);
    await ensureTrainingSessionScheduleColumns(db);
    const dateColumn = await resolveTrainingDateColumn(db);
    const trainingExercisesFkColumn = await resolveTrainingExercisesForeignKeyColumn(db);
    const access = await ensureTrainingAccess(db, req.user, trainingId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Training not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto tréningu' });
    }

    const [trainings] = await db.query(`
      SELECT 
        ts.*,
        ts.${dateColumn} AS date,
        t.name as team_name,
        t.age_group
      FROM training_sessions ts
      LEFT JOIN teams t ON ts.team_id = t.id
      WHERE ts.id = ?
    `, [trainingId]);
    
    if (trainings.length === 0) {
      return res.status(404).json({ error: 'Training not found' });
    }
    
    const training = trainings[0];
    const trainingMeta = extractPlannerMetaFromDescription(training.description);
    
    // Get exercises
    const [exercises] = trainingExercisesFkColumn
      ? await db.query(`
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
          WHERE te.${trainingExercisesFkColumn} = ?
          ORDER BY te.sequence_order
        `, [trainingId])
      : [[]];
    
    // Get attendance
    const [attendance] = await db.query(`
      SELECT 
        ar.id,
        ar.status,
        ar.minutes_participated as minutes_present,
        ar.notes,
        u.id as player_id,
        tm.jersey_number,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM attendance ar
      JOIN users u ON ar.user_id = u.id
      LEFT JOIN team_memberships tm ON ar.user_id = tm.user_id
      WHERE ar.training_id = ?
      ORDER BY tm.jersey_number
    `, [trainingId]);
    
    res.json({
      id: training.id,
      name: training.title,
      date: training.date,
      startTime: training.start_time,
      endTime: training.end_time,
      location: training.location,
      status: training.status,
      notes: trainingMeta.cleanDescription,
      recurrenceRule: JSON.stringify(trainingMeta.plannerMeta || {}),
      recurrence_rule: JSON.stringify(trainingMeta.plannerMeta || {}),
      sessionType: String(trainingMeta.plannerMeta?.sessionType || training.session_type || ''),
      session_type: String(trainingMeta.plannerMeta?.sessionType || training.session_type || ''),
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
        exerciseId: ex.exercise_id,
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
router.post('/', authenticateToken, requireRole(['club', 'coach']), async (req, res, next) => {
  try {
    const { 
      teamId, 
      name,
      title,
      date, 
      training_date,
      scheduled_date,
      session_date,
      event_date,
      startTime,
      start_time,
      endTime,
      end_time,
      location, 
      notes,
      description,
      recurrence_rule,
      recurrenceRule,
      session_type,
      sessionType,
      indicatorCode,
      exercises = [] 
    } = req.body;

    const resolvedTitle = title || name;
    const resolvedDate = date || training_date || scheduled_date || session_date || event_date;
    const resolvedStartTime = startTime || start_time;
    const resolvedEndTime = endTime || end_time;
    const plannerMeta = parsePlannerMetaInput(recurrence_rule || recurrenceRule, session_type || sessionType, indicatorCode);
    const resolvedDescription = buildDescriptionWithPlannerMeta(description || notes || null, plannerMeta);

    if (!teamId || !resolvedTitle || !resolvedDate || !resolvedStartTime || !resolvedEndTime) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['teamId', 'title/name', 'date', 'startTime', 'endTime']
      });
    }
    
    const connection = await db.getConnection();
    
    try {
      await connection.beginTransaction();
      await ensureTrainingSessionScheduleColumns(connection);
      const dateColumn = await resolveTrainingDateColumn(connection);
      const trainingExercisesFkColumn = await ensureTrainingExercisesSchema(connection);
      const trainingExercisesSectionMeta = await resolveTrainingExercisesSectionColumnMeta(connection);
      
      // Insert training session
      const [result] = await connection.query(`
        INSERT INTO training_sessions 
        (team_id, title, ${dateColumn}, start_time, end_time, location, description, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'planned')
      `, [teamId, resolvedTitle, resolvedDate, resolvedStartTime, resolvedEndTime, location || null, resolvedDescription]);
      
      const trainingId = result.insertId;
      
      // Insert exercises
      if (exercises.length > 0) {
        if (!trainingExercisesFkColumn) {
          throw new Error('Training exercises schema is missing foreign key column');
        }

        for (let i = 0; i < exercises.length; i++) {
          const ex = exercises[i];
          const insertColumns = [trainingExercisesFkColumn, 'exercise_id', 'sequence_order', 'duration_minutes', 'notes'];
          const insertValues = [trainingId, ex.exerciseId, i + 1, ex.duration, ex.notes || null];

          if (trainingExercisesSectionMeta?.name) {
            insertColumns.push(trainingExercisesSectionMeta.name);
            insertValues.push(resolveTrainingExerciseSectionValue(ex, trainingExercisesSectionMeta));
          }

          const placeholders = insertColumns.map(() => '?').join(', ');
          await connection.query(`
            INSERT INTO training_exercises 
            (${insertColumns.join(', ')})
            VALUES (${placeholders})
          `, insertValues);
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

// PUT /api/trainings/:id - Update training session
router.put('/:id', authenticateToken, requireRole(['club', 'coach']), async (req, res, next) => {
  try {
    const trainingId = Number(req.params.id);
    const dateColumn = await resolveTrainingDateColumn(db);
    if (!Number.isFinite(trainingId) || trainingId <= 0) {
      return res.status(400).json({ error: 'Invalid training id' });
    }

    const {
      teamId,
      name,
      title,
      date,
      training_date,
      scheduled_date,
      session_date,
      event_date,
      startTime,
      start_time,
      endTime,
      end_time,
      location,
      notes,
      description,
      status,
      recurrence_rule,
      recurrenceRule,
      session_type,
      sessionType,
      indicatorCode,
    } = req.body;

    const resolvedTitle = title || name;
    const resolvedDate = date || training_date || scheduled_date || session_date || event_date;
    const resolvedStartTime = startTime || start_time;
    const resolvedEndTime = endTime || end_time;
    const plannerMetaInput = parsePlannerMetaInput(recurrence_rule || recurrenceRule, session_type || sessionType, indicatorCode);
    let resolvedDescription = description ?? notes;

    if (resolvedDescription === undefined && Object.keys(plannerMetaInput).length > 0) {
      const [rows] = await db.query('SELECT description FROM training_sessions WHERE id = ? LIMIT 1', [trainingId]);
      const currentDescription = rows?.[0]?.description;
      const extracted = extractPlannerMetaFromDescription(currentDescription);
      resolvedDescription = extracted.cleanDescription;
    }

    if (resolvedDescription !== undefined) {
      const baseMeta = (() => {
        if (Object.keys(plannerMetaInput).length > 0) {
          return plannerMetaInput;
        }
        const extracted = extractPlannerMetaFromDescription(resolvedDescription);
        return extracted.plannerMeta || {};
      })();
      resolvedDescription = buildDescriptionWithPlannerMeta(resolvedDescription, baseMeta);
    }

    const updates = [];
    const params = [];

    if (teamId !== undefined) {
      updates.push('team_id = ?');
      params.push(teamId);
    }
    if (resolvedTitle !== undefined) {
      updates.push('title = ?');
      params.push(resolvedTitle);
    }
    if (resolvedDate !== undefined) {
      updates.push(`${dateColumn} = ?`);
      params.push(resolvedDate);
    }
    if (resolvedStartTime !== undefined) {
      updates.push('start_time = ?');
      params.push(resolvedStartTime);
    }
    if (resolvedEndTime !== undefined) {
      updates.push('end_time = ?');
      params.push(resolvedEndTime);
    }
    if (location !== undefined) {
      updates.push('location = ?');
      params.push(location || null);
    }
    if (resolvedDescription !== undefined) {
      updates.push('description = ?');
      params.push(resolvedDescription || null);
    }
    if (status !== undefined) {
      updates.push('status = ?');
      params.push(status);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No updatable fields provided' });
    }

    params.push(trainingId);

    const [result] = await db.query(
      `UPDATE training_sessions SET ${updates.join(', ')} WHERE id = ?`,
      params
    );

    if (!result?.affectedRows) {
      return res.status(404).json({ error: 'Training not found' });
    }

    res.json({ id: trainingId, message: 'Training session updated successfully' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/trainings/:id - Delete training session
router.delete('/:id', authenticateToken, requireRole(['club', 'coach']), async (req, res, next) => {
  try {
    const trainingId = Number(req.params.id);
    if (!Number.isFinite(trainingId) || trainingId <= 0) {
      return res.status(400).json({ error: 'Invalid training id' });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const trainingExercisesColumn = await resolveExistingColumn(connection, 'training_exercises', [
        'training_session_id',
        'training_id',
        'session_id',
        'trainingId',
      ]);
      if (trainingExercisesColumn) {
        await connection.query(`DELETE FROM training_exercises WHERE ${trainingExercisesColumn} = ?`, [trainingId]);
      }

      const attendanceColumn = await resolveExistingColumn(connection, 'attendance', [
        'training_session_id',
        'training_id',
        'session_id',
        'trainingId',
      ]);
      if (attendanceColumn) {
        await connection.query(`DELETE FROM attendance WHERE ${attendanceColumn} = ?`, [trainingId]);
      }

      const [result] = await connection.query('DELETE FROM training_sessions WHERE id = ?', [trainingId]);

      if (!result?.affectedRows) {
        await connection.rollback();
        return res.status(404).json({ error: 'Training not found' });
      }

      await connection.commit();
      res.json({ id: trainingId, message: 'Training session deleted successfully' });
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
router.get('/:id/exercises', authenticateToken, async (req, res, next) => {
  try {
    const trainingId = Number(req.params.id);
    const trainingExercisesFkColumn = await resolveTrainingExercisesForeignKeyColumn(db);
    const access = await ensureTrainingAccess(db, req.user, trainingId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Training not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto tréningu' });
    }

    const [exercises] = trainingExercisesFkColumn
      ? await db.query(`
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
          WHERE te.${trainingExercisesFkColumn} = ?
          ORDER BY te.sequence_order
        `, [trainingId])
      : [[]];
    
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
