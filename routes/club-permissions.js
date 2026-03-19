const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

const PERMISSION_CATALOG = {
  club: [
    'club.manage',
    'members.manage',
    'reports.view'
  ],
  sport: [
    'categories.manage',
    'exercises.manage',
    'trainings.manage',
    'attendance.manage'
  ],
  people: [
    'coaches.manage',
    'assistants.manage',
    'players.manage',
    'virtualPlayers.manage',
    'invites.manage'
  ],
  finance: [
    'fees.manage'
  ],
  communication: [
    'communication.manage'
  ],
  selfDevelopment: [
    'privateDevelopment.manage',
    'profile.manage'
  ]
};

const FLAT_PERMISSION_CATALOG = Object.values(PERMISSION_CATALOG).flat();

const ROLE_BASE_PERMISSIONS = {
  admin: FLAT_PERMISSION_CATALOG,
  club: FLAT_PERMISSION_CATALOG,
  coach: [
    'categories.manage',
    'players.manage',
    'virtualPlayers.manage',
    'invites.manage',
    'exercises.manage',
    'trainings.manage',
    'attendance.manage',
    'communication.manage',
    'profile.manage'
  ],
  assistant: [
    'categories.manage',
    'players.manage',
    'virtualPlayers.manage',
    'invites.manage',
    'exercises.manage',
    'trainings.manage',
    'attendance.manage',
    'communication.manage',
    'profile.manage'
  ],
  player: [
    'privateDevelopment.manage',
    'profile.manage'
  ],
  parent: [
    'privateDevelopment.manage',
    'profile.manage',
    'fees.manage',
    'communication.manage'
  ],
  private_coach: [
    'categories.manage',
    'exercises.manage',
    'trainings.manage',
    'privateDevelopment.manage',
    'profile.manage'
  ]
};

const VISIBLE_SECTION_KEYS = [
  'categories',
  'coaches',
  'players',
  'attendance',
  'planner',
  'matches',
  'trainings',
  'exercises',
  'tests',
  'membershipFees',
  'communication'
];

const DEFAULT_VISIBLE_SECTIONS_BY_ROLE = {
  club: ['categories', 'coaches', 'players', 'attendance', 'matches', 'trainings', 'exercises', 'tests', 'membershipFees', 'communication'],
  coach: ['categories', 'players', 'attendance', 'matches', 'trainings', 'exercises', 'tests', 'communication'],
  assistant: ['categories', 'players', 'attendance', 'matches', 'trainings', 'exercises', 'tests', 'communication'],
  parent: ['attendance', 'matches', 'trainings', 'tests', 'membershipFees', 'communication'],
  player: ['attendance', 'matches', 'trainings', 'tests'],
  private_coach: ['categories', 'players', 'attendance', 'trainings', 'exercises', 'tests', 'communication'],
  admin: ['clubs', 'categories', 'coaches', 'players', 'attendance', 'matches', 'trainings', 'exercises', 'tests', 'membershipFees', 'communication', 'registrations']
};

const SETTINGS_VISIBLE_ROLES = ['club', 'coach', 'parent', 'player'];

const DEFAULT_TRAINER_FUNCTIONS = [
  { name: 'Hlavný tréner', baseRole: 'coach' },
  { name: 'Asistent trénera', baseRole: 'assistant' },
  { name: 'Kondičný tréner', baseRole: 'assistant' },
  { name: 'Tréner brankárov', baseRole: 'assistant' },
  { name: 'Mentálny tréner', baseRole: 'assistant' }
];

const ensurePermissionsTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS club_member_delegations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      user_id INT NOT NULL,
      custom_title VARCHAR(120) NULL,
      permissions_json JSON NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_club_user_delegation (club_id, user_id),
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
};

