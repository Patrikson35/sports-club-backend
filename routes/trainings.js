const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken, requireRole } = require('../middleware/auth');

const PLANNER_META_MARKER = '[[PLANNER_META]]';
const TRAININGS_HIDDEN_MARKER = '[[TRAININGS_HIDDEN]]';

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

const resolveTrainingExercisesForeignKeyColumns = async (connection = db) => {
  try {
    const [columns] = await connection.query('SHOW COLUMNS FROM training_exercises');
    const available = new Set((Array.isArray(columns) ? columns : []).map((column) => String(column?.Field || '').toLowerCase()));
    const preferredOrder = ['training_session_id', 'training_id', 'session_id', 'trainingId'];
    return preferredOrder.filter((column) => available.has(String(column).toLowerCase()));
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') return [];
    throw error;
  }
};

const buildTrainingExerciseReferenceSql = (columns, trainingId, tableAlias = 'te') => {
  const normalizedColumns = Array.isArray(columns)
    ? columns.filter((column) => String(column || '').trim())
    : [];

  if (!normalizedColumns.length) {
    return { sql: '1 = 0', params: [] };
  }

  const conditions = normalizedColumns.map((column) => `${tableAlias}.${quoteIdentifier(column)} = ?`);
  return {
    sql: conditions.map((condition) => `(${condition})`).join(' OR '),
    params: normalizedColumns.map(() => trainingId),
  };
};

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

const resolveExercisesNameColumn = async (connection = db) => (
  resolveExistingColumn(connection, 'exercises', [
    'name',
    'title',
    'exercise_name',
  ])
);

const resolveTeamClubId = async (connection, teamId) => {
  const parsedTeamId = Number(teamId);
  if (!Number.isFinite(parsedTeamId) || parsedTeamId <= 0) return null;

  const teamClubColumn = await resolveExistingColumn(connection, 'teams', ['club_id', 'clubId']);
  if (!teamClubColumn) return null;

  const [rows] = await connection.query(
    `SELECT ${teamClubColumn} AS club_id FROM teams WHERE id = ? LIMIT 1`,
    [Math.trunc(parsedTeamId)]
  );

  const resolvedClubId = Number(rows?.[0]?.club_id);
  return Number.isFinite(resolvedClubId) && resolvedClubId > 0 ? Math.trunc(resolvedClubId) : null;
};

const isSafeIdentifier = (value) => /^[A-Za-z0-9_]+$/.test(String(value || ''));

const quoteIdentifier = (value) => `\`${String(value)}\``;

const resolveForeignKeyReference = async (connection, tableName, columnName) => {
  const safeTableName = String(tableName || '').trim();
  const safeColumnName = String(columnName || '').trim();
  if (!safeTableName || !safeColumnName) return null;

  const [rows] = await connection.query(
    `SELECT REFERENCED_TABLE_NAME AS referencedTableName, REFERENCED_COLUMN_NAME AS referencedColumnName
     FROM information_schema.KEY_COLUMN_USAGE
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = ?
       AND COLUMN_NAME = ?
       AND REFERENCED_TABLE_NAME IS NOT NULL
     LIMIT 1`,
    [safeTableName, safeColumnName]
  );

  const referencedTableName = String(rows?.[0]?.referencedTableName || '').trim();
  const referencedColumnName = String(rows?.[0]?.referencedColumnName || '').trim();
  if (!referencedTableName || !referencedColumnName) return null;

  if (!isSafeIdentifier(referencedTableName) || !isSafeIdentifier(referencedColumnName)) return null;

  return {
    referencedTableName,
    referencedColumnName,
  };
};

const resolveReferencedFallbackId = async (connection, tableName, columnName) => {
  const foreignKeyReference = await resolveForeignKeyReference(connection, tableName, columnName);
  if (!foreignKeyReference) return null;

  const { referencedTableName, referencedColumnName } = foreignKeyReference;

  const [refRows] = await connection.query(
    `SELECT ${quoteIdentifier(referencedColumnName)} AS ref_id
     FROM ${quoteIdentifier(referencedTableName)}
     ORDER BY ${quoteIdentifier(referencedColumnName)} ASC
     LIMIT 1`
  );

  const refId = Number(refRows?.[0]?.ref_id);
  return Number.isFinite(refId) && refId > 0 ? Math.trunc(refId) : null;
};

