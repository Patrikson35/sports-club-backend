const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const path = require('path');
const multer = require('multer');
const XLSX = require('xlsx');

const attendanceImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const normalizeSportKey = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || null;
};

const normalizeClubLogoPath = (value) => {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (raw.startsWith('/uploads/')) {
    return `/api${raw}`;
  }
  return raw;
};

const ensureClubSportColumn = async (connection = db) => {
  try {
    await connection.query('ALTER TABLE clubs ADD COLUMN sport VARCHAR(64) NULL');
  } catch (error) {
    if (error?.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }
};

const ensureSportFieldTypesTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS sport_field_types (
      id INT AUTO_INCREMENT PRIMARY KEY,
      sport_key VARCHAR(64) NOT NULL,
      type_key VARCHAR(64) NOT NULL,
      type_label VARCHAR(255) NOT NULL,
      sort_order INT NOT NULL DEFAULT 0,
      is_active BOOLEAN DEFAULT TRUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_sport_type (sport_key, type_key),
      INDEX idx_sport_key (sport_key),
      INDEX idx_sport_active (sport_key, is_active)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const resolveUserClubId = async (userId) => {
  try {
    const [owned] = await db.query('SELECT id FROM clubs WHERE owner_id = ? LIMIT 1', [userId]);
    if (owned.length) return owned[0].id;
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      throw error;
    }
  }

  try {
    const [viaUser] = await db.query('SELECT club_id FROM users WHERE id = ? LIMIT 1', [userId]);
    if (viaUser.length && viaUser[0].club_id) return viaUser[0].club_id;
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      throw error;
    }
  }

  const [member] = await db.query(
    `SELECT club_id
     FROM club_members
     WHERE user_id = ? AND is_active = TRUE
     ORDER BY id ASC
     LIMIT 1`,
    [userId]
  );

  if (member.length) return member[0].club_id;

  const [users] = await db.query('SELECT role FROM users WHERE id = ? LIMIT 1', [userId]);
  const userRole = String(users?.[0]?.role || '').trim().toLowerCase();
  if (userRole !== 'admin') {
    return null;
  }

  const [adminOwned] = await db.query('SELECT id FROM clubs WHERE owner_id = ? ORDER BY id ASC LIMIT 1', [userId]);
  if (adminOwned.length) {
    return adminOwned[0].id;
  }

  const clubsColumns = await getClubsTableColumnSet();
  const insertColumns = ['name'];
  const insertValues = ['Web Admin Workspace'];

  if (clubsColumns.has('owner_id')) {
    insertColumns.push('owner_id');
    insertValues.push(userId);
  }

  if (clubsColumns.has('country')) {
    insertColumns.push('country');
    insertValues.push('SK');
  }

  if (clubsColumns.has('email')) {
    insertColumns.push('email');
    insertValues.push('');
  }

  if (clubsColumns.has('phone')) {
    insertColumns.push('phone');
    insertValues.push('');
  }

  if (clubsColumns.has('website')) {
    insertColumns.push('website');
    insertValues.push('');
  }

  if (clubsColumns.has('created_at')) {
    insertColumns.push('created_at');
    insertValues.push(new Date());
  }

  const placeholders = insertColumns.map(() => '?').join(', ');
  const [created] = await db.query(
    `INSERT INTO clubs (${insertColumns.join(', ')}) VALUES (${placeholders})`,
    insertValues
  );

  return created.insertId || null;
};

const getClubsTableColumnSet = async () => {
  const [columns] = await db.query('SHOW COLUMNS FROM clubs');
  return new Set(columns.map((column) => column.Field));
};

const createClubWithCompatibleColumns = async ({
  userId,
  name,
  sport,
  logo,
  address,
  city,
  country,
  email,
  phone,
  website,
  bankName,
  swiftCode,
  accountHolderName,
  iban
}) => {
  const clubsColumns = await getClubsTableColumnSet();
  const columnNames = ['name'];
  const values = [name];

  if (clubsColumns.has('sport')) {
    columnNames.push('sport');
    values.push(sport || null);
  }
  if (clubsColumns.has('logo_url')) {
    columnNames.push('logo_url');
    values.push(logo || '');
  }
  if (clubsColumns.has('address')) {
    columnNames.push('address');
    values.push(address || '');
  }
  if (clubsColumns.has('city')) {
    columnNames.push('city');
    values.push(city || '');
  }
  if (clubsColumns.has('country')) {
    columnNames.push('country');
    values.push(country || 'SK');
  }
  if (clubsColumns.has('email')) {
    columnNames.push('email');
    values.push(email || '');
  }
  if (clubsColumns.has('phone')) {
    columnNames.push('phone');
    values.push(phone || '');
  }
  if (clubsColumns.has('website')) {
    columnNames.push('website');
    values.push(website || '');
  }
  if (clubsColumns.has('bank_name')) {
    columnNames.push('bank_name');
    values.push(bankName || '');
  }
  if (clubsColumns.has('swift_code')) {
    columnNames.push('swift_code');
    values.push(swiftCode || '');
  }
  if (clubsColumns.has('account_holder_name')) {
    columnNames.push('account_holder_name');
    values.push(accountHolderName || '');
  }
  if (clubsColumns.has('iban')) {
    columnNames.push('iban');
    values.push(iban || '');
  }
  if (clubsColumns.has('owner_id')) {
    columnNames.push('owner_id');
    values.push(userId);
  }
  if (clubsColumns.has('created_at')) {
    columnNames.push('created_at');
    values.push(new Date());
  }

  const placeholders = columnNames.map(() => '?').join(', ');
  const sql = `INSERT INTO clubs (${columnNames.join(', ')}) VALUES (${placeholders})`;
  const [result] = await db.query(sql, values);
  return result;
};

const ensureUsersVirtualColumn = async (connection = db) => {
  const addColumnIfMissing = async (statement) => {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await addColumnIfMissing('ALTER TABLE users ADD COLUMN is_virtual BOOLEAN DEFAULT FALSE');
  await addColumnIfMissing('ALTER TABLE users ADD COLUMN phone VARCHAR(50) NULL');
  await addColumnIfMissing('ALTER TABLE users ADD COLUMN avatar_url VARCHAR(500) NULL');
};

const ensurePlayerProfilesTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS player_profiles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL UNIQUE,
      club_name VARCHAR(255) NULL,
      personal_id VARCHAR(100) NOT NULL,
      photo_url VARCHAR(500) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
};