const ensureManagerTables = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS club_manager_roles (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      role_name VARCHAR(120) NOT NULL,
      permissions_json JSON NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_club_role_name (club_id, role_name),
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS club_managers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL,
      mobile VARCHAR(40) NULL,
      photo_url VARCHAR(500) NULL,
      manager_role_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
      FOREIGN KEY (manager_role_id) REFERENCES club_manager_roles(id) ON DELETE RESTRICT,
      INDEX idx_club_managers_club (club_id),
      INDEX idx_club_managers_email (email)
    )
  `);

  try {
    await connection.query(`
      ALTER TABLE club_managers
      ADD COLUMN photo_url VARCHAR(500) NULL AFTER mobile
    `);
  } catch (error) {
    if (error && error.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }
};

const ensureVisibleSectionsTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS club_visible_sections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      role_key VARCHAR(30) NOT NULL,
      sections_json JSON NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_club_role_sections (club_id, role_key),
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);
};

const normalizeTrainerBaseRole = (value) => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'assistant' ? 'assistant' : 'coach';
};

const resolveTrainerBaseRoleFromName = (name) => {
  const normalizedName = String(name || '').trim().toLowerCase();
  return normalizedName === 'hlavný tréner' ? 'coach' : 'assistant';
};

const isDefaultTrainerFunctionName = (name) => {
  const normalizedName = String(name || '').trim().toLowerCase();
  return DEFAULT_TRAINER_FUNCTIONS.some((item) => String(item.name || '').trim().toLowerCase() === normalizedName);
};

const ensureTrainerFunctionsTable = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS club_trainer_functions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      function_name VARCHAR(120) NOT NULL,
      base_role VARCHAR(30) NOT NULL DEFAULT 'coach',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_club_trainer_function_name (club_id, function_name),
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE
    )
  `);
};

const ensureDefaultTrainerFunctions = async (connection, clubId) => {
  for (const item of DEFAULT_TRAINER_FUNCTIONS) {
    await connection.query(
      `INSERT INTO club_trainer_functions (club_id, function_name, base_role)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         base_role = VALUES(base_role),
         updated_at = CURRENT_TIMESTAMP`,
      [clubId, item.name, item.baseRole]
    );
  }
};

const normalizeVisibleSections = (sections, fallback = []) => {
  if (!Array.isArray(sections)) {
    return [...new Set(fallback)];
  }

  const allowed = new Set(VISIBLE_SECTION_KEYS);
  return [...new Set(
    sections
      .map((item) => String(item || '').trim())
      .filter((item) => allowed.has(item))
  )];
};

const getClubVisibleSectionsConfig = async (clubId) => {
  const [rows] = await db.query(
    `SELECT role_key, sections_json
     FROM club_visible_sections
     WHERE club_id = ?`,
    [clubId]
  );

  const byRole = {
    club: [...DEFAULT_VISIBLE_SECTIONS_BY_ROLE.club],
    coach: [...DEFAULT_VISIBLE_SECTIONS_BY_ROLE.coach],
    parent: [...DEFAULT_VISIBLE_SECTIONS_BY_ROLE.parent],
    player: [...DEFAULT_VISIBLE_SECTIONS_BY_ROLE.player]
  };

  rows.forEach((row) => {
    if (!SETTINGS_VISIBLE_ROLES.includes(row.role_key)) return;

    try {
      const parsed = typeof row.sections_json === 'string'
        ? JSON.parse(row.sections_json)
        : row.sections_json;
      byRole[row.role_key] = normalizeVisibleSections(parsed, byRole[row.role_key]);
    } catch {
      byRole[row.role_key] = [...DEFAULT_VISIBLE_SECTIONS_BY_ROLE[row.role_key]];
    }
  });

  return byRole;
};