const parseFirstEnumValue = (columnType) => {
  const source = String(columnType || '').trim();
  const enumMatch = source.match(/^enum\((.*)\)$/i);
  if (!enumMatch) return null;

  const firstToken = String(enumMatch[1] || '').split(',')[0] || '';
  return firstToken.replace(/^\s*'/, '').replace(/'\s*$/, '').trim() || null;
};

const normalizeExerciseDifficultyValue = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) return 'intermediate';

  if (['beginner', 'zaciatocnik', 'začiatočník', 'easy', 'low'].includes(normalized)) return 'beginner';
  if (['advanced', 'pokrocily', 'pokročilý', 'hard', 'high'].includes(normalized)) return 'advanced';
  return 'intermediate';
};

const buildFallbackValueForRequiredExerciseColumn = ({
  columnName,
  columnType,
  fallbackName,
  reqUser,
  resolvedClubId,
  exercisePayload,
  referencedFallbackId,
}) => {
  const normalizedColumnName = String(columnName || '').toLowerCase();
  const normalizedColumnType = String(columnType || '').toLowerCase();

  if (normalizedColumnName.includes('title') || normalizedColumnName === 'name' || normalizedColumnName.endsWith('_name')) {
    return fallbackName;
  }

  if (normalizedColumnName.includes('description') || normalizedColumnName.includes('note')) {
    return String(exercisePayload?.description || exercisePayload?.notes || 'Auto-created training exercise').trim();
  }

  if (normalizedColumnName.includes('difficulty')) {
    return normalizeExerciseDifficultyValue(exercisePayload?.difficulty);
  }

  if (normalizedColumnName === 'club_id') {
    return resolvedClubId;
  }

  if (normalizedColumnName === 'category_id') {
    return referencedFallbackId;
  }

  if (normalizedColumnName === 'created_by' || normalizedColumnName === 'created_by_user_id' || normalizedColumnName === 'user_id') {
    const userId = Number(reqUser?.id);
    if (Number.isFinite(userId) && userId > 0) return Math.trunc(userId);
    return referencedFallbackId;
  }

  if (normalizedColumnName.endsWith('_id')) {
    return referencedFallbackId;
  }

  if (normalizedColumnName === 'is_system' || normalizedColumnName === 'is_public') {
    return 0;
  }

  if (normalizedColumnName === 'is_active') {
    return 1;
  }

  if (normalizedColumnName === 'custom_labels_json') {
    return '[]';
  }

  if (normalizedColumnName === 'sport_key') {
    return 'general';
  }

  if (normalizedColumnType.includes('int') || normalizedColumnType.includes('decimal') || normalizedColumnType.includes('float') || normalizedColumnType.includes('double')) {
    return 0;
  }

  if (normalizedColumnType.includes('tinyint(1)') || normalizedColumnType === 'boolean' || normalizedColumnType === 'bool') {
    return 0;
  }

  if (normalizedColumnType.startsWith('enum(')) {
    return parseFirstEnumValue(normalizedColumnType);
  }

  if (normalizedColumnType.includes('char') || normalizedColumnType.includes('text')) {
    return '';
  }

  return null;
};

