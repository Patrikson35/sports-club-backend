const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const bcrypt = require('bcrypt');
const crypto = require('crypto');

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
  return null;
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
  try {
    await connection.query('ALTER TABLE users ADD COLUMN is_virtual BOOLEAN DEFAULT FALSE');
  } catch (error) {
    if (error?.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }
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
    await ensureClubContactColumns(db);
    await ensureClubSportColumn(db);

    const clubId = await resolveUserClubId(userId);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const [clubs] = await db.query(
      `SELECT id, name, address, city, country, email, phone, website, logo_url, sport,
              bank_name, swift_code, account_holder_name, iban
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
router.post('/', authenticateToken, async (req, res, next) => {
  try {
    const userId = req.user.id;
    await ensureClubBankingColumns(db);
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

const normalizeSeasonRow = (row) => ({
  id: row.id,
  name: row.name,
  from: row.from_date,
  to: row.to_date,
  createdAt: row.created_at,
  updatedAt: row.updated_at
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
    await ensureClubContactColumns(db);
    await ensureClubSportColumn(db);
    const { name, logo, address, city, country, email, phone, website, bankName, swiftCode, accountHolderName, iban, sport } = req.body;

    if (!name || name.trim() === '') {
      return res.status(400).json({ error: 'Názov klubu je povinný' });
    }

    const clubId = await resolveUserClubId(userId);
    if (!clubId) {
      return res.status(404).json({ error: 'Klub nebol nájdený' });
    }

    const resolvedSport = normalizeSportKey(sport);
    const [clubColumnsRows] = await db.query('SHOW COLUMNS FROM clubs');
    const clubColumns = new Set(clubColumnsRows.map((column) => String(column.Field || '').toLowerCase()));

    const updateParts = ['name = ?'];
    const updateValues = [name.trim()];

    if (clubColumns.has('sport')) {
      updateParts.push('sport = COALESCE(?, sport)');
      updateValues.push(resolvedSport);
    }

    if (clubColumns.has('logo_url')) {
      updateParts.push('logo_url = ?');
      updateValues.push(logo || '');
    }

    if (clubColumns.has('address')) {
      updateParts.push('address = ?');
      updateValues.push(address || '');
    }

    if (clubColumns.has('city')) {
      updateParts.push('city = ?');
      updateValues.push(city || '');
    }

    if (clubColumns.has('country')) {
      updateParts.push('country = ?');
      updateValues.push(country || 'SK');
    }

    if (clubColumns.has('email')) {
      updateParts.push('email = ?');
      updateValues.push(email || '');
    }

    if (clubColumns.has('phone')) {
      updateParts.push('phone = ?');
      updateValues.push(phone || '');
    }

    if (clubColumns.has('website')) {
      updateParts.push('website = ?');
      updateValues.push(website || '');
    }

    if (clubColumns.has('bank_name')) {
      updateParts.push('bank_name = ?');
      updateValues.push(bankName || '');
    }

    if (clubColumns.has('swift_code')) {
      updateParts.push('swift_code = ?');
      updateValues.push(swiftCode || '');
    }

    if (clubColumns.has('account_holder_name')) {
      updateParts.push('account_holder_name = ?');
      updateValues.push(accountHolderName || '');
    }

    if (clubColumns.has('iban')) {
      updateParts.push('iban = ?');
      updateValues.push(iban || '');
    }

    if (clubColumns.has('updated_at')) {
      updateParts.push('updated_at = NOW()');
    }

    // Aktualizovať klub
    await db.query(
      `UPDATE clubs 
       SET ${updateParts.join(', ')}
       WHERE id = ?`,
      [...updateValues, clubId]
    );

    res.json({
      message: 'Klub bol úspešne aktualizovaný'
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