const resolveUserClubId = async ({ userId, role }) => {
  if (role === 'club') {
    try {
      const [owned] = await db.query(
        `SELECT id FROM clubs WHERE owner_id = ? ORDER BY id ASC LIMIT 1`,
        [userId]
      );
      if (owned.length > 0) return Number(owned[0].id);
    } catch (error) {
      if (error?.code !== 'ER_BAD_FIELD_ERROR') {
        throw error;
      }
    }
  }

  const [memberRows] = await db.query(
    `SELECT club_id
     FROM club_members
     WHERE user_id = ? AND is_active = TRUE
     ORDER BY id ASC
     LIMIT 1`,
    [userId]
  );

  if (memberRows.length > 0) {
    return Number(memberRows[0].club_id);
  }

  return null;
};

const parseDelegatedPermissions = (permissionsJson) => {
  if (!permissionsJson) return [];

  try {
    const parsed = typeof permissionsJson === 'string' ? JSON.parse(permissionsJson) : permissionsJson;
    if (!Array.isArray(parsed)) return [];

    return parsed
      .map((item) => String(item || '').trim())
      .filter((item) => FLAT_PERMISSION_CATALOG.includes(item));
  } catch {
    return [];
  }
};

const getEffectivePermissions = ({ role, delegatedPermissions }) => {
  const base = ROLE_BASE_PERMISSIONS[role] || [];
  return [...new Set([...base, ...delegatedPermissions])];
};

const ensureClubAccess = async ({ clubId, userId, role }) => {
  if (role === 'admin') {
    return true;
  }

  try {
    const [owned] = await db.query(
      `SELECT id FROM clubs
       WHERE id = ? AND owner_id = ?
       LIMIT 1`,
      [clubId, userId]
    );

    if (owned.length > 0) {
      return true;
    }
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      throw error;
    }
  }

  const [rows] = await db.query(
    `SELECT id FROM club_members
     WHERE club_id = ? AND user_id = ? AND is_active = TRUE
     LIMIT 1`,
    [clubId, userId]
  );

  return rows.length > 0;
};

const ensureClubManager = async ({ clubId, userId, role }) => {
  if (role === 'admin') {
    return true;
  }

  const hasAccess = await ensureClubAccess({ clubId, userId, role });
  if (!hasAccess) {
    return false;
  }

  if (role === 'club') {
    return true;
  }

  const [rows] = await db.query(
    `SELECT id FROM club_member_delegations
     WHERE club_id = ? AND user_id = ?
     LIMIT 1`,
    [clubId, userId]
  );

  if (!rows.length) return false;

  const [delegations] = await db.query(
    `SELECT permissions_json FROM club_member_delegations
     WHERE club_id = ? AND user_id = ?
     LIMIT 1`,
    [clubId, userId]
  );

  const delegated = parseDelegatedPermissions(delegations[0]?.permissions_json);
  return delegated.includes('members.manage');
};

router.get('/catalog', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    res.json({
      catalog: PERMISSION_CATALOG,
      allPermissions: FLAT_PERMISSION_CATALOG
    });
  } catch (error) {
    next(error);
  }
});

router.get('/club/:clubId/me', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const hasAccess = await ensureClubAccess({
      clubId,
      userId: req.user.id,
      role: req.user.role
    });

    if (!hasAccess) {
      return res.status(403).json({ error: 'Nemáte prístup do tohto klubu' });
    }

    const [delegations] = await db.query(
      `SELECT custom_title, permissions_json
       FROM club_member_delegations
       WHERE club_id = ? AND user_id = ?
       LIMIT 1`,
      [clubId, req.user.id]
    );

    const delegatedPermissions = parseDelegatedPermissions(delegations[0]?.permissions_json);
    const effectivePermissions = getEffectivePermissions({
      role: req.user.role,
      delegatedPermissions
    });

    res.json({
      clubId,
      user: {
        id: req.user.id,
        role: req.user.role,
        customTitle: delegations[0]?.custom_title || ''
      },
      delegatedPermissions,
      effectivePermissions
    });
  } catch (error) {
    next(error);
  }
});

