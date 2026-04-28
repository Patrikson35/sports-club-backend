const path = require('path');
const XLSX = require('xlsx');
const mysql = require('mysql2/promise');
require('dotenv').config();

const NAME_ALIASES = {
  timotej: 'timko',
  timo: 'timko',
  matko: 'matko',
  misko: 'misko'
};

function parseArgs(argv) {
  const args = {
    file: '',
    club: 'Stars Academy',
    sheet: 'CELKOM SEZONA',
    season: '',
    timelineType: 'season',
    timelineLabel: '',
    timelineKey: '',
    month: '',
    apply: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--file') args.file = String(argv[i + 1] || '');
    if (token === '--club') args.club = String(argv[i + 1] || '');
    if (token === '--sheet') args.sheet = String(argv[i + 1] || '');
    if (token === '--season') args.season = String(argv[i + 1] || '');
    if (token === '--timeline-type') args.timelineType = String(argv[i + 1] || 'season');
    if (token === '--timeline-label') args.timelineLabel = String(argv[i + 1] || '');
    if (token === '--timeline-key') args.timelineKey = String(argv[i + 1] || '');
    if (token === '--month') args.month = String(argv[i + 1] || '');
    if (token === '--apply') args.apply = true;
  }

  return args;
}

function normalizeTimelineToken(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function resolveTimelineMeta(args) {
  const normalizedType = String(args.timelineType || 'season').trim().toLowerCase();

  if (normalizedType === 'season') {
    return {
      type: 'season',
      key: String(args.timelineKey || 'summary').trim() || 'summary',
      label: String(args.timelineLabel || 'Súhrn sezóny').trim() || 'Súhrn sezóny',
      monthIndex: null
    };
  }

  if (normalizedType === 'period') {
    const label = String(args.timelineLabel || args.sheet || 'Obdobie').trim() || 'Obdobie';
    const generatedKey = `period-${normalizeTimelineToken(label)}`;
    return {
      type: 'period',
      key: String(args.timelineKey || generatedKey).trim() || generatedKey,
      label,
      monthIndex: null
    };
  }

  if (normalizedType === 'month') {
    const monthNumber = Number(args.month);
    if (!Number.isInteger(monthNumber) || monthNumber < 1 || monthNumber > 12) {
      throw new Error('For --timeline-type month you must provide --month value from 1 to 12');
    }

    const zeroBasedMonth = monthNumber - 1;
    const generatedKey = `month-${zeroBasedMonth}`;
    const generatedLabel = String(args.timelineLabel || `Mesiac ${monthNumber}`).trim() || `Mesiac ${monthNumber}`;

    return {
      type: 'month',
      key: String(args.timelineKey || generatedKey).trim() || generatedKey,
      label: generatedLabel,
      monthIndex: zeroBasedMonth
    };
  }

  throw new Error('Invalid --timeline-type. Allowed values: season, period, month');
}

function normalizeText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeFirstName(value) {
  const normalized = normalizeText(value);
  return NAME_ALIASES[normalized] || normalized;
}

function toPlayerKeyFromFullName(fullName) {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return '';
  const firstName = normalizeFirstName(tokens[0]);
  const lastName = normalizeText(tokens.slice(1).join(' '));
  if (!firstName || !lastName) return '';
  return `${lastName}|${firstName}`;
}

function toPlayerKeyFromDb(firstName, lastName) {
  const left = normalizeText(lastName);
  const right = normalizeFirstName(firstName);
  if (!left || !right) return '';
  return `${left}|${right}`;
}

function toNumberOrNull(value) {
  const source = String(value ?? '').trim();
  if (!source) return null;
  const normalized = source.replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function isSkippableName(value) {
  const n = normalizeText(value);
  return !n || n === '0' || n === 'druzstvo' || n === 'meno' || n === 'jmeno' || n === 'dop.' || n === 'odp.';
}

function buildHeaderIndexMap(headerRow) {
  const map = new Map();
  (Array.isArray(headerRow) ? headerRow : []).forEach((cell, index) => {
    const normalized = normalizeText(cell);
    if (!normalized) return;
    if (!map.has(normalized)) map.set(normalized, index);
  });
  return map;
}

function parseRowsBySheetLayout(rows) {
  const row2 = Array.isArray(rows?.[1]) ? rows[1] : [];
  const row4 = Array.isArray(rows?.[3]) ? rows[3] : [];

  const row2HeaderMap = buildHeaderIndexMap(row2);
  const row4HeaderMap = buildHeaderIndexMap(row4);

  const isLegacySummaryLayout = row2HeaderMap.has('dz/min') && row2HeaderMap.has('tj/min') && row2HeaderMap.has('hz/min');
  const isMonthlyLayout = row4HeaderMap.has('kd') && row4HeaderMap.has('dz') && row4HeaderMap.has('tj') && row4HeaderMap.has('hz');

  if (isLegacySummaryLayout) {
    const parsedRows = [];
    for (let index = 3; index < rows.length; index += 1) {
      const row = Array.isArray(rows[index]) ? rows[index] : [];
      const fullName = String(row[0] || '').trim();
      if (isSkippableName(fullName)) continue;

      parsedRows.push({
        rowNumber: index + 1,
        fullName,
        key: toPlayerKeyFromFullName(fullName),
        dzCount: toNumberOrNull(row[1]),
        dzMinutes: toNumberOrNull(row[2]),
        tjCount: toNumberOrNull(row[3]),
        tjMinutes: toNumberOrNull(row[4]),
        pzCount: toNumberOrNull(row[6]),
        pzMinutes: toNumberOrNull(row[7]),
        mzCount: toNumberOrNull(row[8]),
        mzMinutes: toNumberOrNull(row[9]),
        rzMinutes: toNumberOrNull(row[10]),
        hzMinutes: toNumberOrNull(row[11]),
        hzPercent: toNumberOrNull(row[12])
      });
    }

    return parsedRows;
  }

  if (isMonthlyLayout) {
    const idxDz = row4HeaderMap.get('dz');
    const idxTj = row4HeaderMap.get('tj');
    const idxTh = row4HeaderMap.get('th');
    const idxPocz = row4HeaderMap.get('poc. z');
    const idxCz = row4HeaderMap.get('cz');
    const idxHz = row4HeaderMap.get('hz');
    const idxRz = row4HeaderMap.get('rz');
    const idxPercent = row4HeaderMap.get('%');

    const idxPzCount = Number.isInteger(idxPocz) ? idxPocz : -1;
    const idxMzCount = Number.isInteger(idxPocz) ? idxPocz + 1 : -1;
    const idxPzMinutes = Number.isInteger(idxCz) ? idxCz : -1;
    const idxMzMinutes = Number.isInteger(idxCz) ? idxCz + 1 : -1;

    const parsedRows = [];
    for (let index = 6; index < rows.length; index += 1) {
      const row = Array.isArray(rows[index]) ? rows[index] : [];
      const fullName = String(row[0] || '').trim();
      if (isSkippableName(fullName)) continue;

      parsedRows.push({
        rowNumber: index + 1,
        fullName,
        key: toPlayerKeyFromFullName(fullName),
        dzCount: idxDz >= 0 ? toNumberOrNull(row[idxDz]) : null,
        dzMinutes: null,
        tjCount: idxTj >= 0 ? toNumberOrNull(row[idxTj]) : null,
        tjMinutes: idxTh >= 0 ? toNumberOrNull(row[idxTh]) : null,
        // Monthly sheets store PZ/MZ split in adjacent cells next to Poč.Z and ČZ.
        pzCount: idxPzCount >= 0 ? toNumberOrNull(row[idxPzCount]) : null,
        pzMinutes: idxPzMinutes >= 0 ? toNumberOrNull(row[idxPzMinutes]) : null,
        mzCount: idxMzCount >= 0 ? toNumberOrNull(row[idxMzCount]) : null,
        mzMinutes: idxMzMinutes >= 0 ? toNumberOrNull(row[idxMzMinutes]) : null,
        rzMinutes: idxRz >= 0 ? toNumberOrNull(row[idxRz]) : null,
        hzMinutes: idxHz >= 0 ? toNumberOrNull(row[idxHz]) : null,
        hzPercent: idxPercent >= 0 ? toNumberOrNull(row[idxPercent]) : null
      });
    }

    return parsedRows;
  }

  throw new Error('Unsupported sheet layout. Expected either summary layout (DZ/min) or monthly layout (KD/DZ/TJ/TH/Poč. Z/HZ).');
}

async function ensureSummaryTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS player_season_summaries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      user_id INT NOT NULL,
      season VARCHAR(32) NOT NULL,
      source_file VARCHAR(255) NULL,
      sheet_name VARCHAR(128) NULL,
      dz_count INT NULL,
      dz_minutes INT NULL,
      tj_count INT NULL,
      tj_minutes INT NULL,
      pz_count INT NULL,
      pz_minutes INT NULL,
      mz_count INT NULL,
      mz_minutes INT NULL,
      rz_minutes INT NULL,
      hz_minutes INT NULL,
      hz_percent DECIMAL(8,6) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_club_user_season (club_id, user_id, season),
      INDEX idx_summary_club (club_id),
      INDEX idx_summary_user (user_id),
      INDEX idx_summary_season (season)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

async function ensureTimelineSummaryTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS player_timeline_summaries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      user_id INT NOT NULL,
      season VARCHAR(32) NOT NULL,
      timeline_type VARCHAR(16) NOT NULL,
      timeline_key VARCHAR(64) NOT NULL,
      timeline_label VARCHAR(120) NULL,
      month_index TINYINT NULL,
      source_file VARCHAR(255) NULL,
      sheet_name VARCHAR(128) NULL,
      dz_count INT NULL,
      dz_minutes INT NULL,
      tj_count INT NULL,
      tj_minutes INT NULL,
      pz_count INT NULL,
      pz_minutes INT NULL,
      mz_count INT NULL,
      mz_minutes INT NULL,
      rz_minutes INT NULL,
      hz_minutes INT NULL,
      hz_percent DECIMAL(8,6) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_club_user_timeline (club_id, user_id, season, timeline_type, timeline_key),
      INDEX idx_timeline_club (club_id),
      INDEX idx_timeline_season (season),
      INDEX idx_timeline_key (timeline_type, timeline_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

async function ensureAttendanceSeasonsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS attendance_seasons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      name VARCHAR(120) NOT NULL,
      from_date VARCHAR(10) NOT NULL,
      to_date VARCHAR(10) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_attendance_seasons_club (club_id),
      INDEX idx_attendance_seasons_name (name)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

function normalizeSeasonLabel(rawValue) {
  const matched = String(rawValue || '').trim().match(/^(\d{4})\s*\/\s*(\d{4})$/);
  if (!matched) return '';

  const startYear = Number(matched[1]);
  const endYear = Number(matched[2]);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || endYear !== (startYear + 1)) {
    return '';
  }

  return `${startYear}/${endYear}`;
}

async function ensureImportedSeasonVisible(connection, clubId, seasonLabel) {
  const normalizedSeason = normalizeSeasonLabel(seasonLabel);
  if (!normalizedSeason) return;

  await ensureAttendanceSeasonsTable(connection);

  const [existingRows] = await connection.query(
    'SELECT id FROM attendance_seasons WHERE club_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
    [clubId, normalizedSeason]
  );

  if (Array.isArray(existingRows) && existingRows.length > 0) return;

  await connection.query(
    'INSERT INTO attendance_seasons (club_id, name, from_date, to_date) VALUES (?, ?, ?, ?)',
    [clubId, normalizedSeason, '01.07', '30.06']
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const timeline = resolveTimelineMeta(args);

  if (!args.file) {
    throw new Error('Missing --file <xlsx_path>');
  }

  if (!args.season) {
    throw new Error('Missing --season <value>, for example --season 2024/2025');
  }

  const workbook = XLSX.readFile(args.file, { cellDates: false });
  const sheet = workbook.Sheets[args.sheet];
  if (!sheet) {
    throw new Error(`Sheet "${args.sheet}" was not found in workbook.`);
  }

  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    raw: false,
    defval: ''
  });

  const excelRows = parseRowsBySheetLayout(rows);

  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    const [clubs] = await connection.query(
      'SELECT id, name FROM clubs WHERE LOWER(name) = LOWER(?) ORDER BY id DESC LIMIT 1',
      [args.club]
    );

    if (!clubs.length) {
      throw new Error(`Club "${args.club}" was not found.`);
    }

    const clubId = Number(clubs[0].id);

    const [players] = await connection.query(
      `SELECT DISTINCT u.id AS userId, u.first_name AS firstName, u.last_name AS lastName
       FROM users u
       JOIN team_memberships tm ON tm.user_id = u.id AND tm.is_active = TRUE
       JOIN teams t ON t.id = tm.team_id
       WHERE t.club_id = ?`,
      [clubId]
    );

    const playerMap = new Map();
    players.forEach((player) => {
      const key = toPlayerKeyFromDb(player.firstName, player.lastName);
      if (!key) return;
      if (!playerMap.has(key)) playerMap.set(key, []);
      playerMap.get(key).push(player);
    });

    const matched = [];
    const missing = [];
    const ambiguous = [];

    excelRows.forEach((entry) => {
      const candidates = playerMap.get(entry.key) || [];
      if (candidates.length === 1) {
        matched.push({
          ...entry,
          userId: Number(candidates[0].userId),
          dbName: `${String(candidates[0].firstName || '').trim()} ${String(candidates[0].lastName || '').trim()}`
        });
        return;
      }

      if (candidates.length > 1) {
        ambiguous.push({
          excelName: entry.fullName,
          candidates: candidates.map((item) => `${item.firstName} ${item.lastName} (#${item.userId})`)
        });
        return;
      }

      missing.push(entry.fullName);
    });

    const report = {
      mode: args.apply ? 'apply' : 'dry-run',
      club: clubs[0].name,
      clubId,
      season: args.season,
      timelineType: timeline.type,
      timelineKey: timeline.key,
      timelineLabel: timeline.label,
      timelineMonthIndex: timeline.monthIndex,
      sourceFile: path.basename(args.file),
      sheet: args.sheet,
      excelRows: excelRows.length,
      dbPlayers: players.length,
      matchedCount: matched.length,
      missingCount: missing.length,
      ambiguousCount: ambiguous.length,
      matched: matched.map((item) => ({
        excelName: item.fullName,
        dbName: item.dbName,
        userId: item.userId
      })),
      missing,
      ambiguous
    };

    if (!args.apply) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    await ensureSummaryTable(connection);
    await ensureTimelineSummaryTable(connection);
    if (timeline.type === 'season') {
      await ensureImportedSeasonVisible(connection, clubId, args.season);
    }

    for (const row of matched) {
      if (timeline.type === 'season') {
        await connection.query(
          `INSERT INTO player_season_summaries (
            club_id, user_id, season, source_file, sheet_name,
            dz_count, dz_minutes, tj_count, tj_minutes,
            pz_count, pz_minutes, mz_count, mz_minutes,
            rz_minutes, hz_minutes, hz_percent
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON DUPLICATE KEY UPDATE
            source_file = VALUES(source_file),
            sheet_name = VALUES(sheet_name),
            dz_count = VALUES(dz_count),
            dz_minutes = VALUES(dz_minutes),
            tj_count = VALUES(tj_count),
            tj_minutes = VALUES(tj_minutes),
            pz_count = VALUES(pz_count),
            pz_minutes = VALUES(pz_minutes),
            mz_count = VALUES(mz_count),
            mz_minutes = VALUES(mz_minutes),
            rz_minutes = VALUES(rz_minutes),
            hz_minutes = VALUES(hz_minutes),
            hz_percent = VALUES(hz_percent)`,
          [
            clubId,
            row.userId,
            args.season,
            path.basename(args.file),
            args.sheet,
            row.dzCount,
            row.dzMinutes,
            row.tjCount,
            row.tjMinutes,
            row.pzCount,
            row.pzMinutes,
            row.mzCount,
            row.mzMinutes,
            row.rzMinutes,
            row.hzMinutes,
            row.hzPercent
          ]
        );
      }

      await connection.query(
        `INSERT INTO player_timeline_summaries (
          club_id, user_id, season, timeline_type, timeline_key, timeline_label, month_index,
          source_file, sheet_name,
          dz_count, dz_minutes, tj_count, tj_minutes,
          pz_count, pz_minutes, mz_count, mz_minutes,
          rz_minutes, hz_minutes, hz_percent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          timeline_label = VALUES(timeline_label),
          month_index = VALUES(month_index),
          source_file = VALUES(source_file),
          sheet_name = VALUES(sheet_name),
          dz_count = VALUES(dz_count),
          dz_minutes = VALUES(dz_minutes),
          tj_count = VALUES(tj_count),
          tj_minutes = VALUES(tj_minutes),
          pz_count = VALUES(pz_count),
          pz_minutes = VALUES(pz_minutes),
          mz_count = VALUES(mz_count),
          mz_minutes = VALUES(mz_minutes),
          rz_minutes = VALUES(rz_minutes),
          hz_minutes = VALUES(hz_minutes),
          hz_percent = VALUES(hz_percent)`,
        [
          clubId,
          row.userId,
          args.season,
          timeline.type,
          timeline.key,
          timeline.label,
          timeline.monthIndex,
          path.basename(args.file),
          args.sheet,
          row.dzCount,
          row.dzMinutes,
          row.tjCount,
          row.tjMinutes,
          row.pzCount,
          row.pzMinutes,
          row.mzCount,
          row.mzMinutes,
          row.rzMinutes,
          row.hzMinutes,
          row.hzPercent
        ]
      );
    }

    console.log(JSON.stringify({
      ...report,
      importedCount: matched.length
    }, null, 2));
  } finally {
    await connection.end();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});