const createFallbackExerciseRecord = async (connection, exercisePayload, options = {}) => {
  const fallbackName = String(
    exercisePayload?.title
    || exercisePayload?.name
    || ''
  ).trim();

  if (!fallbackName) return null;

  const exerciseNameColumn = await resolveExercisesNameColumn(connection);
  if (!exerciseNameColumn) return null;

  let columnsMeta;
  try {
    const [columns] = await connection.query('SHOW COLUMNS FROM exercises');
    columnsMeta = Array.isArray(columns) ? columns : [];
  } catch (error) {
    if (error?.code === 'ER_NO_SUCH_TABLE') {
      return null;
    }
    throw error;
  }

  if (!columnsMeta.length) return null;

  const reqUser = options?.reqUser || null;
  const userClubId = Number(reqUser?.club_id || reqUser?.clubId || reqUser?.clubID);
  const teamClubId = await resolveTeamClubId(connection, options?.teamId);
  const resolvedClubId = Number.isFinite(userClubId) && userClubId > 0
    ? Math.trunc(userClubId)
    : (Number.isFinite(teamClubId) && teamClubId > 0 ? Math.trunc(teamClubId) : null);

  const row = {
    [exerciseNameColumn]: fallbackName,
  };

  const availableColumnSet = new Set(columnsMeta.map((column) => String(column?.Field || '').toLowerCase()));
  const referencedIdCache = new Map();

  const getReferencedFallbackIdCached = async (columnName) => {
    const cacheKey = String(columnName || '').toLowerCase();
    if (referencedIdCache.has(cacheKey)) {
      return referencedIdCache.get(cacheKey);
    }

    try {
      const fallbackId = await resolveReferencedFallbackId(connection, 'exercises', columnName);
      referencedIdCache.set(cacheKey, fallbackId);
      return fallbackId;
    } catch {
      referencedIdCache.set(cacheKey, null);
      return null;
    }
  };

  const setIfColumnExists = (columnName, valueFactory) => {
    if (!availableColumnSet.has(String(columnName).toLowerCase())) return;
    if (row[columnName] !== undefined) return;
    const nextValue = typeof valueFactory === 'function' ? valueFactory() : valueFactory;
    if (nextValue !== undefined) {
      row[columnName] = nextValue;
    }
  };

  setIfColumnExists('description', () => String(exercisePayload?.description || exercisePayload?.notes || '').trim() || null);
  setIfColumnExists('duration_minutes', () => {
    const parsedDuration = Number(exercisePayload?.duration);
    return Number.isFinite(parsedDuration) && parsedDuration > 0 ? Math.trunc(parsedDuration) : null;
  });
  setIfColumnExists('difficulty', () => normalizeExerciseDifficultyValue(exercisePayload?.difficulty));
  setIfColumnExists('difficulty_level', () => normalizeExerciseDifficultyValue(exercisePayload?.difficulty));
  setIfColumnExists('equipment_needed', () => String(exercisePayload?.equipment || '').trim() || null);
  setIfColumnExists('required_equipment', () => String(exercisePayload?.equipment || '').trim() || null);
  setIfColumnExists('created_by_user_id', () => {
    const userId = Number(reqUser?.id);
    return Number.isFinite(userId) && userId > 0 ? Math.trunc(userId) : null;
  });
  setIfColumnExists('created_by', () => {
    const userId = Number(reqUser?.id);
    return Number.isFinite(userId) && userId > 0 ? Math.trunc(userId) : null;
  });
  setIfColumnExists('user_id', () => {
    const userId = Number(reqUser?.id);
    return Number.isFinite(userId) && userId > 0 ? Math.trunc(userId) : null;
  });
  setIfColumnExists('club_id', () => resolvedClubId);
  setIfColumnExists('is_system', 0);
  setIfColumnExists('is_public', 0);
  setIfColumnExists('is_active', 1);
  setIfColumnExists('sport_key', 'general');
  setIfColumnExists('custom_labels_json', '[]');

  if (availableColumnSet.has('category_id')) {
    const categoryFallbackId = await getReferencedFallbackIdCached('category_id');
    if (categoryFallbackId) {
      setIfColumnExists('category_id', () => categoryFallbackId);
    }
  }

  for (const column of columnsMeta) {
    const columnName = String(column?.Field || '');
    const normalizedColumnName = columnName.toLowerCase();
    const isAutoIncrement = String(column?.Extra || '').toLowerCase().includes('auto_increment');
    const isNullable = String(column?.Null || '').toUpperCase() === 'YES';
    const hasDefault = column?.Default !== null && column?.Default !== undefined;

    if (!columnName || isAutoIncrement) continue;
    if (row[columnName] !== undefined) continue;
    if (isNullable || hasDefault) continue;

    const referencedFallbackId = await getReferencedFallbackIdCached(columnName);

    const fallbackValue = buildFallbackValueForRequiredExerciseColumn({
      columnName,
      columnType: column?.Type,
      fallbackName,
      reqUser,
      resolvedClubId,
      exercisePayload,
      referencedFallbackId,
    });

    if (fallbackValue === null || fallbackValue === undefined) {
      return null;
    }

    row[columnName] = fallbackValue;
  }

  const insertColumns = Object.keys(row);
  if (!insertColumns.length) return null;

  const placeholders = insertColumns.map(() => '?').join(', ');
  const insertValues = insertColumns.map((columnName) => row[columnName]);
  const insertColumnsSql = insertColumns.map((columnName) => quoteIdentifier(columnName)).join(', ');
  const [result] = await connection.query(
    `INSERT INTO exercises (${insertColumnsSql}) VALUES (${placeholders})`,
    insertValues
  );

  const insertedId = Number(result?.insertId);
  return Number.isFinite(insertedId) && insertedId > 0 ? insertedId : null;
};