const ensureClubBankingColumns = async (connection = db) => {
  const addColumnIfMissing = async (statement) => {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN bank_name VARCHAR(255) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN swift_code VARCHAR(100) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN account_holder_name VARCHAR(255) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN iban VARCHAR(100) NULL');
};

const ensureClubContactColumns = async (connection = db) => {
  const addColumnIfMissing = async (statement) => {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN email VARCHAR(255) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN phone VARCHAR(50) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN website VARCHAR(255) NULL');
};

const ensureClubLocationColumns = async (connection = db) => {
  const addColumnIfMissing = async (statement) => {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN address VARCHAR(255) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN city VARCHAR(100) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN country VARCHAR(100) NULL');
};

const ensureClubAttendanceDisplaySettingsColumn = async (connection = db) => {
  const addColumnIfMissing = async (statement) => {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN attendance_display_settings LONGTEXT NULL');
};

const ensureClubTrainingExerciseDisplaySettingsColumn = async (connection = db) => {
  const addColumnIfMissing = async (statement) => {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN training_exercise_display_settings LONGTEXT NULL');
};

const ensureClubCustomDataColumns = async (connection = db) => {
  const addColumnIfMissing = async (statement) => {
    try {
      await connection.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN training_divisions_json LONGTEXT NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN exercise_categories_json LONGTEXT NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN exercise_items_json LONGTEXT NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN evidence_entries_json LONGTEXT NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN evidence_session_meta_json LONGTEXT NULL');
};

const parseAttendanceDisplaySettings = (rawValue) => {
  if (!rawValue) return {};

  try {
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const parseJsonSettingsObject = (rawValue) => {
  if (!rawValue) return {};

  try {
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
};

const parseJsonSettingsArray = (rawValue) => {
  if (!rawValue) return [];

  try {
    const parsed = typeof rawValue === 'string' ? JSON.parse(rawValue) : rawValue;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const normalizeTrainingDivisionsArray = (rawValue) => {
  const parsed = Array.isArray(rawValue) ? rawValue : parseJsonSettingsArray(rawValue);
  return parsed
    .map((item, index) => {
      const name = String(item?.name || '').trim();
      const id = String(item?.id || `division-${index + 1}`).trim();
      const groups = Array.isArray(item?.groups)
        ? item.groups.map((groupName) => String(groupName || '').trim()).filter(Boolean)
        : [];

      return {
        id,
        name,
        groups: [...new Set(groups)]
      };
    })
    .filter((item) => item.id && item.name);
};

const resolveTrainingDivisionsTemplate = async (connection = db) => {
  let rows = [];

  try {
    const [result] = await connection.query(
      `SELECT training_divisions_json
       FROM clubs
       WHERE training_divisions_json IS NOT NULL
         AND TRIM(training_divisions_json) <> ''
         AND TRIM(training_divisions_json) <> '[]'
       ORDER BY updated_at DESC, id DESC`
    );
    rows = result;
  } catch (error) {
    if (error?.code === 'ER_BAD_FIELD_ERROR') {
      const [result] = await connection.query(
        `SELECT training_divisions_json
         FROM clubs
         WHERE training_divisions_json IS NOT NULL
           AND TRIM(training_divisions_json) <> ''
           AND TRIM(training_divisions_json) <> '[]'
         ORDER BY id DESC`
      );
      rows = result;
    } else {
      throw error;
    }
  }

  for (const row of rows) {
    const normalized = normalizeTrainingDivisionsArray(row?.training_divisions_json);
    if (normalized.length > 0) {
      return normalized;
    }
  }

  return [];
};

const applyTrainingDivisionsDefaultToMissingClubs = async (connection = db, divisions = []) => {
  const normalized = normalizeTrainingDivisionsArray(divisions);
  if (normalized.length === 0) return 0;

  const [result] = await connection.query(
    `UPDATE clubs
     SET training_divisions_json = ?
     WHERE training_divisions_json IS NULL
        OR TRIM(training_divisions_json) = ''
        OR TRIM(training_divisions_json) = '[]'`,
    [JSON.stringify(normalized)]
  );

  return Number(result?.affectedRows || 0);
};

const ensureTrainingDivisionsDefaultForAllClubs = async (connection = db) => {
  await ensureClubCustomDataColumns(connection);
  const template = await resolveTrainingDivisionsTemplate(connection);
  if (template.length === 0) return 0;
  return applyTrainingDivisionsDefaultToMissingClubs(connection, template);
};

const normalizeTeamIds = (input) => {
  if (!Array.isArray(input)) return [];
  return [...new Set(
    input
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  )];
};

const normalizeTrainerFunctionRole = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return ['assistant', 'coach'].includes(normalized) ? normalized : 'coach';
};

const assignTrainerCategories = async (connection, clubId, trainerUserId, categoryIds, functionRole = 'coach') => {
  if (functionRole !== 'coach') {
    await connection.query(
      `UPDATE teams
       SET coach_id = NULL,
           updated_at = NOW()
       WHERE club_id = ?
         AND coach_id = ?
         AND is_active = TRUE`,
      [clubId, trainerUserId]
    );

    return [];
  }

  const normalizedCategoryIds = normalizeTeamIds(categoryIds);

  const [clubTeams] = await connection.query(
    `SELECT id
     FROM teams
     WHERE club_id = ? AND is_active = TRUE`,
    [clubId]
  );

  const clubTeamIds = clubTeams.map((row) => Number(row.id));
  const clubTeamIdSet = new Set(clubTeamIds);

  const validCategoryIds = normalizedCategoryIds.filter((id) => clubTeamIdSet.has(id));
  const validCategoryIdSet = new Set(validCategoryIds);

  await connection.query(
    `UPDATE teams
     SET coach_id = NULL,
         updated_at = NOW()
     WHERE club_id = ?
       AND coach_id = ?
       AND is_active = TRUE`,
    [clubId, trainerUserId]
  );

  if (validCategoryIds.length > 0) {
    await connection.query(
      `UPDATE teams
       SET coach_id = ?,
           updated_at = NOW()
       WHERE club_id = ?
         AND is_active = TRUE
         AND id IN (${validCategoryIds.map(() => '?').join(',')})`,
      [trainerUserId, clubId, ...validCategoryIds]
    );
  }

  return validCategoryIds;
};

const assignPlayerCategories = async (connection, clubId, playerUserId, categoryIds) => {
  const normalizedCategoryIds = normalizeTeamIds(categoryIds);

  if (normalizedCategoryIds.length === 0) return [];

  const [clubTeams] = await connection.query(
    `SELECT id
     FROM teams
     WHERE club_id = ?
       AND is_active = TRUE
       AND id IN (${normalizedCategoryIds.map(() => '?').join(',')})`,
    [clubId, ...normalizedCategoryIds]
  );

  const validCategoryIds = clubTeams
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (validCategoryIds.length === 0) return [];

  await Promise.all(
    validCategoryIds.map((teamId) =>
      connection.query(
        `INSERT INTO team_memberships (team_id, user_id, joined_date, is_active, created_at)
         VALUES (?, ?, CURDATE(), TRUE, NOW())
         ON DUPLICATE KEY UPDATE
           is_active = TRUE,
           left_date = NULL`,
        [teamId, playerUserId]
      )
    )
  );

  return validCategoryIds;
};

const syncPlayerCategories = async (connection, clubId, playerUserId, categoryIds) => {
  const normalizedCategoryIds = normalizeTeamIds(categoryIds);

  const [clubTeams] = await connection.query(
    `SELECT id
     FROM teams
     WHERE club_id = ?
       AND is_active = TRUE`,
    [clubId]
  );

  const clubTeamIds = clubTeams
    .map((row) => Number(row.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const clubTeamIdSet = new Set(clubTeamIds);
  const selectedTeamIds = normalizedCategoryIds.filter((id) => clubTeamIdSet.has(id));

  if (clubTeamIds.length > 0) {
    if (selectedTeamIds.length > 0) {
      await connection.query(
        `UPDATE team_memberships
         SET is_active = FALSE,
             left_date = CURDATE()
         WHERE user_id = ?
           AND team_id IN (${clubTeamIds.map(() => '?').join(',')})
           AND team_id NOT IN (${selectedTeamIds.map(() => '?').join(',')})
           AND is_active = TRUE`,
        [playerUserId, ...clubTeamIds, ...selectedTeamIds]
      );
    } else {
      await connection.query(
        `UPDATE team_memberships
         SET is_active = FALSE,
             left_date = CURDATE()
         WHERE user_id = ?
           AND team_id IN (${clubTeamIds.map(() => '?').join(',')})
           AND is_active = TRUE`,
        [playerUserId, ...clubTeamIds]
      );
    }
  }

  if (selectedTeamIds.length > 0) {
    await Promise.all(
      selectedTeamIds.map((teamId) =>
        connection.query(
          `INSERT INTO team_memberships (team_id, user_id, joined_date, is_active, created_at)
           VALUES (?, ?, CURDATE(), TRUE, NOW())
           ON DUPLICATE KEY UPDATE
             is_active = TRUE,
             left_date = NULL`,
          [teamId, playerUserId]
        )
      )
    );
  }

  return selectedTeamIds;
};

// GET /api/clubs/my-club - Získať klub aktuálneho používateľa
router.get('/my-club', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await ensureClubBankingColumns(db);
    await ensureClubLocationColumns(db);
    await ensureClubContactColumns(db);
    await ensureClubSportColumn(db);
    await ensureClubCustomDataColumns(db);
    await ensureClubAttendanceDisplaySettingsColumn(db);
    await ensureTrainingDivisionsDefaultForAllClubs(db);

    const clubId = await resolveUserClubId(userId);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const [clubs] = await db.query(
      `SELECT id, name, address, city, country, email, phone, website, logo_url, sport,
              bank_name, swift_code, account_holder_name, iban,
              attendance_display_settings,
              training_divisions_json, exercise_categories_json, exercise_items_json,
              evidence_entries_json, evidence_session_meta_json
       FROM clubs
       WHERE id = ?
       LIMIT 1`,
      [clubId]
    );

    if (clubs.length === 0) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const club = clubs[0];

    res.json({
      id: club.id,
      name: club.name,
      address: club.address || '',
      city: club.city || '',
      country: club.country || 'SK',
      email: club.email || '',
      phone: club.phone || '',
      website: club.website || '',
      logo: normalizeClubLogoPath(club.logo_url || club.logo || ''),
      bankName: club.bank_name || '',
      swiftCode: club.swift_code || '',
      accountHolderName: club.account_holder_name || '',
      iban: club.iban || '',
      sport: normalizeSportKey(club.sport) || normalizeSportKey(req.user?.sport) || '',
      attendanceDisplaySettings: parseAttendanceDisplaySettings(club.attendance_display_settings),
      trainingDivisions: parseJsonSettingsArray(club.training_divisions_json),
      exerciseCategories: parseJsonSettingsArray(club.exercise_categories_json),
      exerciseDatabaseItems: parseJsonSettingsArray(club.exercise_items_json),
      evidenceEntries: parseJsonSettingsObject(club.evidence_entries_json),
      evidenceSessionMeta: parseJsonSettingsObject(club.evidence_session_meta_json),
      ownerFirstName: req.user?.firstName || '',
      ownerLastName: req.user?.lastName || '',
      ownerEmail: req.user?.email || ''
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/clubs/my-club/field-types - Preddefinované typy ihrísk podľa športu klubu
router.get('/my-club/field-types', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await ensureClubSportColumn(db);
    await ensureSportFieldTypesTable(db);

    const clubId = await resolveUserClubId(userId);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const [clubs] = await db.query(
      `SELECT c.id, c.sport, u.sport AS owner_sport
       FROM clubs c
       LEFT JOIN users u ON u.id = c.owner_id
       WHERE c.id = ?
       LIMIT 1`,
      [clubId]
    );

    if (clubs.length === 0) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const sportKey = normalizeSportKey(clubs[0].sport) || normalizeSportKey(clubs[0].owner_sport);
    if (!sportKey) {
      return res.json({ sport: '', types: [] });
    }

    const [types] = await db.query(
      `SELECT type_key, type_label
       FROM sport_field_types
       WHERE sport_key = ?
         AND is_active = TRUE
       ORDER BY sort_order ASC, type_label ASC`,
      [sportKey]
    );

    res.json({
      sport: sportKey,
      types: types.map((item) => ({
        key: String(item.type_key || '').trim(),
        label: String(item.type_label || '').trim()
      })).filter((item) => item.key && item.label)
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/clubs/my-club/members - Získať členov aktuálneho klubu
router.get('/my-club/members', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    const clubId = await resolveUserClubId(userId);

    await ensureUsersVirtualColumn(db);
    await ensurePlayerProfilesTable(db);

    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    let members;
    try {
      const [rows] = await db.query(
        `SELECT
           cm.user_id,
           cm.member_role,
           u.first_name,
           u.last_name,
           u.email,
           u.phone,
           u.avatar_url,
           u.is_verified,
           u.is_virtual,
           u.role,
           pp.personal_id,
           pp.photo_url
         FROM club_members cm
         JOIN users u ON u.id = cm.user_id
         LEFT JOIN player_profiles pp ON pp.user_id = u.id
         WHERE cm.club_id = ?
           AND cm.is_active = TRUE
         ORDER BY u.role, u.last_name, u.first_name`,
        [clubId]
      );
      members = rows;
    } catch (error) {
      if (error?.code !== 'ER_BAD_FIELD_ERROR') {
        throw error;
      }

      const [rows] = await db.query(
        `SELECT
           cm.user_id,
           cm.member_role,
           u.first_name,
           u.last_name,
           u.email,
           u.is_virtual,
           u.role
         FROM club_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.club_id = ?
           AND cm.is_active = TRUE
         ORDER BY u.role, u.last_name, u.first_name`,
        [clubId]
      );

      members = rows.map((row) => ({
        ...row,
        phone: '',
        avatar_url: null,
        is_verified: true,
        personal_id: '',
        photo_url: null
      }));
    }

    const normalizeRole = (role) => (role === 'club_admin' ? 'club' : role);

    const playerIds = members
      .filter((member) => normalizeRole(member.role) === 'player')
      .map((member) => Number(member.user_id))
      .filter((id) => Number.isInteger(id) && id > 0);

    const playerCategoriesById = new Map();
    if (playerIds.length > 0) {
      try {
        const [playerCategories] = await db.query(
          `SELECT tm.user_id, t.id AS team_id, t.name AS team_name
           FROM team_memberships tm
           JOIN teams t ON t.id = tm.team_id
           WHERE tm.is_active = TRUE
             AND t.is_active = TRUE
             AND tm.user_id IN (${playerIds.map(() => '?').join(',')})`,
          playerIds
        );

        playerCategories.forEach((row) => {
          const userId = Number(row.user_id);
          if (!playerCategoriesById.has(userId)) {
            playerCategoriesById.set(userId, []);
          }
          playerCategoriesById.get(userId).push({
            id: Number(row.team_id),
            name: row.team_name
          });
        });
      } catch (error) {
        if (error?.code !== 'ER_BAD_FIELD_ERROR') {
          throw error;
        }
      }
    }

    const trainers = members
      .filter((member) => ['coach', 'assistant'].includes(normalizeRole(member.role)))
      .map((member) => ({
        userId: member.user_id,
        firstName: member.first_name,
        lastName: member.last_name,
        email: member.email,
        mobile: member.phone || '',
        photo: member.avatar_url || '',
        isVerified: Boolean(member.is_verified),
        isVirtual: Boolean(member.is_virtual),
        role: normalizeRole(member.role)
      }));

    const players = members
      .filter((member) => normalizeRole(member.role) === 'player')
      .map((member) => ({
        userId: member.user_id,
        firstName: member.first_name,
        lastName: member.last_name,
        email: member.is_virtual ? '' : member.email,
        mobile: member.phone || '',
        photo: member.photo_url || member.avatar_url || '',
        personalId: member.personal_id || '',
        isVerified: Boolean(member.is_verified),
        isVirtual: Boolean(member.is_virtual),
        categories: playerCategoriesById.get(Number(member.user_id)) || [],
        role: 'player'
      }));

    res.json({
      clubId,
      trainers,
      players,
      totals: {
        trainers: trainers.length,
        players: players.length
      }
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/clubs/my-club/trainers - pridať trénera do klubu
router.post('/my-club/trainers', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie pridávať trénerov' });
    }

    await ensureUsersVirtualColumn(connection);

    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const email = String(req.body?.email || '').trim().toLowerCase();
    const mobile = String(req.body?.mobile || '').trim();
    const photo = req.body?.photo ? String(req.body.photo).trim() : null;
    const categoryIds = normalizeTeamIds(req.body?.categories);
    const functionRole = normalizeTrainerFunctionRole(req.body?.functionRole);

    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Meno aj priezvisko trénera sú povinné' });
    }

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Platný e-mail trénera je povinný' });
    }

    const [existingEmail] = await connection.query(
      'SELECT id FROM users WHERE email = ? LIMIT 1',
      [email]
    );

    if (existingEmail.length) {
      return res.status(400).json({ error: 'Používateľ s týmto e-mailom už existuje' });
    }

    await connection.beginTransaction();

    const [userInsert] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, phone, avatar_url, is_virtual, is_active, is_verified, created_at)
       VALUES (?, '', ?, ?, 'coach', ?, ?, TRUE, TRUE, FALSE, NOW())`,
      [email, firstName, lastName, mobile || null, photo || null]
    );

    const trainerUserId = userInsert.insertId;

    await connection.query(
      `UPDATE users
       SET role = ?
       WHERE id = ?`,
      [functionRole, trainerUserId]
    );

    await connection.query(
      `INSERT INTO club_members (club_id, user_id, member_role, added_by, is_active)
       VALUES (?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE
         member_role = VALUES(member_role),
         is_active = TRUE,
         left_at = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [clubId, trainerUserId, functionRole, req.user.id]
    );

    const assignedCategories = await assignTrainerCategories(connection, clubId, trainerUserId, categoryIds, functionRole);

    await connection.commit();

    res.status(201).json({
      message: 'Tréner bol pridaný',
      trainer: {
        userId: trainerUserId,
        firstName,
        lastName,
        email,
        mobile,
        photo: photo || '',
        role: functionRole,
        isVirtual: true,
        isVerified: false,
        categories: assignedCategories
      }
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // no-op
    }
    next(error);
  } finally {
    connection.release();
  }
});

// POST /api/clubs/my-club/players - pridať hráča do klubu
router.post('/my-club/players', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie pridávať hráčov' });
    }

    await ensureUsersVirtualColumn(connection);
    await ensurePlayerProfilesTable(connection);

    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const firstName = String(req.body?.firstName || '').trim();
    const lastName = String(req.body?.lastName || '').trim();
    const rawEmail = String(req.body?.email || '').trim();
    const email = rawEmail.toLowerCase();
    const mobile = String(req.body?.mobile || '').trim();
    const personalId = String(req.body?.personalId || '').trim();
    const photo = req.body?.photo ? String(req.body.photo).trim() : null;
    const categoryIds = normalizeTeamIds(req.body?.categories);

    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Meno aj priezvisko hráča sú povinné' });
    }

    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Zadaný e-mail hráča nie je platný' });
    }

    if (email) {
      const [existingEmail] = await connection.query(
        'SELECT id FROM users WHERE email = ? LIMIT 1',
        [email]
      );

      if (existingEmail.length) {
        return res.status(400).json({ error: 'Používateľ s týmto e-mailom už existuje' });
      }
    }

    const generatedEmail = `virtual.player.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}@imaginar.local`;
    const storedEmail = email || generatedEmail;
    const isVerified = false;
    const isVirtual = !(Boolean(rawEmail) && isVerified);

    await connection.beginTransaction();

    const [userInsert] = await connection.query(
      `INSERT INTO users (email, password_hash, first_name, last_name, role, phone, avatar_url, is_virtual, is_active, is_verified, created_at)
       VALUES (?, '', ?, ?, 'player', ?, ?, ?, TRUE, ?, NOW())`,
      [storedEmail, firstName, lastName, mobile || null, photo || null, isVirtual, isVerified]
    );

    const playerUserId = userInsert.insertId;

    await connection.query(
      `INSERT INTO player_profiles (user_id, personal_id, photo_url)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         personal_id = VALUES(personal_id),
         photo_url = VALUES(photo_url),
         updated_at = CURRENT_TIMESTAMP`,
      [playerUserId, personalId || '', photo || null]
    );

    await connection.query(
      `INSERT INTO club_members (club_id, user_id, member_role, added_by, is_active)
       VALUES (?, ?, 'player', ?, TRUE)
       ON DUPLICATE KEY UPDATE
         member_role = VALUES(member_role),
         is_active = TRUE,
         left_at = NULL,
         updated_at = CURRENT_TIMESTAMP`,
      [clubId, playerUserId, req.user.id]
    );

    const assignedCategories = await assignPlayerCategories(connection, clubId, playerUserId, categoryIds);

    await connection.commit();

    res.status(201).json({
      message: 'Hráč bol pridaný',
      player: {
        userId: playerUserId,
        firstName,
        lastName,
        email: rawEmail || '',
        mobile,
        personalId,
        photo: photo || '',
        role: 'player',
        isVirtual,
        isVerified,
        categories: assignedCategories
      }
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // no-op
    }
    next(error);
  } finally {
    connection.release();
  }
});

// PUT /api/clubs/my-club/players/:userId - upraviť hráča v klube
router.put('/my-club/players/:userId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie upravovať hráčov' });
    }

    await ensureUsersVirtualColumn(connection);
    await ensurePlayerProfilesTable(connection);

    const playerUserId = Number(req.params.userId);
    if (!Number.isInteger(playerUserId) || playerUserId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID hráča' });
    }

    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const [rows] = await connection.query(
      `SELECT
         u.id,
         u.email,
         u.first_name,
         u.last_name,
         u.phone,
         u.avatar_url,
         u.is_virtual,
         u.is_verified,
         pp.personal_id,
         pp.photo_url
       FROM users u
       JOIN club_members cm ON cm.user_id = u.id
       LEFT JOIN player_profiles pp ON pp.user_id = u.id
       WHERE cm.club_id = ?
         AND cm.user_id = ?
         AND cm.is_active = TRUE
         AND cm.member_role = 'player'
       LIMIT 1`,
      [clubId, playerUserId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Hráč nebol nájdený v tomto klube' });
    }

    const player = rows[0];
    const firstName = String(req.body?.firstName ?? player.first_name).trim();
    const lastName = String(req.body?.lastName ?? player.last_name).trim();
    const rawEmail = req.body?.email !== undefined ? String(req.body.email || '').trim() : (Boolean(player.is_virtual) ? '' : String(player.email || '').trim());
    const email = rawEmail.toLowerCase();
    const mobile = String(req.body?.mobile ?? player.phone ?? '').trim();
    const personalId = String(req.body?.personalId ?? player.personal_id ?? '').trim();
    const photo = req.body?.photo !== undefined ? String(req.body.photo || '').trim() : String(player.photo_url || player.avatar_url || '').trim();
    const categoryIds = Array.isArray(req.body?.categories) ? req.body.categories : [];

    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Meno aj priezvisko hráča sú povinné' });
    }

    if (email && !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Zadaný e-mail hráča nie je platný' });
    }

    if (email) {
      const [existingEmail] = await connection.query(
        'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1',
        [email, playerUserId]
      );

      if (existingEmail.length) {
        return res.status(400).json({ error: 'Zadaný e-mail už používa iný používateľ' });
      }
    }

    const generatedEmail = `virtual.player.${Date.now()}.${Math.floor(Math.random() * 1_000_000)}@imaginar.local`;
    const storedEmail = email || generatedEmail;
    const isVerified = Boolean(player.is_verified);
    const isVirtual = !(Boolean(rawEmail) && isVerified);

    await connection.beginTransaction();

    await connection.query(
      `UPDATE users
       SET first_name = ?,
           last_name = ?,
           email = ?,
           phone = ?,
           avatar_url = ?,
           is_virtual = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [firstName, lastName, storedEmail, mobile || null, photo || null, isVirtual, playerUserId]
    );

    await connection.query(
      `INSERT INTO player_profiles (user_id, personal_id, photo_url)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         personal_id = VALUES(personal_id),
         photo_url = VALUES(photo_url),
         updated_at = CURRENT_TIMESTAMP`,
      [playerUserId, personalId || '', photo || null]
    );

    const assignedCategories = await syncPlayerCategories(connection, clubId, playerUserId, categoryIds);

    await connection.commit();

    res.json({
      message: 'Hráč bol úspešne upravený',
      player: {
        userId: playerUserId,
        firstName,
        lastName,
        email: rawEmail || '',
        mobile,
        personalId,
        photo: photo || '',
        role: 'player',
        isVirtual,
        isVerified,
        categories: assignedCategories
      }
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // no-op
    }
    next(error);
  } finally {
    connection.release();
  }
});

// DELETE /api/clubs/my-club/players/:userId - odobrať hráča z klubu (bez zmazania používateľa)
router.delete('/my-club/players/:userId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie odoberať hráčov' });
    }

    const playerUserId = Number(req.params.userId);
    if (!Number.isInteger(playerUserId) || playerUserId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID hráča' });
    }

    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const [rows] = await connection.query(
      `SELECT cm.id
       FROM club_members cm
       WHERE cm.club_id = ?
         AND cm.user_id = ?
         AND cm.is_active = TRUE
         AND cm.member_role = 'player'
       LIMIT 1`,
      [clubId, playerUserId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Hráč nebol nájdený v tomto klube' });
    }

    await connection.beginTransaction();

    await connection.query(
      `UPDATE club_members
       SET is_active = FALSE,
           left_at = NOW(),
           updated_at = NOW()
       WHERE club_id = ?
         AND user_id = ?
         AND member_role = 'player'`,
      [clubId, playerUserId]
    );

    await connection.query(
      `UPDATE team_memberships tm
       JOIN teams t ON t.id = tm.team_id
       SET tm.is_active = FALSE,
           tm.left_date = CURDATE()
       WHERE tm.user_id = ?
         AND tm.is_active = TRUE
         AND t.club_id = ?`,
      [playerUserId, clubId]
    );

    await connection.commit();

    res.json({ message: 'Hráč bol odobratý z klubu' });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // no-op
    }
    next(error);
  } finally {
    connection.release();
  }
});

// PUT /api/clubs/my-club/trainers/:userId - upraviť trénera a prípadne konvertovať virtuálneho
router.put('/my-club/trainers/:userId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie upravovať trénerov' });
    }

    const trainerUserId = Number(req.params.userId);
    if (!Number.isInteger(trainerUserId) || trainerUserId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID trénera' });
    }

    await ensureUsersVirtualColumn(connection);

    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

        const [rows] = await connection.query(
      `SELECT
         u.id,
         u.email,
         u.first_name,
         u.last_name,
          u.phone,
          u.avatar_url,
         u.password_hash,
         u.is_virtual,
         u.is_verified,
         cm.member_role
       FROM users u
       JOIN club_members cm ON cm.user_id = u.id
       WHERE cm.club_id = ?
         AND cm.user_id = ?
         AND cm.is_active = TRUE
         AND cm.member_role IN ('coach', 'assistant')
       LIMIT 1`,
      [clubId, trainerUserId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Tréner nebol nájdený v tomto klube' });
    }

    const trainer = rows[0];
    const firstName = String(req.body?.firstName ?? trainer.first_name).trim();
    const lastName = String(req.body?.lastName ?? trainer.last_name).trim();
    const email = String(req.body?.email ?? trainer.email).trim().toLowerCase();
    const mobile = String(req.body?.mobile ?? trainer.phone ?? '').trim();
    const photo = req.body?.photo !== undefined ? String(req.body.photo || '').trim() : String(trainer.avatar_url || '').trim();
    const hasCategoriesInput = Array.isArray(req.body?.categories);
    const categoryIds = hasCategoriesInput ? normalizeTeamIds(req.body.categories) : null;
    const functionRole = req.body?.functionRole !== undefined
      ? normalizeTrainerFunctionRole(req.body.functionRole)
      : normalizeTrainerFunctionRole(trainer.member_role);
    const convertToReal = Boolean(req.body?.convertToReal);

    if (!firstName || !lastName) {
      return res.status(400).json({ error: 'Meno aj priezvisko trénera sú povinné' });
    }

    if (!email || !/^\S+@\S+\.\S+$/.test(email)) {
      return res.status(400).json({ error: 'Platný e-mail trénera je povinný' });
    }

    const [existingEmail] = await connection.query(
      'SELECT id FROM users WHERE email = ? AND id != ? LIMIT 1',
      [email, trainerUserId]
    );

    if (existingEmail.length) {
      return res.status(400).json({ error: 'Zadaný e-mail už používa iný používateľ' });
    }

    let passwordHashToSet = trainer.password_hash;
    let isVirtualToSet = Boolean(trainer.is_virtual);
    const isVerified = Boolean(trainer.is_verified);

    if (convertToReal && Boolean(trainer.is_virtual)) {
      if (!passwordHashToSet) {
        passwordHashToSet = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);
      }
      isVirtualToSet = !isVerified;
    }

    await connection.beginTransaction();

    await connection.query(
      `UPDATE users
       SET first_name = ?,
           last_name = ?,
           email = ?,
           phone = ?,
           avatar_url = ?,
           role = ?,
           password_hash = ?,
           is_virtual = ?,
           updated_at = NOW()
       WHERE id = ?`,
      [firstName, lastName, email, mobile || null, photo || null, functionRole, passwordHashToSet, isVirtualToSet, trainerUserId]
    );

    await connection.query(
      `UPDATE club_members
       SET member_role = ?,
           updated_at = NOW()
       WHERE club_id = ?
         AND user_id = ?
         AND is_active = TRUE
         AND member_role IN ('coach', 'assistant')`,
      [functionRole, clubId, trainerUserId]
    );

    let assignedCategories = null;
    if (hasCategoriesInput) {
      assignedCategories = await assignTrainerCategories(connection, clubId, trainerUserId, categoryIds, functionRole);
    }

    await connection.commit();

    res.json({
      message: convertToReal && Boolean(trainer.is_virtual)
        ? (isVerified
          ? 'Tréner bol upravený a prevedený na reálneho'
          : 'Tréner bol upravený, ostáva imaginárny, kým nepotvrdí registračný e-mail')
        : 'Tréner bol úspešne upravený',
      trainer: {
        userId: trainerUserId,
        firstName,
        lastName,
        email,
        mobile,
        photo,
        role: functionRole,
        isVirtual: isVirtualToSet,
        isVerified,
        categories: assignedCategories
      }
    });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // no-op
    }
    next(error);
  } finally {
    connection.release();
  }
});

// DELETE /api/clubs/my-club/trainers/:userId - odobrať trénera z klubu
router.delete('/my-club/trainers/:userId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie odoberať trénerov' });
    }

    const trainerUserId = Number(req.params.userId);
    if (!Number.isInteger(trainerUserId) || trainerUserId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID trénera' });
    }

    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const [rows] = await connection.query(
      `SELECT cm.id
       FROM club_members cm
       WHERE cm.club_id = ?
         AND cm.user_id = ?
         AND cm.is_active = TRUE
         AND cm.member_role IN ('coach', 'assistant')
       LIMIT 1`,
      [clubId, trainerUserId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Tréner nebol nájdený v tomto klube' });
    }

    await connection.beginTransaction();

    await connection.query(
      `UPDATE club_members
       SET is_active = FALSE,
           left_at = NOW(),
           updated_at = NOW()
       WHERE club_id = ? AND user_id = ? AND member_role IN ('coach', 'assistant')`,
      [clubId, trainerUserId]
    );

    await connection.query(
      `UPDATE teams
       SET coach_id = NULL,
           updated_at = NOW()
       WHERE club_id = ? AND coach_id = ?`,
      [clubId, trainerUserId]
    );

    await connection.commit();

    res.json({ message: 'Tréner bol odobratý z klubu' });
  } catch (error) {
    try {
      await connection.rollback();
    } catch (rollbackError) {
      // no-op
    }
    next(error);
  } finally {
    connection.release();
  }
});

// GET /api/clubs - Get all clubs
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    let clubs = [];

    try {
      const [rows] = await db.query(`
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
      clubs = rows;
    } catch (error) {
      if (error?.code === 'ER_BAD_FIELD_ERROR' || error?.code === 'ER_NO_SUCH_TABLE') {
        const [rows] = await db.query(`
          SELECT
            c.*,
            0 AS team_count,
            0 AS player_count
          FROM clubs c
          ORDER BY c.id DESC
        `);
        clubs = rows;
      } else {
        throw error;
      }
    }

    res.json({
      total: clubs.length,
      clubs: clubs
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/clubs - Create new club
router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await ensureClubBankingColumns(db);
    await ensureClubLocationColumns(db);
    await ensureClubContactColumns(db);
    await ensureClubSportColumn(db);
    const { name, logo, address, city, country, email, phone, website, bankName, swiftCode, accountHolderName, iban } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Názov klubu je povinný' });
    }

    // Skontrolovať, či používateľ už nemá klub (owner_id / users.club_id / club_members fallback).
    const existingClubId = await resolveUserClubId(userId);
    if (existingClubId) {
      return res.status(400).json({ error: 'Používateľ už má vytvorený klub' });
    }

    const [users] = await db.query('SELECT sport FROM users WHERE id = ? LIMIT 1', [userId]);
    const fallbackSport = users.length > 0 ? normalizeSportKey(users[0].sport) : null;
    const resolvedSport = normalizeSportKey(req.body?.sport) || fallbackSport;

    const result = await createClubWithCompatibleColumns({
      userId,
      name,
      sport: resolvedSport,
      logo,
      address,
      city,
      country,
      email,
      phone,
      website,
      bankName,
      swiftCode,
      accountHolderName,
      iban
    });

    const clubId = result.insertId;

    // Aktualizovať používateľa - priradiť mu club_id (ak stĺpec existuje).
    try {
      await db.query(
        'UPDATE users SET club_id = ? WHERE id = ?',
        [clubId, userId]
      );
    } catch (error) {
      if (!error || error.code !== 'ER_BAD_FIELD_ERROR') {
        throw error;
      }
    }

    // Fallback membership link for schemas relying on club_members.
    try {
      await db.query(
        `INSERT INTO club_members (club_id, user_id, member_role, added_by, is_active)
         VALUES (?, ?, 'club_admin', ?, TRUE)
         ON DUPLICATE KEY UPDATE
           member_role = VALUES(member_role),
           added_by = VALUES(added_by),
           is_active = TRUE`,
        [clubId, userId, userId]
      );
    } catch (error) {
      if (!error || error.code !== 'ER_BAD_FIELD_ERROR') {
        throw error;
      }

      await db.query(
        `INSERT INTO club_members (club_id, user_id, member_role)
         VALUES (?, ?, 'club_admin')
         ON DUPLICATE KEY UPDATE member_role = VALUES(member_role)`,
        [clubId, userId]
      );
    }

    res.status(201).json({
      message: 'Klub bol úspešne vytvorený',
      clubId: clubId
    });
  } catch (error) {
    next(error);
  }
});

// ─── CLUB FIELDS (IHRISKÁ) ───────────────────────────────────────────────────

const ensureClubFieldsTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS club_fields (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      surface_type VARCHAR(100) NOT NULL,
      dimensions VARCHAR(100) NOT NULL,
      parts_total INT NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_club_fields_club (club_id),
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const normalizeFieldRow = (row) => ({
  id: row.id,
  name: row.name,
  surfaceType: row.surface_type,
  dimensions: row.dimensions,
  partsTotal: row.parts_total,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

// GET /api/clubs/my-club/fields
router.get('/my-club/fields', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubFieldsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const [rows] = await db.query(
      'SELECT * FROM club_fields WHERE club_id = ? ORDER BY created_at ASC',
      [clubId]
    );
    res.json({ total: rows.length, fields: rows.map(normalizeFieldRow) });
  } catch (error) { next(error); }
});

// POST /api/clubs/my-club/fields
router.post('/my-club/fields', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubFieldsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const { name, surfaceType, dimensions, partsTotal } = req.body;
    if (!name || !surfaceType || !dimensions || !partsTotal) {
      return res.status(400).json({ error: 'Chýbajú povinné polia.' });
    }

    const [result] = await db.query(
      'INSERT INTO club_fields (club_id, name, surface_type, dimensions, parts_total) VALUES (?, ?, ?, ?, ?)',
      [clubId, name.trim(), surfaceType.trim(), dimensions.trim(), Number(partsTotal)]
    );

    const [[created]] = await db.query('SELECT * FROM club_fields WHERE id = ?', [result.insertId]);
    res.status(201).json({ message: 'Ihrisko bolo uložené', field: normalizeFieldRow(created) });
  } catch (error) { next(error); }
});

// PUT /api/clubs/my-club/fields/:fieldId
router.put('/my-club/fields/:fieldId', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubFieldsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const { fieldId } = req.params;
    const { name, surfaceType, dimensions, partsTotal } = req.body;

    await db.query(
      'UPDATE club_fields SET name = ?, surface_type = ?, dimensions = ?, parts_total = ?, updated_at = NOW() WHERE id = ? AND club_id = ?',
      [name.trim(), surfaceType.trim(), dimensions.trim(), Number(partsTotal), fieldId, clubId]
    );

    const [[updated]] = await db.query('SELECT * FROM club_fields WHERE id = ? AND club_id = ?', [fieldId, clubId]);
    if (!updated) return res.status(404).json({ error: 'Ihrisko nenájdené' });
    res.json({ message: 'Ihrisko bolo upravené', field: normalizeFieldRow(updated) });
  } catch (error) { next(error); }
});

// DELETE /api/clubs/my-club/fields/:fieldId
router.delete('/my-club/fields/:fieldId', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubFieldsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const { fieldId } = req.params;
    await db.query('DELETE FROM club_fields WHERE id = ? AND club_id = ?', [fieldId, clubId]);
    res.json({ message: 'Ihrisko bolo odstránené' });
  } catch (error) { next(error); }
});

// ─── ATTENDANCE SEASONS (SEZÓNY DOCHÁDZKY) ───────────────────────────────────

const ensureAttendanceSeasonsTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS attendance_seasons (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      name VARCHAR(255) NOT NULL,
      from_date VARCHAR(10) NOT NULL,
      to_date VARCHAR(10) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      INDEX idx_attendance_seasons_club (club_id),
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const ensurePlayerSeasonSummariesTable = async (connection = db) => {
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const ensurePlayerTimelineSummariesTable = async (connection = db) => {
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const ensurePlayerTimelineDailyEntriesTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS player_timeline_daily_entries (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      user_id INT NOT NULL,
      season VARCHAR(32) NOT NULL,
      timeline_type VARCHAR(16) NOT NULL,
      timeline_key VARCHAR(64) NOT NULL,
      timeline_label VARCHAR(120) NULL,
      month_index TINYINT NULL,
      date_key DATE NOT NULL,
      day_of_month TINYINT NOT NULL,
      metric_code VARCHAR(16) NOT NULL,
      minutes INT NOT NULL,
      source_file VARCHAR(255) NULL,
      sheet_name VARCHAR(128) NULL,
      source_row_index INT NULL,
      source_column_index INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_club_user_timeline_day_col (club_id, user_id, season, timeline_type, timeline_key, date_key, source_column_index),
      INDEX idx_daily_club (club_id),
      INDEX idx_daily_season (season),
      INDEX idx_daily_timeline (timeline_type, timeline_key),
      INDEX idx_daily_date (date_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};

const ATTENDANCE_IMPORT_NAME_ALIASES = {
  timotej: 'timko',
  timo: 'timko',
  matko: 'matko',
  misko: 'misko'
};

const ATTENDANCE_IMPORT_MONTH_SHEETS = [
  { monthNumber: 1, labels: ['januar', 'january'] },
  { monthNumber: 2, labels: ['februar', 'february'] },
  { monthNumber: 3, labels: ['marec', 'march'] },
  { monthNumber: 4, labels: ['april'] },
  { monthNumber: 5, labels: ['maj', 'may'] },
  { monthNumber: 6, labels: ['jun', 'june'] },
  { monthNumber: 7, labels: ['jul', 'july'] },
  { monthNumber: 8, labels: ['august'] },
  { monthNumber: 9, labels: ['september'] },
  { monthNumber: 10, labels: ['oktober', 'october'] },
  { monthNumber: 11, labels: ['november'] },
  { monthNumber: 12, labels: ['december'] }
];

const attendanceImportNormalizeText = (value) => String(value || '')
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .trim()
  .replace(/\s+/g, ' ');

const attendanceImportNormalizeFirstName = (value) => {
  const normalized = attendanceImportNormalizeText(value);
  return ATTENDANCE_IMPORT_NAME_ALIASES[normalized] || normalized;
};

const attendanceImportPlayerKeyFromFullName = (fullName) => {
  const tokens = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return '';
  const firstName = attendanceImportNormalizeFirstName(tokens[0]);
  const lastName = attendanceImportNormalizeText(tokens.slice(1).join(' '));
  if (!firstName || !lastName) return '';
  return `${lastName}|${firstName}`;
};

const attendanceImportPlayerKeyFromDb = (firstName, lastName) => {
  const left = attendanceImportNormalizeText(lastName);
  const right = attendanceImportNormalizeFirstName(firstName);
  if (!left || !right) return '';
  return `${left}|${right}`;
};

const attendanceImportToNumberOrNull = (value) => {
  const source = String(value ?? '').trim();
  if (!source) return null;
  const normalized = source
    .replace(/\s+/g, '')
    .replace('%', '')
    .replace(',', '.');
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
};

const attendanceImportToPercentForStorage = (value) => {
  const numeric = attendanceImportToNumberOrNull(value);
  if (!Number.isFinite(numeric) || numeric < 0) return null;
  return numeric > 1 ? (numeric / 100) : numeric;
};

const attendanceImportIsSkippableName = (value) => {
  const n = attendanceImportNormalizeText(value);
  return !n || n === '0' || n === 'druzstvo' || n === 'meno' || n === 'jmeno' || n === 'dop.' || n === 'odp.';
};

const attendanceImportBuildHeaderIndexMap = (headerRow) => {
  const map = new Map();
  (Array.isArray(headerRow) ? headerRow : []).forEach((cell, index) => {
    const normalized = attendanceImportNormalizeText(cell);
    if (!normalized || map.has(normalized)) return;
    map.set(normalized, index);
  });
  return map;
};

const attendanceImportParseSummaryRowsBySheetLayout = (rows) => {
  const row2 = Array.isArray(rows?.[1]) ? rows[1] : [];
  const row4 = Array.isArray(rows?.[3]) ? rows[3] : [];
  const row2HeaderMap = attendanceImportBuildHeaderIndexMap(row2);
  const row4HeaderMap = attendanceImportBuildHeaderIndexMap(row4);

  const isLegacySummaryLayout = row2HeaderMap.has('dz/min') && row2HeaderMap.has('tj/min') && row2HeaderMap.has('hz/min');
  const isMonthlyLayout = row4HeaderMap.has('kd') && row4HeaderMap.has('dz') && row4HeaderMap.has('tj') && row4HeaderMap.has('hz');

  if (isLegacySummaryLayout) {
    const parsedRows = [];
    for (let index = 3; index < rows.length; index += 1) {
      const row = Array.isArray(rows[index]) ? rows[index] : [];
      const fullName = String(row[0] || '').trim();
      if (attendanceImportIsSkippableName(fullName)) continue;

      parsedRows.push({
        rowNumber: index + 1,
        fullName,
        key: attendanceImportPlayerKeyFromFullName(fullName),
        dzCount: attendanceImportToNumberOrNull(row[1]),
        dzMinutes: attendanceImportToNumberOrNull(row[2]),
        tjCount: attendanceImportToNumberOrNull(row[3]),
        tjMinutes: attendanceImportToNumberOrNull(row[4]),
        pzCount: attendanceImportToNumberOrNull(row[6]),
        pzMinutes: attendanceImportToNumberOrNull(row[7]),
        mzCount: attendanceImportToNumberOrNull(row[8]),
        mzMinutes: attendanceImportToNumberOrNull(row[9]),
        rzMinutes: attendanceImportToNumberOrNull(row[10]),
        hzMinutes: attendanceImportToNumberOrNull(row[11]),
        hzPercent: attendanceImportToPercentForStorage(row[12])
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
      if (attendanceImportIsSkippableName(fullName)) continue;

      parsedRows.push({
        rowNumber: index + 1,
        fullName,
        key: attendanceImportPlayerKeyFromFullName(fullName),
        dzCount: idxDz >= 0 ? attendanceImportToNumberOrNull(row[idxDz]) : null,
        dzMinutes: null,
        tjCount: idxTj >= 0 ? attendanceImportToNumberOrNull(row[idxTj]) : null,
        tjMinutes: idxTh >= 0 ? attendanceImportToNumberOrNull(row[idxTh]) : null,
        pzCount: idxPzCount >= 0 ? attendanceImportToNumberOrNull(row[idxPzCount]) : null,
        pzMinutes: idxPzMinutes >= 0 ? attendanceImportToNumberOrNull(row[idxPzMinutes]) : null,
        mzCount: idxMzCount >= 0 ? attendanceImportToNumberOrNull(row[idxMzCount]) : null,
        mzMinutes: idxMzMinutes >= 0 ? attendanceImportToNumberOrNull(row[idxMzMinutes]) : null,
        rzMinutes: idxRz >= 0 ? attendanceImportToNumberOrNull(row[idxRz]) : null,
        hzMinutes: idxHz >= 0 ? attendanceImportToNumberOrNull(row[idxHz]) : null,
        hzPercent: idxPercent >= 0 ? attendanceImportToPercentForStorage(row[idxPercent]) : null
      });
    }

    return parsedRows;
  }

  return [];
};

const attendanceImportResolveSeasonYears = (seasonLabel) => {
  const matched = String(seasonLabel || '').trim().match(/^(\d{4})\s*\/\s*(\d{4})$/);
  if (!matched) return null;
  const startYear = Number(matched[1]);
  const endYear = Number(matched[2]);
  if (!Number.isInteger(startYear) || !Number.isInteger(endYear) || endYear !== (startYear + 1)) return null;
  return { startYear, endYear };
};

const attendanceImportResolveYearForMonthIndex = (seasonLabel, monthIndex) => {
  const years = attendanceImportResolveSeasonYears(seasonLabel);
  if (!years || !Number.isInteger(monthIndex) || monthIndex < 0 || monthIndex > 11) return null;
  return monthIndex >= 6 ? years.startYear : years.endYear;
};

const attendanceImportNormalizeDailyMetricCode = (value) => {
  const token = attendanceImportNormalizeText(value).toUpperCase();
  if (!token) return '';
  if (token.includes('PZ')) return 'PZ';
  if (token.includes('MZ')) return 'MZ';
  if (token === 'T' || token.includes('TR')) return 'TJ';
  return '';
};

const attendanceImportParseDailyRowsBySheetLayout = (rows, seasonLabel, monthIndex) => {
  if (!Number.isInteger(monthIndex)) return [];

  const targetYear = attendanceImportResolveYearForMonthIndex(seasonLabel, monthIndex);
  if (!Number.isInteger(targetYear)) return [];

  const row3 = Array.isArray(rows?.[3]) ? rows[3] : [];
  const row5 = Array.isArray(rows?.[5]) ? rows[5] : [];
  const dayColumns = [];

  for (let columnIndex = 0; columnIndex < row5.length; columnIndex += 1) {
    const dayNumber = Number(String(row5[columnIndex] || '').trim());
    if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 31) continue;
    const metricCode = attendanceImportNormalizeDailyMetricCode(row3[columnIndex]);
    if (!metricCode) continue;
    dayColumns.push({ columnIndex, dayNumber, metricCode });
  }

  if (dayColumns.length === 0) return [];

  const parsed = [];
  for (let rowIndex = 6; rowIndex < rows.length; rowIndex += 1) {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    const fullName = String(row[0] || '').trim();
    if (attendanceImportIsSkippableName(fullName)) continue;

    const key = attendanceImportPlayerKeyFromFullName(fullName);
    if (!key) continue;

    for (const dayColumn of dayColumns) {
      const minutes = attendanceImportToNumberOrNull(row[dayColumn.columnIndex]);
      if (!Number.isFinite(minutes) || minutes <= 0) continue;

      parsed.push({
        fullName,
        key,
        rowNumber: rowIndex + 1,
        sourceColumnIndex: dayColumn.columnIndex,
        dayNumber: dayColumn.dayNumber,
        metricCode: dayColumn.metricCode,
        minutes: Math.round(minutes),
        dateKey: `${targetYear}-${String(monthIndex + 1).padStart(2, '0')}-${String(dayColumn.dayNumber).padStart(2, '0')}`
      });
    }
  }

  return parsed;
};

const attendanceImportResolveMonthSheetMeta = (sheetName) => {
  const normalized = attendanceImportNormalizeText(sheetName);
  const matched = ATTENDANCE_IMPORT_MONTH_SHEETS.find((item) => item.labels.some((label) => attendanceImportNormalizeText(label) === normalized));
  if (!matched) return null;
  const monthIndex = matched.monthNumber - 1;
  return {
    timelineType: 'month',
    timelineKey: `month-${monthIndex}`,
    timelineLabel: String(sheetName || '').trim() || `Mesiac ${matched.monthNumber}`,
    monthIndex
  };
};

const attendanceImportResolveSeasonSummarySheet = (sheetNames) => {
  const source = Array.isArray(sheetNames) ? sheetNames : [];
  return source.find((name) => {
    const normalized = attendanceImportNormalizeText(name);
    return normalized.includes('celkom') && normalized.includes('sezona');
  }) || null;
};

const normalizeSeasonRow = (row) => ({
  id: row.id,
  name: row.name,
  from: row.from_date,
  to: row.to_date,
  createdAt: row.created_at,
  updatedAt: row.updated_at
});

// GET /api/clubs/my-club/attendance-display-settings
router.get('/my-club/attendance-display-settings', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubAttendanceDisplaySettingsColumn(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const [rows] = await db.query(
      'SELECT attendance_display_settings FROM clubs WHERE id = ? LIMIT 1',
      [clubId]
    );

    const settings = parseAttendanceDisplaySettings(rows?.[0]?.attendance_display_settings);
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

// PUT /api/clubs/my-club/attendance-display-settings
router.put('/my-club/attendance-display-settings', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubAttendanceDisplaySettingsColumn(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const input = req.body?.settings;
    if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'Nastavenia musia byť JSON objekt.' });
    }

    const serialized = JSON.stringify(input);

    await db.query(
      'UPDATE clubs SET attendance_display_settings = ? WHERE id = ?',
      [serialized, clubId]
    );

    res.json({
      message: 'Nastavenie zobrazenia ukazovateľov bolo uložené',
      settings: input
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/clubs/my-club/attendance-seasons
router.get('/my-club/attendance-seasons', authenticateToken, async (req, res, next) => {
  try {
    await ensureAttendanceSeasonsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const [rows] = await db.query(
      'SELECT * FROM attendance_seasons WHERE club_id = ? ORDER BY created_at ASC',
      [clubId]
    );
    res.json({ total: rows.length, seasons: rows.map(normalizeSeasonRow) });
  } catch (error) { next(error); }
});

// GET /api/clubs/my-club/player-season-summaries
router.get('/my-club/player-season-summaries', authenticateToken, async (req, res, next) => {
  try {
    await ensurePlayerSeasonSummariesTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const seasonFilter = String(req.query?.season || '').trim();
    const params = [clubId];
    let whereSql = 'WHERE pss.club_id = ?';

    if (seasonFilter) {
      whereSql += ' AND pss.season = ?';
      params.push(seasonFilter);
    }

    const [rows] = await db.query(
      `SELECT
         pss.id,
         pss.user_id,
         pss.season,
         pss.dz_count,
         pss.dz_minutes,
         pss.tj_count,
         pss.tj_minutes,
         pss.pz_count,
         pss.pz_minutes,
         pss.mz_count,
         pss.mz_minutes,
         pss.rz_minutes,
         pss.hz_minutes,
         pss.hz_percent,
         pss.created_at,
         pss.updated_at,
         u.first_name,
         u.last_name
       FROM player_season_summaries pss
       LEFT JOIN users u ON u.id = pss.user_id
       ${whereSql}
       ORDER BY pss.season DESC, u.last_name ASC, u.first_name ASC, pss.user_id ASC`,
      params
    );

    const summaries = rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      season: String(row.season || ''),
      playerName: `${String(row.first_name || '').trim()} ${String(row.last_name || '').trim()}`.trim(),
      dzCount: Number(row.dz_count || 0),
      dzMinutes: Number(row.dz_minutes || 0),
      tjCount: Number(row.tj_count || 0),
      tjMinutes: Number(row.tj_minutes || 0),
      pzCount: Number(row.pz_count || 0),
      pzMinutes: Number(row.pz_minutes || 0),
      mzCount: Number(row.mz_count || 0),
      mzMinutes: Number(row.mz_minutes || 0),
      rzMinutes: Number(row.rz_minutes || 0),
      hzMinutes: Number(row.hz_minutes || 0),
      hzPercent: Number(row.hz_percent || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json({ total: summaries.length, summaries });
  } catch (error) {
    next(error);
  }
});

// GET /api/clubs/my-club/player-timeline-summaries
router.get('/my-club/player-timeline-summaries', authenticateToken, async (req, res, next) => {
  try {
    await ensurePlayerTimelineSummariesTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const seasonFilter = String(req.query?.season || '').trim();
    const timelineTypeFilter = String(req.query?.timelineType || '').trim();
    const timelineKeyFilter = String(req.query?.timelineKey || '').trim();
    const params = [clubId];
    let whereSql = 'WHERE pts.club_id = ?';

    if (seasonFilter) {
      whereSql += ' AND pts.season = ?';
      params.push(seasonFilter);
    }

    if (timelineTypeFilter) {
      whereSql += ' AND pts.timeline_type = ?';
      params.push(timelineTypeFilter);
    }

    if (timelineKeyFilter) {
      whereSql += ' AND pts.timeline_key = ?';
      params.push(timelineKeyFilter);
    }

    const [rows] = await db.query(
      `SELECT
         pts.id,
         pts.user_id,
         pts.season,
         pts.timeline_type,
         pts.timeline_key,
         pts.timeline_label,
         pts.month_index,
         pts.dz_count,
         pts.dz_minutes,
         pts.tj_count,
         pts.tj_minutes,
         pts.pz_count,
         pts.pz_minutes,
         pts.mz_count,
         pts.mz_minutes,
         pts.rz_minutes,
         pts.hz_minutes,
         pts.hz_percent,
         pts.created_at,
         pts.updated_at,
         u.first_name,
         u.last_name
       FROM player_timeline_summaries pts
       LEFT JOIN users u ON u.id = pts.user_id
       ${whereSql}
       ORDER BY pts.season DESC, pts.timeline_type ASC, pts.timeline_key ASC, u.last_name ASC, u.first_name ASC, pts.user_id ASC`,
      params
    );

    const summaries = rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      season: String(row.season || ''),
      timelineType: String(row.timeline_type || ''),
      timelineKey: String(row.timeline_key || ''),
      timelineLabel: String(row.timeline_label || ''),
      monthIndex: Number.isInteger(Number(row.month_index)) ? Number(row.month_index) : null,
      playerName: `${String(row.first_name || '').trim()} ${String(row.last_name || '').trim()}`.trim(),
      dzCount: Number(row.dz_count || 0),
      dzMinutes: Number(row.dz_minutes || 0),
      tjCount: Number(row.tj_count || 0),
      tjMinutes: Number(row.tj_minutes || 0),
      pzCount: Number(row.pz_count || 0),
      pzMinutes: Number(row.pz_minutes || 0),
      mzCount: Number(row.mz_count || 0),
      mzMinutes: Number(row.mz_minutes || 0),
      rzMinutes: Number(row.rz_minutes || 0),
      hzMinutes: Number(row.hz_minutes || 0),
      hzPercent: Number(row.hz_percent || 0),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json({ total: summaries.length, summaries });
  } catch (error) {
    next(error);
  }
});

// GET /api/clubs/my-club/player-timeline-daily-entries
router.get('/my-club/player-timeline-daily-entries', authenticateToken, async (req, res, next) => {
  try {
    await ensurePlayerTimelineDailyEntriesTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const seasonFilter = String(req.query?.season || '').trim();
    const timelineTypeFilter = String(req.query?.timelineType || '').trim();
    const timelineKeyFilter = String(req.query?.timelineKey || '').trim();
    const fromDateFilter = String(req.query?.fromDate || '').trim();
    const toDateFilter = String(req.query?.toDate || '').trim();
    const params = [clubId];
    let whereSql = 'WHERE ptd.club_id = ?';

    if (seasonFilter) {
      whereSql += ' AND ptd.season = ?';
      params.push(seasonFilter);
    }

    if (timelineTypeFilter) {
      whereSql += ' AND ptd.timeline_type = ?';
      params.push(timelineTypeFilter);
    }

    if (timelineKeyFilter) {
      whereSql += ' AND ptd.timeline_key = ?';
      params.push(timelineKeyFilter);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(fromDateFilter)) {
      whereSql += ' AND ptd.date_key >= ?';
      params.push(fromDateFilter);
    }

    if (/^\d{4}-\d{2}-\d{2}$/.test(toDateFilter)) {
      whereSql += ' AND ptd.date_key <= ?';
      params.push(toDateFilter);
    }

    const [rows] = await db.query(
      `SELECT
         ptd.id,
         ptd.user_id,
         ptd.season,
         ptd.timeline_type,
         ptd.timeline_key,
         ptd.timeline_label,
         ptd.month_index,
         DATE_FORMAT(ptd.date_key, '%Y-%m-%d') AS date_key,
         ptd.day_of_month,
         ptd.metric_code,
         ptd.minutes,
         ptd.created_at,
         ptd.updated_at,
         u.first_name,
         u.last_name
       FROM player_timeline_daily_entries ptd
       LEFT JOIN users u ON u.id = ptd.user_id
       ${whereSql}
       ORDER BY ptd.season DESC, ptd.timeline_type ASC, ptd.timeline_key ASC, ptd.date_key ASC, u.last_name ASC, u.first_name ASC, ptd.source_column_index ASC`,
      params
    );

    const entries = rows.map((row) => ({
      id: Number(row.id),
      userId: Number(row.user_id),
      season: String(row.season || ''),
      timelineType: String(row.timeline_type || ''),
      timelineKey: String(row.timeline_key || ''),
      timelineLabel: String(row.timeline_label || ''),
      monthIndex: Number.isInteger(Number(row.month_index)) ? Number(row.month_index) : null,
      dateKey: row.date_key ? String(row.date_key).slice(0, 10) : '',
      dayOfMonth: Number(row.day_of_month || 0),
      metricCode: String(row.metric_code || '').trim().toUpperCase(),
      minutes: Number(row.minutes || 0),
      playerName: `${String(row.first_name || '').trim()} ${String(row.last_name || '').trim()}`.trim(),
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));

    res.json({ total: entries.length, entries });
  } catch (error) {
    next(error);
  }
});

// POST /api/clubs/my-club/attendance-import
router.post('/my-club/attendance-import', authenticateToken, attendanceImportUpload.single('file'), async (req, res, next) => {
  let connection;

  try {
    const season = String(req.body?.season || '').trim();
    if (!/^\d{4}\s*\/\s*\d{4}$/.test(season)) {
      return res.status(400).json({ error: 'Sezóna musí mať formát RRRR/RRRR.' });
    }

    if (!req.file?.buffer || !req.file?.originalname) {
      return res.status(400).json({ error: 'Chýba súbor na import.' });
    }

    const extension = path.extname(String(req.file.originalname || '')).toLowerCase();
    if (!['.xlsx', '.xlsm', '.xls'].includes(extension)) {
      return res.status(400).json({ error: 'Nepodporovaný typ súboru. Povolené: .xlsx, .xlsm, .xls' });
    }

    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    let workbook;
    try {
      workbook = XLSX.read(req.file.buffer, { type: 'buffer', cellDates: false });
    } catch {
      return res.status(400).json({ error: 'Súbor sa nepodarilo načítať ako Excel workbook.' });
    }

    const sourceSheetNames = Array.isArray(workbook.SheetNames) ? workbook.SheetNames : [];
    const seasonSummarySheet = attendanceImportResolveSeasonSummarySheet(sourceSheetNames);
    const monthSheets = sourceSheetNames
      .map((sheetName) => ({ sheetName, timelineMeta: attendanceImportResolveMonthSheetMeta(sheetName) }))
      .filter((item) => item.timelineMeta);

    if (!seasonSummarySheet && monthSheets.length === 0) {
      return res.status(400).json({ error: 'V súbore nebol nájdený žiadny podporovaný hárok pre import dochádzky.' });
    }

    connection = await db.getConnection();
    await ensurePlayerSeasonSummariesTable(connection);
    await ensurePlayerTimelineSummariesTable(connection);
    await ensurePlayerTimelineDailyEntriesTable(connection);
    await ensureAttendanceSeasonsTable(connection);

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
      const key = attendanceImportPlayerKeyFromDb(player.firstName, player.lastName);
      if (!key) return;
      if (!playerMap.has(key)) playerMap.set(key, []);
      playerMap.get(key).push(player);
    });

    const importSheets = [];
    let totalMatched = 0;
    let totalDailyImported = 0;

    const upsertSummaryRow = async (timelineMeta, summaryRow, sheetName) => {
      const summaryValues = [
        clubId,
        summaryRow.userId,
        season,
        req.file.originalname,
        sheetName,
        summaryRow.dzCount,
        summaryRow.dzMinutes,
        summaryRow.tjCount,
        summaryRow.tjMinutes,
        summaryRow.pzCount,
        summaryRow.pzMinutes,
        summaryRow.mzCount,
        summaryRow.mzMinutes,
        summaryRow.rzMinutes,
        summaryRow.hzMinutes,
        summaryRow.hzPercent
      ];

      if (timelineMeta.timelineType === 'season') {
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
          summaryValues
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
          summaryRow.userId,
          season,
          timelineMeta.timelineType,
          timelineMeta.timelineKey,
          timelineMeta.timelineLabel,
          timelineMeta.monthIndex,
          req.file.originalname,
          sheetName,
          summaryRow.dzCount,
          summaryRow.dzMinutes,
          summaryRow.tjCount,
          summaryRow.tjMinutes,
          summaryRow.pzCount,
          summaryRow.pzMinutes,
          summaryRow.mzCount,
          summaryRow.mzMinutes,
          summaryRow.rzMinutes,
          summaryRow.hzMinutes,
          summaryRow.hzPercent
        ]
      );
    };

    const processSheet = async (sheetName, timelineMeta) => {
      const sheet = workbook.Sheets[sheetName];
      if (!sheet) return;

      const rows = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        raw: false,
        defval: ''
      });

      const parsedSummaryRows = attendanceImportParseSummaryRowsBySheetLayout(rows);
      const matchedSummaryRows = [];
      const missingNames = [];

      parsedSummaryRows.forEach((entry) => {
        const candidates = playerMap.get(entry.key) || [];
        if (candidates.length === 1) {
          matchedSummaryRows.push({
            ...entry,
            userId: Number(candidates[0].userId)
          });
          return;
        }

        if (candidates.length === 0) {
          missingNames.push(entry.fullName);
        }
      });

      for (const matchedRow of matchedSummaryRows) {
        await upsertSummaryRow(timelineMeta, matchedRow, sheetName);
      }

      let importedDailyCount = 0;
      if (timelineMeta.timelineType === 'month') {
        const parsedDailyRows = attendanceImportParseDailyRowsBySheetLayout(rows, season, timelineMeta.monthIndex);
        const matchedByKey = new Map();
        matchedSummaryRows.forEach((item) => matchedByKey.set(String(item.key || ''), item));

        const matchedDailyRows = parsedDailyRows
          .map((entry) => {
            const resolvedPlayer = matchedByKey.get(String(entry.key || ''));
            if (!resolvedPlayer) return null;
            return {
              ...entry,
              userId: Number(resolvedPlayer.userId)
            };
          })
          .filter(Boolean);

        await connection.query(
          `DELETE FROM player_timeline_daily_entries
           WHERE club_id = ? AND season = ? AND timeline_type = ? AND timeline_key = ?`,
          [clubId, season, timelineMeta.timelineType, timelineMeta.timelineKey]
        );

        for (const dailyRow of matchedDailyRows) {
          await connection.query(
            `INSERT INTO player_timeline_daily_entries (
              club_id, user_id, season, timeline_type, timeline_key, timeline_label, month_index,
              date_key, day_of_month, metric_code, minutes,
              source_file, sheet_name, source_row_index, source_column_index
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
              timeline_label = VALUES(timeline_label),
              month_index = VALUES(month_index),
              metric_code = VALUES(metric_code),
              minutes = VALUES(minutes),
              source_file = VALUES(source_file),
              sheet_name = VALUES(sheet_name),
              source_row_index = VALUES(source_row_index),
              source_column_index = VALUES(source_column_index)`,
            [
              clubId,
              dailyRow.userId,
              season,
              timelineMeta.timelineType,
              timelineMeta.timelineKey,
              timelineMeta.timelineLabel,
              timelineMeta.monthIndex,
              dailyRow.dateKey,
              dailyRow.dayNumber,
              dailyRow.metricCode,
              dailyRow.minutes,
              req.file.originalname,
              sheetName,
              dailyRow.rowNumber,
              dailyRow.sourceColumnIndex
            ]
          );
        }

        importedDailyCount = matchedDailyRows.length;
        totalDailyImported += importedDailyCount;
      }

      totalMatched += matchedSummaryRows.length;

      importSheets.push({
        sheet: sheetName,
        timelineType: timelineMeta.timelineType,
        timelineKey: timelineMeta.timelineKey,
        matchedPlayers: matchedSummaryRows.length,
        missingPlayers: missingNames.length,
        importedDailyCount
      });
    };

    if (seasonSummarySheet) {
      await processSheet(seasonSummarySheet, {
        timelineType: 'season',
        timelineKey: 'summary',
        timelineLabel: 'Súhrn sezóny',
        monthIndex: null
      });

      const [existingSeasonRows] = await connection.query(
        'SELECT id FROM attendance_seasons WHERE club_id = ? AND LOWER(name) = LOWER(?) LIMIT 1',
        [clubId, season]
      );
      if (!Array.isArray(existingSeasonRows) || existingSeasonRows.length === 0) {
        await connection.query(
          'INSERT INTO attendance_seasons (club_id, name, from_date, to_date) VALUES (?, ?, ?, ?)',
          [clubId, season, '01.07', '30.06']
        );
      }
    }

    for (const monthSheet of monthSheets) {
      await processSheet(monthSheet.sheetName, monthSheet.timelineMeta);
    }

    return res.json({
      message: 'Import dochádzky bol dokončený.',
      report: {
        sheetCount: importSheets.length,
        totalMatched,
        totalDailyImported,
        importedSheets: importSheets
      }
    });
  } catch (error) {
    return next(error);
  } finally {
    if (connection) {
      connection.release();
    }
  }
});

// GET /api/clubs/my-club/training-exercise-display-settings
router.get('/my-club/training-exercise-display-settings', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubTrainingExerciseDisplaySettingsColumn(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const [rows] = await db.query(
      'SELECT training_exercise_display_settings FROM clubs WHERE id = ? LIMIT 1',
      [clubId]
    );

    const settings = parseJsonSettingsObject(rows?.[0]?.training_exercise_display_settings);
    res.json({ settings });
  } catch (error) {
    next(error);
  }
});

// PUT /api/clubs/my-club/training-exercise-display-settings
router.put('/my-club/training-exercise-display-settings', authenticateToken, async (req, res, next) => {
  try {
    await ensureClubTrainingExerciseDisplaySettingsColumn(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const input = req.body?.settings;
    if (input === null || input === undefined || typeof input !== 'object' || Array.isArray(input)) {
      return res.status(400).json({ error: 'Nastavenia musia byť JSON objekt.' });
    }

    const serialized = JSON.stringify(input);

    await db.query(
      'UPDATE clubs SET training_exercise_display_settings = ? WHERE id = ?',
      [serialized, clubId]
    );

    res.json({
      message: 'Nastavenie zobrazenia tréningov bolo uložené',
      settings: input
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/clubs/my-club/attendance-seasons
router.post('/my-club/attendance-seasons', authenticateToken, async (req, res, next) => {
  try {
    await ensureAttendanceSeasonsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const { name, from, to } = req.body;
    if (!name || !from || !to) return res.status(400).json({ error: 'Chýbajú povinné polia.' });

    const [result] = await db.query(
      'INSERT INTO attendance_seasons (club_id, name, from_date, to_date) VALUES (?, ?, ?, ?)',
      [clubId, name.trim(), from.trim(), to.trim()]
    );

    const [[created]] = await db.query('SELECT * FROM attendance_seasons WHERE id = ?', [result.insertId]);
    res.status(201).json({ message: 'Sezóna bola uložená', season: normalizeSeasonRow(created) });
  } catch (error) { next(error); }
});

// PUT /api/clubs/my-club/attendance-seasons/:seasonId
router.put('/my-club/attendance-seasons/:seasonId', authenticateToken, async (req, res, next) => {
  try {
    await ensureAttendanceSeasonsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const { seasonId } = req.params;
    const { name, from, to } = req.body;

    await db.query(
      'UPDATE attendance_seasons SET name = ?, from_date = ?, to_date = ?, updated_at = NOW() WHERE id = ? AND club_id = ?',
      [name.trim(), from.trim(), to.trim(), seasonId, clubId]
    );

    const [[updated]] = await db.query('SELECT * FROM attendance_seasons WHERE id = ? AND club_id = ?', [seasonId, clubId]);
    if (!updated) return res.status(404).json({ error: 'Sezóna nenájdená' });
    res.json({ message: 'Sezóna bola upravená', season: normalizeSeasonRow(updated) });
  } catch (error) { next(error); }
});

// DELETE /api/clubs/my-club/attendance-seasons/:seasonId
router.delete('/my-club/attendance-seasons/:seasonId', authenticateToken, async (req, res, next) => {
  try {
    await ensureAttendanceSeasonsTable(db);
    const clubId = await resolveUserClubId(req.user.id);
    if (!clubId) return res.status(404).json({ error: 'Klub nebol nájdený' });

    const { seasonId } = req.params;
    await db.query('DELETE FROM attendance_seasons WHERE id = ? AND club_id = ?', [seasonId, clubId]);
    res.json({ message: 'Sezóna bola odstránená' });
  } catch (error) { next(error); }
});

// PUT /api/clubs/my-club - Aktualizovať klub aktuálneho používateľa
router.put('/my-club', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await ensureClubBankingColumns(db);
    await ensureClubLocationColumns(db);
    await ensureClubContactColumns(db);
    await ensureClubSportColumn(db);
    await ensureClubCustomDataColumns(db);
    await ensureClubAttendanceDisplaySettingsColumn(db);
    const { name, logo, address, city, country, email, phone, website, bankName, swiftCode, accountHolderName, iban, sport } = req.body;

    const hasNameInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'name');
    const hasLogoInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'logo');
    const hasAddressInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'address');
    const hasCityInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'city');
    const hasCountryInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'country');
    const hasEmailInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'email');
    const hasPhoneInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'phone');
    const hasWebsiteInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'website');
    const hasBankNameInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'bankName');
    const hasSwiftCodeInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'swiftCode');
    const hasAccountHolderNameInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'accountHolderName');
    const hasIbanInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'iban');
    const hasSportInput = Object.prototype.hasOwnProperty.call(req.body || {}, 'sport');
    if (hasNameInput && (!name || name.trim() === '')) {
      return res.status(400).json({ error: 'Názov klubu je povinný' });
    }

    const clubId = await resolveUserClubId(userId);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const resolvedSport = normalizeSportKey(sport);
    const [clubColumnsRows] = await db.query('SHOW COLUMNS FROM clubs');
    const clubColumns = new Set(clubColumnsRows.map((column) => String(column.Field || '').toLowerCase()));

    const updateParts = [];
    const updateValues = [];

    if (hasNameInput) {
      updateParts.push('name = ?');
      updateValues.push(name.trim());
    }

    if (clubColumns.has('sport') && hasSportInput) {
      updateParts.push('sport = COALESCE(?, sport)');
      updateValues.push(resolvedSport);
    }

    if (clubColumns.has('logo_url') && hasLogoInput) {
      updateParts.push('logo_url = ?');
      updateValues.push(logo || '');
    }

    if (clubColumns.has('address') && hasAddressInput) {
      updateParts.push('address = ?');
      updateValues.push(address || '');
    }

    if (clubColumns.has('city') && hasCityInput) {
      updateParts.push('city = ?');
      updateValues.push(city || '');
    }

    if (clubColumns.has('country') && hasCountryInput) {
      updateParts.push('country = ?');
      updateValues.push(country || 'SK');
    }

    if (clubColumns.has('email') && hasEmailInput) {
      updateParts.push('email = ?');
      updateValues.push(email || '');
    }

    if (clubColumns.has('phone') && hasPhoneInput) {
      updateParts.push('phone = ?');
      updateValues.push(phone || '');
    }

    if (clubColumns.has('website') && hasWebsiteInput) {
      updateParts.push('website = ?');
      updateValues.push(website || '');
    }

    if (clubColumns.has('bank_name') && hasBankNameInput) {
      updateParts.push('bank_name = ?');
      updateValues.push(bankName || '');
    }

    if (clubColumns.has('swift_code') && hasSwiftCodeInput) {
      updateParts.push('swift_code = ?');
      updateValues.push(swiftCode || '');
    }

    if (clubColumns.has('account_holder_name') && hasAccountHolderNameInput) {
      updateParts.push('account_holder_name = ?');
      updateValues.push(accountHolderName || '');
    }

    if (clubColumns.has('iban') && hasIbanInput) {
      updateParts.push('iban = ?');
      updateValues.push(iban || '');
    }

    const requestedFieldToColumn = [
      ['address', hasAddressInput, 'address'],
      ['city', hasCityInput, 'city'],
      ['country', hasCountryInput, 'country'],
      ['email', hasEmailInput, 'email'],
      ['phone', hasPhoneInput, 'phone'],
      ['website', hasWebsiteInput, 'website']
    ];

    const unsupportedRequestedFields = requestedFieldToColumn
      .filter(([, wasRequested, requiredColumn]) => wasRequested && !clubColumns.has(requiredColumn))
      .map(([fieldName]) => fieldName);

    if (unsupportedRequestedFields.length > 0) {
      return res.status(500).json({
        error: 'Nie je možné uložiť niektoré polia profilu klubu',
        unsupportedFields: unsupportedRequestedFields
      });
    }

    if (clubColumns.has('training_divisions_json') && Object.prototype.hasOwnProperty.call(req.body || {}, 'trainingDivisions')) {
      updateParts.push('training_divisions_json = ?');
      updateValues.push(JSON.stringify(Array.isArray(req.body.trainingDivisions) ? req.body.trainingDivisions : []));
    }

    if (clubColumns.has('exercise_categories_json') && Object.prototype.hasOwnProperty.call(req.body || {}, 'exerciseCategories')) {
      updateParts.push('exercise_categories_json = ?');
      updateValues.push(JSON.stringify(Array.isArray(req.body.exerciseCategories) ? req.body.exerciseCategories : []));
    }

    if (clubColumns.has('exercise_items_json') && Object.prototype.hasOwnProperty.call(req.body || {}, 'exerciseDatabaseItems')) {
      updateParts.push('exercise_items_json = ?');
      updateValues.push(JSON.stringify(Array.isArray(req.body.exerciseDatabaseItems) ? req.body.exerciseDatabaseItems : []));
    }

    if (clubColumns.has('evidence_entries_json') && Object.prototype.hasOwnProperty.call(req.body || {}, 'evidenceEntries')) {
      const evidenceEntries = (req.body.evidenceEntries && typeof req.body.evidenceEntries === 'object')
        ? req.body.evidenceEntries
        : {};
      updateParts.push('evidence_entries_json = ?');
      updateValues.push(JSON.stringify(evidenceEntries));
    }

    if (clubColumns.has('evidence_session_meta_json') && Object.prototype.hasOwnProperty.call(req.body || {}, 'evidenceSessionMeta')) {
      const evidenceSessionMeta = (req.body.evidenceSessionMeta && typeof req.body.evidenceSessionMeta === 'object')
        ? req.body.evidenceSessionMeta
        : {};
      updateParts.push('evidence_session_meta_json = ?');
      updateValues.push(JSON.stringify(evidenceSessionMeta));
    }

    if (clubColumns.has('attendance_display_settings') && Object.prototype.hasOwnProperty.call(req.body || {}, 'attendanceDisplaySettings')) {
      const attendanceDisplaySettings = (req.body.attendanceDisplaySettings && typeof req.body.attendanceDisplaySettings === 'object')
        ? req.body.attendanceDisplaySettings
        : {};
      updateParts.push('attendance_display_settings = ?');
      updateValues.push(JSON.stringify(attendanceDisplaySettings));
    }

    if (clubColumns.has('updated_at')) {
      updateParts.push('updated_at = NOW()');
    }

    if (updateParts.length === 0 || (updateParts.length === 1 && updateParts[0] === 'updated_at = NOW()')) {
      return res.json({ message: 'Bez zmien' });
    }

    // Aktualizovať klub
    await db.query(
      `UPDATE clubs 
       SET ${updateParts.join(', ')}
       WHERE id = ?`,
      [...updateValues, clubId]
    );

    if (clubColumns.has('training_divisions_json') && Object.prototype.hasOwnProperty.call(req.body || {}, 'trainingDivisions')) {
      await applyTrainingDivisionsDefaultToMissingClubs(db, req.body.trainingDivisions);
    }

    res.json({
      message: 'Klub bol úspešne aktualizovaný'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