router.get('/club/:clubId/members', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManageMembers = await ensureClubManager({
      clubId,
      userId: req.user.id,
      role: req.user.role
    });

    if (!canManageMembers) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať oprávnenia členov klubu' });
    }

    const [rows] = await db.query(
      `SELECT
         cm.user_id,
         cm.member_role,
         u.first_name,
         u.last_name,
         u.email,
         d.custom_title,
         d.permissions_json
       FROM club_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN club_member_delegations d ON d.club_id = cm.club_id AND d.user_id = cm.user_id
       WHERE cm.club_id = ? AND cm.is_active = TRUE
       ORDER BY u.last_name, u.first_name`,
      [clubId]
    );

    res.json({
      total: rows.length,
      members: rows.map((row) => {
        const normalizedRole = row.member_role === 'club_admin' ? 'club' : row.member_role;
        const delegatedPermissions = parseDelegatedPermissions(row.permissions_json);
        return {
          userId: row.user_id,
          firstName: row.first_name,
          lastName: row.last_name,
          email: row.email,
          role: normalizedRole,
          customTitle: row.custom_title || '',
          delegatedPermissions,
          effectivePermissions: getEffectivePermissions({ role: normalizedRole, delegatedPermissions })
        };
      })
    });
  } catch (error) {
    next(error);
  }
});

router.put('/club/:clubId/member/:userId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    await ensurePermissionsTable(connection);
    await ensureManagerTables(connection);
    await ensureVisibleSectionsTable(connection);

    const clubId = Number(req.params.clubId);
    const userId = Number(req.params.userId);

    if (!Number.isInteger(clubId) || clubId <= 0 || !Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId alebo userId' });
    }

    const canManageMembers = await ensureClubManager({
      clubId,
      userId: req.user.id,
      role: req.user.role
    });

    if (!canManageMembers) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať oprávnenia členov klubu' });
    }

    const { customTitle = '', permissions = [] } = req.body;

    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions musí byť pole' });
    }

    const sanitizedPermissions = [...new Set(
      permissions
        .map((permission) => String(permission || '').trim())
        .filter((permission) => FLAT_PERMISSION_CATALOG.includes(permission))
    )];

    const [members] = await connection.query(
      `SELECT id FROM club_members WHERE club_id = ? AND user_id = ? AND is_active = TRUE LIMIT 1`,
      [clubId, userId]
    );

    if (!members.length) {
      return res.status(404).json({ error: 'Člen klubu nebol nájdený' });
    }

    await connection.beginTransaction();

    await connection.query(
      `INSERT INTO club_member_delegations (club_id, user_id, custom_title, permissions_json)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         custom_title = VALUES(custom_title),
         permissions_json = VALUES(permissions_json),
         updated_at = CURRENT_TIMESTAMP`,
      [clubId, userId, String(customTitle || '').trim(), JSON.stringify(sanitizedPermissions)]
    );

    await connection.commit();

    res.json({
      message: 'Delegované oprávnenia boli uložené',
      clubId,
      userId,
      customTitle: String(customTitle || '').trim(),
      delegatedPermissions: sanitizedPermissions
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.get('/club/:clubId/manager-roles', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať role klubu' });
    }

    const [rows] = await db.query(
      `SELECT id, role_name, permissions_json
       FROM club_manager_roles
       WHERE club_id = ?
       ORDER BY role_name`,
      [clubId]
    );

    res.json({
      total: rows.length,
      roles: rows.map((row) => ({
        id: row.id,
        name: row.role_name,
        permissions: parseDelegatedPermissions(row.permissions_json)
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.post('/club/:clubId/manager-roles', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať role klubu' });
    }

    const { name = '', permissions = [] } = req.body;
    if (!String(name).trim()) {
      return res.status(400).json({ error: 'Názov roly je povinný' });
    }
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions musí byť pole' });
    }

    const sanitizedPermissions = [...new Set(
      permissions
        .map((permission) => String(permission || '').trim())
        .filter((permission) => FLAT_PERMISSION_CATALOG.includes(permission))
    )];

    const [result] = await db.query(
      `INSERT INTO club_manager_roles (club_id, role_name, permissions_json)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE
         permissions_json = VALUES(permissions_json),
         updated_at = CURRENT_TIMESTAMP`,
      [clubId, String(name).trim(), JSON.stringify(sanitizedPermissions)]
    );

    res.status(201).json({
      message: 'Rola správcu bola uložená',
      roleId: result.insertId || null,
      name: String(name).trim(),
      permissions: sanitizedPermissions
    });
  } catch (error) {
    next(error);
  }
});

router.put('/club/:clubId/manager-roles/:roleId', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(clubId) || clubId <= 0 || !Number.isInteger(roleId) || roleId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId alebo roleId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať role klubu' });
    }

    const { name = '', permissions = [] } = req.body;
    if (!String(name).trim()) {
      return res.status(400).json({ error: 'Názov roly je povinný' });
    }
    if (!Array.isArray(permissions)) {
      return res.status(400).json({ error: 'permissions musí byť pole' });
    }

    const sanitizedPermissions = [...new Set(
      permissions
        .map((permission) => String(permission || '').trim())
        .filter((permission) => FLAT_PERMISSION_CATALOG.includes(permission))
    )];

    const [existing] = await db.query(
      `SELECT id FROM club_manager_roles WHERE id = ? AND club_id = ? LIMIT 1`,
      [roleId, clubId]
    );

    if (!existing.length) {
      return res.status(404).json({ error: 'Rola správcu nebola nájdená' });
    }

    const [result] = await db.query(
      `UPDATE club_manager_roles
       SET role_name = ?, permissions_json = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND club_id = ?`,
      [String(name).trim(), JSON.stringify(sanitizedPermissions), roleId, clubId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Rola správcu nebola nájdená' });
    }

    res.json({
      message: 'Rola správcu bola upravená',
      roleId,
      name: String(name).trim(),
      permissions: sanitizedPermissions
    });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Rola s týmto názvom už existuje' });
    }
    next(error);
  }
});