const normalizeTrainingSectionKey = (exercise) => {
  const rawValue = String(
    exercise?.section
    || exercise?.section_id
    || exercise?.sectionId
    || 'main'
  ).trim().toLowerCase();

  if (['warmup', 'prep', 'preparation'].includes(rawValue)) return 'warmup';
  if (['cooldown', 'cool', 'end', 'finish'].includes(rawValue)) return 'cooldown';
  return 'main';
};

const resolveTrainingSectionOrderIndex = (sectionKey) => {
  if (sectionKey === 'warmup') return 1;
  if (sectionKey === 'main') return 2;
  return 3;
};

const resolveTrainingSectionIdForExercise = async (connection, trainingId, exercise, cache = null) => {
  const targetCache = cache && typeof cache === 'object'
    ? cache
    : { sectionIdByKey: new Map(), config: null };

  if (!(targetCache.sectionIdByKey instanceof Map)) {
    targetCache.sectionIdByKey = new Map();
  }

  const sectionKey = normalizeTrainingSectionKey(exercise);
  if (targetCache.sectionIdByKey.has(sectionKey)) {
    return targetCache.sectionIdByKey.get(sectionKey);
  }

  if (!targetCache.config) {
    targetCache.config = {
      idColumn: await resolveExistingColumn(connection, 'training_sections', ['id']),
      trainingFkColumn: await resolveExistingColumn(connection, 'training_sections', ['training_id', 'training_session_id', 'session_id']),
      sectionTypeColumn: await resolveExistingColumn(connection, 'training_sections', ['section_type', 'section', 'type', 'name']),
      orderColumn: await resolveExistingColumn(connection, 'training_sections', ['order_index', 'sequence_order', 'position']),
      durationColumn: await resolveExistingColumn(connection, 'training_sections', ['duration_minutes', 'duration']),
    };
  }

  const { idColumn, trainingFkColumn, sectionTypeColumn, orderColumn, durationColumn } = targetCache.config;
  if (!idColumn || !trainingFkColumn) return null;

  let whereSql = `${quoteIdentifier(trainingFkColumn)} = ?`;
  const whereParams = [trainingId];
  if (sectionTypeColumn) {
    whereSql += ` AND ${quoteIdentifier(sectionTypeColumn)} = ?`;
    whereParams.push(sectionKey);
  }

  const [existingRows] = await connection.query(
    `SELECT ${quoteIdentifier(idColumn)} AS id
     FROM training_sections
     WHERE ${whereSql}
     ORDER BY ${quoteIdentifier(idColumn)} ASC
     LIMIT 1`,
    whereParams
  );

  const existingId = Number(existingRows?.[0]?.id);
  if (Number.isFinite(existingId) && existingId > 0) {
    targetCache.sectionIdByKey.set(sectionKey, Math.trunc(existingId));
    return Math.trunc(existingId);
  }

  const insertColumns = [trainingFkColumn];
  const insertValues = [trainingId];

  if (sectionTypeColumn) {
    insertColumns.push(sectionTypeColumn);
    insertValues.push(sectionKey);
  }

  if (orderColumn) {
    insertColumns.push(orderColumn);
    insertValues.push(resolveTrainingSectionOrderIndex(sectionKey));
  }

  if (durationColumn) {
    insertColumns.push(durationColumn);
    insertValues.push(null);
  }

  const placeholders = insertColumns.map(() => '?').join(', ');
  const insertColumnsSql = insertColumns.map((columnName) => quoteIdentifier(columnName)).join(', ');

  const [insertResult] = await connection.query(
    `INSERT INTO training_sections (${insertColumnsSql}) VALUES (${placeholders})`,
    insertValues
  );

  const insertedId = Number(insertResult?.insertId);
  if (!Number.isFinite(insertedId) || insertedId <= 0) return null;

  targetCache.sectionIdByKey.set(sectionKey, Math.trunc(insertedId));
  return Math.trunc(insertedId);
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

const resolvePersistedExerciseId = async (connection, exercisePayload, options = {}) => {
  const rawExerciseId = String(exercisePayload?.exerciseId || '').trim();
  const parsedExerciseId = Number(rawExerciseId);

  if (Number.isFinite(parsedExerciseId) && parsedExerciseId > 0) {
    const [rows] = await connection.query(
      'SELECT id FROM exercises WHERE id = ? LIMIT 1',
      [Math.trunc(parsedExerciseId)]
    );
    if (Array.isArray(rows) && rows.length > 0) {
      return Number(rows[0].id);
    }
  }

  const fallbackName = String(
    exercisePayload?.title
    || exercisePayload?.name
    || ''
  ).trim();

  if (!fallbackName) return null;

  const exerciseNameColumn = await resolveExercisesNameColumn(connection);
  if (!exerciseNameColumn) return null;

  const [matchedByName] = await connection.query(
    `SELECT id FROM exercises WHERE LOWER(TRIM(${quoteIdentifier(exerciseNameColumn)})) = LOWER(TRIM(?)) LIMIT 1`,
    [fallbackName]
  );

  if (Array.isArray(matchedByName) && matchedByName.length > 0) {
    return Number(matchedByName[0].id);
  }

  let autoCreatedExerciseId = null;
  try {
    autoCreatedExerciseId = await createFallbackExerciseRecord(connection, exercisePayload, options);
  } catch {
    autoCreatedExerciseId = null;
  }
  if (Number.isFinite(autoCreatedExerciseId) && autoCreatedExerciseId > 0) {
    return Number(autoCreatedExerciseId);
  }

  return null;
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
    const { teamId, status, limit = 50, excludeHidden, exclude_hidden } = req.query;
    await ensureTrainingSessionScheduleColumns(db);
    const dateColumn = await resolveTrainingDateColumn(db);
    const trainingExercisesFkColumns = await resolveTrainingExercisesForeignKeyColumns(db);
    const scopedTeamIds = await getScopedTeamIds(db, req.user);
    const shouldExcludeHidden = ['1', 'true', 'yes'].includes(String(excludeHidden ?? exclude_hidden ?? '').trim().toLowerCase());

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
        ${trainingExercisesFkColumns.length > 0
    ? `(
            SELECT COUNT(*)
            FROM training_exercises tec
            WHERE ${trainingExercisesFkColumns.map((column) => `tec.${quoteIdentifier(column)} = ts.id`).join(' OR ')}
          )`
    : '0'} AS exercise_count,
        t.name as team_name,
        t.age_group
      FROM training_sessions ts
      LEFT JOIN teams t ON ts.team_id = t.id
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

    if (shouldExcludeHidden) {
      query += ' AND (ts.description IS NULL OR ts.description NOT LIKE ?)';
      params.push(`%${TRAININGS_HIDDEN_MARKER}%`);
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
    const trainingExercisesFkColumns = await resolveTrainingExercisesForeignKeyColumns(db);
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
    const exerciseNameColumn = await resolveExercisesNameColumn(db);

    const exerciseReference = buildTrainingExerciseReferenceSql(trainingExercisesFkColumns, trainingId, 'te');

    const [exercises] = trainingExercisesFkColumns.length > 0
      ? await db.query(`
          SELECT 
            te.id,
            te.sequence_order,
            te.duration_minutes,
            te.notes,
            ${exerciseNameColumn ? `e.${exerciseNameColumn} AS exercise_name` : 'NULL AS exercise_name'},
            e.description,
            e.difficulty_level,
            ec.name as category_name
          FROM training_exercises te
          JOIN exercises e ON te.exercise_id = e.id
          LEFT JOIN exercise_categories ec ON e.category_id = ec.id
          WHERE ${exerciseReference.sql}
          ORDER BY te.sequence_order
        `, exerciseReference.params)
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
        name: ex.exercise_name,
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
      const trainingExercisesSectionReference = trainingExercisesSectionMeta?.name
        ? await resolveForeignKeyReference(connection, 'training_exercises', trainingExercisesSectionMeta.name)
        : null;
      const sectionUsesTrainingSections = String(trainingExercisesSectionReference?.referencedTableName || '').toLowerCase() === 'training_sections';
      const trainingSectionResolverCache = { sectionIdByKey: new Map(), config: null };
      
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
          const persistedExerciseId = await resolvePersistedExerciseId(connection, ex, {
            reqUser: req.user,
            teamId,
          });
          if (!persistedExerciseId) {
            const exerciseLabel = String(ex?.title || ex?.name || `#${i + 1}`).trim();
            const unresolvedReferenceError = new Error(`Invalid reference - related record not found (${exerciseLabel})`);
            unresolvedReferenceError.statusCode = 400;
            unresolvedReferenceError.details = {
              exerciseLabel,
              requestedExerciseId: ex?.exerciseId || null,
            };
            throw unresolvedReferenceError;
          }

          const insertColumns = [trainingExercisesFkColumn, 'exercise_id', 'sequence_order', 'duration_minutes', 'notes'];
          const insertValues = [trainingId, persistedExerciseId, i + 1, ex.duration, ex.notes || null];

          if (trainingExercisesSectionMeta?.name) {
            let resolvedSectionValue = null;
            if (sectionUsesTrainingSections) {
              resolvedSectionValue = await resolveTrainingSectionIdForExercise(connection, trainingId, ex, trainingSectionResolverCache);
            }
            if (!Number.isFinite(Number(resolvedSectionValue)) || Number(resolvedSectionValue) <= 0) {
              resolvedSectionValue = resolveTrainingExerciseSectionValue(ex, trainingExercisesSectionMeta);
            }

            insertColumns.push(trainingExercisesSectionMeta.name);
            insertValues.push(resolvedSectionValue);
          }

          const placeholders = insertColumns.map(() => '?').join(', ');
          const insertColumnsSql = insertColumns.map((columnName) => quoteIdentifier(columnName)).join(', ');
          await connection.query(`
            INSERT INTO training_exercises 
            (${insertColumnsSql})
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

// DELETE /api/trainings/:id - Hide training in trainings module, keep planner/evidence data
router.delete('/:id', authenticateToken, requireRole(['club', 'coach']), async (req, res, next) => {
  try {
    const trainingId = Number(req.params.id);
    if (!Number.isFinite(trainingId) || trainingId <= 0) {
      return res.status(400).json({ error: 'Invalid training id' });
    }

    const connection = await db.getConnection();
    try {
      await connection.beginTransaction();

      const [rows] = await connection.query(
        'SELECT description FROM training_sessions WHERE id = ? LIMIT 1',
        [trainingId]
      );

      if (!Array.isArray(rows) || rows.length === 0) {
        await connection.rollback();
        return res.status(404).json({ error: 'Training not found' });
      }

      const currentDescription = String(rows[0]?.description || '');
      const alreadyHidden = currentDescription.includes(TRAININGS_HIDDEN_MARKER);
      const nextDescription = alreadyHidden
        ? currentDescription
        : (currentDescription.trim()
          ? `${currentDescription}\n${TRAININGS_HIDDEN_MARKER}`
          : TRAININGS_HIDDEN_MARKER);

      const [result] = await connection.query(
        'UPDATE training_sessions SET description = ? WHERE id = ?',
        [nextDescription, trainingId]
      );

      if (!result?.affectedRows) {
        await connection.rollback();
        return res.status(404).json({ error: 'Training not found' });
      }

      await connection.commit();
      res.json({ id: trainingId, message: 'Training session hidden from trainings list' });
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
    const trainingExercisesFkColumns = await resolveTrainingExercisesForeignKeyColumns(db);
    const access = await ensureTrainingAccess(db, req.user, trainingId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Training not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto tréningu' });
    }

    const exerciseNameColumn = await resolveExercisesNameColumn(db);

    const exerciseReference = buildTrainingExerciseReferenceSql(trainingExercisesFkColumns, trainingId, 'te');

    const [exercises] = trainingExercisesFkColumns.length > 0
      ? await db.query(`
          SELECT 
            te.id,
            te.sequence_order,
            te.duration_minutes,
            te.notes,
            e.id as exercise_id,
            ${exerciseNameColumn ? `e.${exerciseNameColumn} AS exercise_name` : 'NULL AS exercise_name'},
            e.description,
            e.difficulty_level,
            e.required_equipment,
            ec.name as category_name
          FROM training_exercises te
          JOIN exercises e ON te.exercise_id = e.id
          LEFT JOIN exercise_categories ec ON e.category_id = ec.id
          WHERE ${exerciseReference.sql}
          ORDER BY te.sequence_order
        `, exerciseReference.params)
      : [[]];
    
    res.json({
      total: exercises.length,
      exercises: exercises.map(ex => ({
        id: ex.id,
        exerciseId: ex.exercise_id,
        name: ex.exercise_name,
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
