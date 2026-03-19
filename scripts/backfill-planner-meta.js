require('dotenv').config();
const db = require('../config/database');

const PLANNER_META_MARKER = '[[PLANNER_META]]';

const normalize = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase();

const inferSessionType = (title, fallbackSessionType = '') => {
  const sourceType = String(fallbackSessionType || '').trim().toLowerCase();
  if (sourceType) return sourceType;

  const haystack = normalize(title);
  if (/\b(turnaj|tournament|cup)\b/.test(haystack)) return 'tournament';
  if (/\b(zapas|zapasy|match|friendly|triangel)\b/.test(haystack)) return 'match';
  if (/\b(zrusen|zrusena|cancel)\b/.test(haystack)) return 'friendly_match';
  return 'training';
};

const indicatorFromSessionType = (sessionType) => {
  const normalized = String(sessionType || '').trim().toLowerCase();
  if (normalized === 'match') return 'PZ';
  if (normalized === 'friendly_match') return 'MZ';
  if (normalized === 'tournament') return 'CUP';
  return 'TJ';
};

const extractPlannerMetaFromDescription = (rawDescription) => {
  const source = String(rawDescription || '');
  const markerIndex = source.indexOf(PLANNER_META_MARKER);
  if (markerIndex === -1) {
    return { cleanDescription: source, plannerMeta: {} };
  }

  const cleanDescription = source.slice(0, markerIndex).replace(/\s+$/g, '');
  const rawMeta = source.slice(markerIndex + PLANNER_META_MARKER.length).trim();
  try {
    const parsed = JSON.parse(rawMeta);
    return {
      cleanDescription,
      plannerMeta: parsed && typeof parsed === 'object' ? parsed : {},
    };
  } catch {
    return { cleanDescription: source, plannerMeta: {} };
  }
};

const parseMaybeJson = (raw) => {
  if (raw == null) return {};
  if (typeof raw === 'object') return raw;
  const text = String(raw || '').trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
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

const main = async () => {
  const connection = await db.getConnection();
  try {
    const [columns] = await connection.query('SHOW COLUMNS FROM training_sessions');
    const available = new Set(columns.map((col) => String(col.Field || '').toLowerCase()));

    const selectColumns = ['id', 'title', 'description'];
    if (available.has('session_type')) selectColumns.push('session_type');
    if (available.has('recurrence_rule')) selectColumns.push('recurrence_rule');
    if (available.has('indicator_code')) selectColumns.push('indicator_code');

    const [rows] = await connection.query(`SELECT ${selectColumns.join(', ')} FROM training_sessions`);

    let processed = 0;
    let updated = 0;

    await connection.beginTransaction();

    for (const row of rows) {
      processed += 1;
      const extracted = extractPlannerMetaFromDescription(row.description);
      const existingMeta = extracted.plannerMeta || {};
      const recurrenceMeta = parseMaybeJson(row.recurrence_rule);

      const sessionType = String(
        existingMeta.sessionType
        || row.session_type
        || recurrenceMeta.sessionType
        || recurrenceMeta.session_type
        || ''
      ).trim().toLowerCase();

      const indicatorCode = String(
        existingMeta.indicatorCode
        || row.indicator_code
        || recurrenceMeta.indicatorCode
        || ''
      ).trim().toUpperCase();

      const resolvedSessionType = inferSessionType(row.title, sessionType);
      const resolvedIndicatorCode = indicatorCode || indicatorFromSessionType(resolvedSessionType);

      const nextMeta = {
        ...recurrenceMeta,
        ...existingMeta,
        sessionType: resolvedSessionType,
        indicatorCode: resolvedIndicatorCode,
      };

      const nextDescription = buildDescriptionWithPlannerMeta(extracted.cleanDescription, nextMeta);
      const previousDescription = row.description == null ? null : String(row.description);
      const normalizedNext = nextDescription == null ? null : String(nextDescription);

      if (previousDescription === normalizedNext) {
        continue;
      }

      await connection.query(
        'UPDATE training_sessions SET description = ? WHERE id = ?',
        [normalizedNext, row.id]
      );
      updated += 1;
    }

    await connection.commit();
    console.log(`Backfill completed. Processed: ${processed}, Updated: ${updated}`);
  } catch (error) {
    await connection.rollback();
    console.error('Backfill failed:', error.message);
    throw error;
  } finally {
    connection.release();
  }
};

main()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