router.delete('/club/:clubId/manager-roles/:roleId', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    const roleId = Number(req.params.roleId);
    if (!Number.isInteger(clubId) || clubId <= 0 || !Number.isInteger(roleId) || roleId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId alebo roleId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať role klubu' });
    }

    const [assignedRows] = await db.query(
      `SELECT COUNT(*) AS total FROM club_managers WHERE club_id = ? AND manager_role_id = ?`,
      [clubId, roleId]
    );

    const assignedCount = Number(assignedRows?.[0]?.total || 0);
    if (assignedCount > 0) {
      return res.status(400).json({ error: 'Rolu nie je možné odstrániť, pretože je priradená správcom klubu' });
    }

    const [result] = await db.query(
      `DELETE FROM club_manager_roles WHERE id = ? AND club_id = ?`,
      [roleId, clubId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Rola správcu nebola nájdená' });
    }

    res.json({ message: 'Rola správcu bola odstránená' });
  } catch (error) {
    next(error);
  }
});

router.get('/club/:clubId/managers', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať správcov klubu' });
    }

    const [rows] = await db.query(
      `SELECT m.id, m.first_name, m.last_name, m.email, m.mobile, m.photo_url,
              r.id AS role_id, r.role_name
       FROM club_managers m
       JOIN club_manager_roles r ON r.id = m.manager_role_id
       WHERE m.club_id = ?
       ORDER BY m.last_name, m.first_name`,
      [clubId]
    );

    res.json({
      total: rows.length,
      managers: rows.map((row) => ({
        id: row.id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        mobile: row.mobile || '',
        photo: row.photo_url || '',
        roleId: row.role_id,
        roleName: row.role_name
      }))
    });
  } catch (error) {
    next(error);
  }
});

router.post('/club/:clubId/managers', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať správcov klubu' });
    }

    const { firstName = '', lastName = '', email = '', mobile = '', photo = '', roleId } = req.body;
    if (!String(firstName).trim() || !String(lastName).trim() || !String(email).trim()) {
      return res.status(400).json({ error: 'Meno, priezvisko a email sú povinné' });
    }

    const numericRoleId = Number(roleId);
    if (!Number.isInteger(numericRoleId) || numericRoleId <= 0) {
      return res.status(400).json({ error: 'Vyberte rolu správcu' });
    }

    const [roleRows] = await db.query(
      `SELECT id FROM club_manager_roles WHERE id = ? AND club_id = ? LIMIT 1`,
      [numericRoleId, clubId]
    );

    if (!roleRows.length) {
      return res.status(404).json({ error: 'Rola správcu nebola nájdená' });
    }

    const [result] = await db.query(
      `INSERT INTO club_managers (club_id, first_name, last_name, email, mobile, photo_url, manager_role_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        clubId,
        String(firstName).trim(),
        String(lastName).trim(),
        String(email).trim(),
        String(mobile || '').trim(),
        String(photo || '').trim() || null,
        numericRoleId
      ]
    );

    res.status(201).json({
      message: 'Správca klubu bol pridaný',
      managerId: result.insertId
    });
  } catch (error) {
    next(error);
  }
});

router.put('/club/:clubId/managers/:managerId', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    const managerId = Number(req.params.managerId);
    if (!Number.isInteger(clubId) || clubId <= 0 || !Number.isInteger(managerId) || managerId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId alebo managerId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať správcov klubu' });
    }

    const { firstName = '', lastName = '', email = '', mobile = '', photo = '', roleId } = req.body;
    if (!String(firstName).trim() || !String(lastName).trim() || !String(email).trim()) {
      return res.status(400).json({ error: 'Meno, priezvisko a email sú povinné' });
    }

    const numericRoleId = Number(roleId);
    if (!Number.isInteger(numericRoleId) || numericRoleId <= 0) {
      return res.status(400).json({ error: 'Vyberte rolu správcu' });
    }

    const [roleRows] = await db.query(
      `SELECT id FROM club_manager_roles WHERE id = ? AND club_id = ? LIMIT 1`,
      [numericRoleId, clubId]
    );

    if (!roleRows.length) {
      return res.status(404).json({ error: 'Rola správcu nebola nájdená' });
    }

    const [result] = await db.query(
      `UPDATE club_managers
       SET first_name = ?, last_name = ?, email = ?, mobile = ?, photo_url = ?, manager_role_id = ?
       WHERE id = ? AND club_id = ?`,
      [
        String(firstName).trim(),
        String(lastName).trim(),
        String(email).trim(),
        String(mobile || '').trim(),
        String(photo || '').trim() || null,
        numericRoleId,
        managerId,
        clubId
      ]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Správca klubu nebol nájdený' });
    }

    res.json({ message: 'Správca klubu bol upravený' });
  } catch (error) {
    next(error);
  }
});

router.delete('/club/:clubId/managers/:managerId', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    const managerId = Number(req.params.managerId);
    if (!Number.isInteger(clubId) || clubId <= 0 || !Number.isInteger(managerId) || managerId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId alebo managerId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať správcov klubu' });
    }

    const [result] = await db.query(
      `DELETE FROM club_managers WHERE id = ? AND club_id = ?`,
      [managerId, clubId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Správca klubu nebol nájdený' });
    }

    res.json({ message: 'Správca klubu bol odobratý' });
  } catch (error) {
    next(error);
  }
});

router.get('/club/:clubId/visible-sections', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať zobrazené sekcie' });
    }

    const config = await getClubVisibleSectionsConfig(clubId);

    res.json({
      clubId,
      roles: config
    });
  } catch (error) {
    next(error);
  }
});

router.put('/club/:clubId/visible-sections', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    await ensurePermissionsTable(connection);
    await ensureManagerTables(connection);
    await ensureVisibleSectionsTable(connection);

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať zobrazené sekcie' });
    }

    const payload = req.body?.roles || {};

    const normalized = {
      club: normalizeVisibleSections(payload.club, DEFAULT_VISIBLE_SECTIONS_BY_ROLE.club),
      coach: normalizeVisibleSections(payload.coach, DEFAULT_VISIBLE_SECTIONS_BY_ROLE.coach),
      parent: normalizeVisibleSections(payload.parent, DEFAULT_VISIBLE_SECTIONS_BY_ROLE.parent),
      player: normalizeVisibleSections(payload.player, DEFAULT_VISIBLE_SECTIONS_BY_ROLE.player)
    };

    await connection.beginTransaction();

    for (const roleKey of SETTINGS_VISIBLE_ROLES) {
      await connection.query(
        `INSERT INTO club_visible_sections (club_id, role_key, sections_json)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE
           sections_json = VALUES(sections_json),
           updated_at = CURRENT_TIMESTAMP`,
        [clubId, roleKey, JSON.stringify(normalized[roleKey])]
      );
    }

    await connection.commit();

    res.json({
      message: 'Zobrazené sekcie boli uložené',
      clubId,
      roles: normalized
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

router.get('/me/visible-sections', authenticateToken, async (req, res, next) => {
  try {
    await ensurePermissionsTable();
    await ensureManagerTables();
    await ensureVisibleSectionsTable();

    const normalizedRole = req.user.role === 'club_admin'
      ? 'club'
      : req.user.role;

    const clubId = await resolveUserClubId({ userId: req.user.id, role: normalizedRole });
    if (!clubId) {
      return res.json({
        role: normalizedRole,
        sections: [...(DEFAULT_VISIBLE_SECTIONS_BY_ROLE[normalizedRole] || [])],
        source: 'default'
      });
    }

    const config = await getClubVisibleSectionsConfig(clubId);
    const sections = config[normalizedRole] || DEFAULT_VISIBLE_SECTIONS_BY_ROLE[normalizedRole] || [];

    res.json({
      clubId,
      role: normalizedRole,
      sections,
      source: 'club'
    });
  } catch (error) {
    next(error);
  }
});

router.get('/club/:clubId/trainer-functions', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    await ensurePermissionsTable(connection);
    await ensureManagerTables(connection);
    await ensureVisibleSectionsTable(connection);
    await ensureTrainerFunctionsTable(connection);

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať funkcie trénerov' });
    }

    await ensureDefaultTrainerFunctions(connection, clubId);

    const [rows] = await connection.query(
      `SELECT id, function_name, base_role
       FROM club_trainer_functions
       WHERE club_id = ?
       ORDER BY id ASC`,
      [clubId]
    );

    res.json({
      total: rows.length,
      functions: rows.map((row) => ({
        id: row.id,
        name: row.function_name,
        baseRole: normalizeTrainerBaseRole(row.base_role),
        isDefault: isDefaultTrainerFunctionName(row.function_name)
      }))
    });
  } catch (error) {
    next(error);
  } finally {
    connection.release();
  }
});

router.post('/club/:clubId/trainer-functions', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    await ensurePermissionsTable(connection);
    await ensureManagerTables(connection);
    await ensureVisibleSectionsTable(connection);
    await ensureTrainerFunctionsTable(connection);

    const clubId = Number(req.params.clubId);
    if (!Number.isInteger(clubId) || clubId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať funkcie trénerov' });
    }

    const name = String(req.body?.name || '').trim();
    const baseRole = resolveTrainerBaseRoleFromName(name);

    if (!name) {
      return res.status(400).json({ error: 'Názov funkcie je povinný' });
    }

    const [result] = await connection.query(
      `INSERT INTO club_trainer_functions (club_id, function_name, base_role)
       VALUES (?, ?, ?)`,
      [clubId, name, baseRole]
    );

    res.status(201).json({
      message: 'Funkcia trénera bola uložená',
      function: {
        id: result.insertId,
        name,
        baseRole,
        isDefault: false
      }
    });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Funkcia s týmto názvom už existuje' });
    }
    next(error);
  } finally {
    connection.release();
  }
});

router.put('/club/:clubId/trainer-functions/:functionId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    await ensurePermissionsTable(connection);
    await ensureManagerTables(connection);
    await ensureVisibleSectionsTable(connection);
    await ensureTrainerFunctionsTable(connection);

    const clubId = Number(req.params.clubId);
    const functionId = Number(req.params.functionId);
    if (!Number.isInteger(clubId) || clubId <= 0 || !Number.isInteger(functionId) || functionId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId alebo functionId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať funkcie trénerov' });
    }

    const [existingRows] = await connection.query(
      `SELECT function_name
       FROM club_trainer_functions
       WHERE id = ? AND club_id = ?
       LIMIT 1`,
      [functionId, clubId]
    );

    if (!existingRows.length) {
      return res.status(404).json({ error: 'Funkcia trénera nebola nájdená' });
    }

    if (isDefaultTrainerFunctionName(existingRows[0].function_name)) {
      return res.status(400).json({ error: 'Predvolenú funkciu trénera nie je možné upraviť' });
    }

    const name = String(req.body?.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Názov funkcie je povinný' });
    }

    const baseRole = resolveTrainerBaseRoleFromName(name);

    const [result] = await connection.query(
      `UPDATE club_trainer_functions
       SET function_name = ?,
           base_role = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND club_id = ?`,
      [name, baseRole, functionId, clubId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Funkcia trénera nebola nájdená' });
    }

    res.json({
      message: 'Funkcia trénera bola upravená',
      function: {
        id: functionId,
        name,
        baseRole,
        isDefault: false
      }
    });
  } catch (error) {
    if (error && error.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ error: 'Funkcia s týmto názvom už existuje' });
    }
    next(error);
  } finally {
    connection.release();
  }
});

router.delete('/club/:clubId/trainer-functions/:functionId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    await ensurePermissionsTable(connection);
    await ensureManagerTables(connection);
    await ensureVisibleSectionsTable(connection);
    await ensureTrainerFunctionsTable(connection);

    const clubId = Number(req.params.clubId);
    const functionId = Number(req.params.functionId);
    if (!Number.isInteger(clubId) || clubId <= 0 || !Number.isInteger(functionId) || functionId <= 0) {
      return res.status(400).json({ error: 'Neplatné clubId alebo functionId' });
    }

    const canManage = await ensureClubManager({ clubId, userId: req.user.id, role: req.user.role });
    if (!canManage) {
      return res.status(403).json({ error: 'Nemáte oprávnenie spravovať funkcie trénerov' });
    }

    const [rows] = await connection.query(
      `SELECT function_name
       FROM club_trainer_functions
       WHERE id = ? AND club_id = ?
       LIMIT 1`,
      [functionId, clubId]
    );

    if (!rows.length) {
      return res.status(404).json({ error: 'Funkcia trénera nebola nájdená' });
    }

    if (isDefaultTrainerFunctionName(rows[0].function_name)) {
      return res.status(400).json({ error: 'Predvolenú funkciu trénera nie je možné odstrániť' });
    }

    const [result] = await connection.query(
      `DELETE FROM club_trainer_functions
       WHERE id = ? AND club_id = ?`,
      [functionId, clubId]
    );

    if (!result.affectedRows) {
      return res.status(404).json({ error: 'Funkcia trénera nebola nájdená' });
    }

    res.json({ message: 'Funkcia trénera bola odstránená' });
  } catch (error) {
    next(error);
  } finally {
    connection.release();
  }
});

module.exports = router;
