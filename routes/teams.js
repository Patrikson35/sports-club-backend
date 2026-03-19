const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');
const crypto = require('crypto');

const ensureUsersVirtualColumn = async (connection = db) => {
  try {
    await connection.query('ALTER TABLE users ADD COLUMN is_virtual BOOLEAN DEFAULT FALSE');
  } catch (error) {
    if (error?.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }
};

const ensureTeamsSortOrderColumn = async (connection = db) => {
  try {
    await connection.query('ALTER TABLE teams ADD COLUMN sort_order INT NOT NULL DEFAULT 0');
  } catch (error) {
    if (error?.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }

  await connection.query(
    `UPDATE teams
     SET sort_order = id
     WHERE sort_order IS NULL OR sort_order = 0`
  );
};

const resolveUserClubId = async (connection, userId) => {
  try {
    const [owned] = await connection.query('SELECT id FROM clubs WHERE owner_id = ? LIMIT 1', [userId]);
    if (owned.length) return owned[0].id;
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      throw error;
    }
  }

  try {
    const [viaUser] = await connection.query('SELECT club_id FROM users WHERE id = ? LIMIT 1', [userId]);
    if (viaUser.length && viaUser[0].club_id) return viaUser[0].club_id;
  } catch (error) {
    if (error?.code !== 'ER_BAD_FIELD_ERROR') {
      throw error;
    }
  }

  const [member] = await connection.query(
    `SELECT club_id
     FROM club_members
     WHERE user_id = ? AND is_active = TRUE
     ORDER BY id ASC
     LIMIT 1`,
    [userId]
  );

  return member.length ? member[0].club_id : null;
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

// GET /api/teams - Get all teams
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    await ensureTeamsSortOrderColumn(db);

    const role = req.user?.role;
    const params = [];
    let whereClause = '';

    if (role !== 'admin') {
      const clubId = await resolveUserClubId(db, req.user.id);
      if (!clubId) {
        return res.json({ total: 0, teams: [] });
      }

      whereClause = 'WHERE t.club_id = ?';
      params.push(clubId);
    }

    const [teams] = await db.query(
      `SELECT
         t.id,
         t.name,
         t.club_id,
         t.coach_id,
         t.sort_order,
         c.name AS club_name
       FROM teams t
       LEFT JOIN clubs c ON t.club_id = c.id
       ${whereClause}
       ORDER BY t.sort_order ASC, t.id ASC`,
      params
    );
    
    res.json({
      total: teams.length,
      teams: teams.map(t => ({
        id: t.id,
        name: t.name,
        ageGroup: t.age_group || t.name,
        season: t.season || null,
        coachId: t.coach_id,
        sortOrder: t.sort_order,
        playerCount: Number(t.player_count || 0),
        club: {
          id: t.club_id,
          name: t.club_name
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/teams - Create new team/category
router.post('/', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie vytvárať kategórie' });
    }

    const { name, ageGroup, season, clubId } = req.body;
    const trainerLastName = String(req.body?.trainerLastName || req.body?.trainerName || '').trim();
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Názov kategórie je povinný' });
    }

    const effectiveClubId = Number(clubId) || await resolveUserClubId(connection, req.user.id);
    if (!effectiveClubId) {
      return res.status(400).json({ error: 'Chýba klub pre vytvorenie kategórie' });
    }

    await connection.beginTransaction();
    await ensureUsersVirtualColumn(connection);
    await ensureTeamsSortOrderColumn(connection);

    let coachId = null;
    let createdVirtualCoachId = null;

    if (trainerLastName) {
      const [existingCoaches] = await connection.query(
        `SELECT u.id
         FROM club_members cm
         JOIN users u ON u.id = cm.user_id
         WHERE cm.club_id = ?
           AND cm.is_active = TRUE
           AND cm.member_role = 'coach'
           AND u.last_name = ?
         ORDER BY u.id ASC
         LIMIT 1`,
        [effectiveClubId, trainerLastName]
      );

      if (existingCoaches.length) {
        coachId = existingCoaches[0].id;
      } else {
        const virtualCoachEmail = `virtual_coach_${effectiveClubId}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}@sportsclub.local`;

        const [virtualCoachResult] = await connection.query(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, is_virtual, is_active, is_verified, created_at)
           VALUES (?, '', ?, ?, 'coach', TRUE, TRUE, FALSE, NOW())`,
          [virtualCoachEmail, '', trainerLastName]
        );

        createdVirtualCoachId = virtualCoachResult.insertId;
        coachId = createdVirtualCoachId;

        await connection.query(
          `INSERT INTO club_members (club_id, user_id, member_role, added_by, is_active)
           VALUES (?, ?, 'coach', ?, TRUE)
           ON DUPLICATE KEY UPDATE
             member_role = VALUES(member_role),
             is_active = TRUE,
             left_at = NULL,
             updated_at = CURRENT_TIMESTAMP`,
          [effectiveClubId, createdVirtualCoachId, req.user.id]
        );
      }
    }

    const normalizedCategory = (ageGroup || String(name).trim()).toString().trim();

    const [sortRows] = await connection.query(
      `SELECT COALESCE(MAX(sort_order), 0) + 1 AS next_sort_order
       FROM teams
       WHERE club_id = ?`,
      [effectiveClubId]
    );
    const nextSortOrder = Number(sortRows?.[0]?.next_sort_order || 1);

    const [result] = await connection.query(
      `INSERT INTO teams (club_id, name, category, age_group, season, coach_id, sort_order, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, TRUE, NOW())`,
      [
        effectiveClubId,
        String(name).trim(),
        normalizedCategory,
        normalizedCategory,
        (season || '').toString().trim() || null,
        coachId,
        nextSortOrder
      ]
    );

    await connection.commit();

    res.status(201).json({
      message: 'Kategória bola úspešne vytvorená',
      teamId: result.insertId,
      clubId: effectiveClubId,
      coachId,
      virtualCoachCreated: Boolean(createdVirtualCoachId),
      virtualCoachId: createdVirtualCoachId
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

// PUT /api/teams/reorder - Persist category ordering
router.put('/reorder', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie upravovať poradie kategórií' });
    }

    const orderedTeamIdsRaw = Array.isArray(req.body?.orderedTeamIds) ? req.body.orderedTeamIds : [];
    if (orderedTeamIdsRaw.length === 0) {
      return res.status(400).json({ error: 'Zoznam kategórií na zoradenie je povinný' });
    }

    const orderedTeamIds = [...new Set(
      orderedTeamIdsRaw
        .map((value) => Number(value))
        .filter((value) => Number.isInteger(value) && value > 0)
    )];

    if (orderedTeamIds.length === 0) {
      return res.status(400).json({ error: 'Zoznam kategórií na zoradenie obsahuje neplatné hodnoty' });
    }

    await ensureTeamsSortOrderColumn(connection);

    const effectiveClubId = Number(req.body?.clubId) || await resolveUserClubId(connection, req.user.id);
    if (!effectiveClubId) {
      return res.status(400).json({ error: 'Chýba klub pre zoradenie kategórií' });
    }

    let clubTeams = [];
    try {
      const [rows] = await connection.query(
        `SELECT id
         FROM teams
         WHERE club_id = ? AND is_active = TRUE
         ORDER BY sort_order ASC, id ASC`,
        [effectiveClubId]
      );
      clubTeams = rows;
    } catch (error) {
      if (error?.code !== 'ER_BAD_FIELD_ERROR') {
        throw error;
      }

      const [rows] = await connection.query(
        `SELECT id
         FROM teams
         WHERE club_id = ?
         ORDER BY sort_order ASC, id ASC`,
        [effectiveClubId]
      );
      clubTeams = rows;
    }

    const existingIds = clubTeams.map((row) => Number(row.id));
    if (existingIds.length === 0) {
      return res.status(404).json({ error: 'V klube neexistujú žiadne kategórie' });
    }

    const existingIdSet = new Set(existingIds);
    const unknownIds = orderedTeamIds.filter((id) => !existingIdSet.has(id));
    if (unknownIds.length > 0) {
      return res.status(400).json({ error: 'Niektoré kategórie nepatria do vášho klubu' });
    }

    const remainingIds = existingIds.filter((id) => !orderedTeamIds.includes(id));
    const finalOrder = [...orderedTeamIds, ...remainingIds];

    await connection.beginTransaction();

    for (let index = 0; index < finalOrder.length; index += 1) {
      await connection.query(
        `UPDATE teams
         SET sort_order = ?,
             updated_at = NOW()
         WHERE id = ? AND club_id = ?`,
        [index + 1, finalOrder[index], effectiveClubId]
      );
    }

    await connection.commit();

    res.json({
      message: 'Poradie kategórií bolo uložené',
      orderedTeamIds: finalOrder
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

// GET /api/teams/:id - Get team detail
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    const scopedTeamIds = await getScopedTeamIds(db, req.user);
    if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(teamId)) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto tímu' });
    }

    const [teams] = await db.query(`
      SELECT t.*, c.name as club_name
      FROM teams t
      LEFT JOIN clubs c ON t.club_id = c.id
      WHERE t.id = ? AND t.is_active = TRUE
    `, [teamId]);
    
    if (teams.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const team = teams[0];
    
    // Get players
    const [players] = await db.query(`
      SELECT 
        p.id,
        p.jersey_number,
        p.position,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM team_memberships p
      JOIN users u ON p.user_id = u.id
      WHERE p.team_id = ? AND p.is_active = TRUE
      ORDER BY p.jersey_number
    `, [teamId]);
    
    res.json({
      id: team.id,
      name: team.name,
      ageGroup: team.age_group,
      season: team.season,
      club: {
        id: team.club_id,
        name: team.club_name
      },
      players: players.map(p => ({
        id: p.id,
        jerseyNumber: p.jersey_number,
        position: p.position,
        firstName: p.first_name,
        lastName: p.last_name,
        name: `${p.first_name} ${p.last_name}`,
        avatar: p.avatar_url
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/teams/:id/players - Get team players
router.get('/:id/players', authenticateToken, async (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    const scopedTeamIds = await getScopedTeamIds(db, req.user);
    if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(teamId)) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto tímu' });
    }

    const [players] = await db.query(`
      SELECT 
        p.id,
        p.user_id,
        p.jersey_number,
        p.position,
        u.first_name,
        u.last_name,
        u.email,
        u.date_of_birth,
        u.avatar_url
      FROM team_memberships p
      JOIN users u ON p.user_id = u.id
      WHERE p.team_id = ? AND p.is_active = TRUE
      ORDER BY p.jersey_number
    `, [teamId]);
    
    res.json({
      total: players.length,
      players: players.map(p => ({
        id: p.id,
        membershipId: p.id,
        userId: p.user_id,
        jerseyNumber: p.jersey_number,
        position: p.position,
        firstName: p.first_name,
        lastName: p.last_name,
        name: `${p.first_name} ${p.last_name}`,
        email: p.email,
        dateOfBirth: p.date_of_birth,
        avatar: p.avatar_url
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/teams/:id/candidates - Get club players as candidate members for a team
router.get('/:id/candidates', authenticateToken, async (req, res, next) => {
  try {
    const teamId = Number(req.params.id);
    if (!Number.isInteger(teamId) || teamId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID kategórie' });
    }

    const scopedTeamIds = await getScopedTeamIds(db, req.user);
    if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(teamId)) {
      return res.status(403).json({ error: 'Nemáte prístup k tejto kategórii' });
    }

    const [teamRows] = await db.query('SELECT club_id FROM teams WHERE id = ? AND is_active = TRUE LIMIT 1', [teamId]);
    if (!teamRows.length) {
      return res.status(404).json({ error: 'Kategória nebola nájdená' });
    }

    const clubId = teamRows[0].club_id;

    const [rows] = await db.query(
      `SELECT
         u.id AS user_id,
         u.first_name,
         u.last_name,
         u.email,
         MAX(CASE WHEN tm.team_id = ? THEN 1 ELSE 0 END) AS in_current_team,
         COUNT(DISTINCT tm.team_id) AS active_teams_count
       FROM club_members cm
       JOIN users u ON u.id = cm.user_id
       LEFT JOIN team_memberships tm ON tm.user_id = u.id AND tm.is_active = TRUE
       WHERE cm.club_id = ?
         AND cm.is_active = TRUE
         AND u.role = 'player'
       GROUP BY u.id, u.first_name, u.last_name, u.email
       ORDER BY u.last_name, u.first_name`,
      [teamId, clubId]
    );

    res.json({
      total: rows.length,
      candidates: rows.map((row) => ({
        userId: row.user_id,
        firstName: row.first_name,
        lastName: row.last_name,
        email: row.email,
        activeTeamsCount: Number(row.active_teams_count || 0),
        isInCurrentTeam: Number(row.in_current_team) === 1
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/teams/:id/players - Assign player to team
router.post('/:id/players', authenticateToken, async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie upravovať kategórie' });
    }

    const teamId = Number(req.params.id);
    const userId = Number(req.body?.userId);
    const jerseyNumber = req.body?.jerseyNumber ?? null;
    const position = req.body?.position ?? null;

    if (!Number.isInteger(teamId) || teamId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID kategórie' });
    }

    if (!Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID hráča' });
    }

    const allowed = await canManageTeam(db, req.user, teamId);
    if (!allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tejto kategórii' });
    }

    const [teamRows] = await db.query('SELECT club_id FROM teams WHERE id = ? AND is_active = TRUE LIMIT 1', [teamId]);
    if (!teamRows.length) {
      return res.status(404).json({ error: 'Kategória nebola nájdená' });
    }
    const teamClubId = teamRows[0].club_id;

    const [players] = await db.query('SELECT id, role FROM users WHERE id = ? LIMIT 1', [userId]);
    if (!players.length || players[0].role !== 'player') {
      return res.status(400).json({ error: 'Používateľ nie je hráč' });
    }

    const [clubMember] = await db.query(
      `SELECT id FROM club_members
       WHERE club_id = ? AND user_id = ? AND is_active = TRUE LIMIT 1`,
      [teamClubId, userId]
    );
    if (!clubMember.length) {
      return res.status(400).json({ error: 'Hráč nepatrí do tohto klubu' });
    }

    const [existingMembership] = await db.query(
      `SELECT id
       FROM team_memberships
       WHERE team_id = ? AND user_id = ? AND is_active = TRUE
       LIMIT 1`,
      [teamId, userId]
    );

    if (existingMembership.length) {
      return res.json({ message: 'Hráč už je priradený v tejto kategórii' });
    }

    await db.query(
      `INSERT INTO team_memberships (team_id, user_id, jersey_number, position, joined_date, is_active, created_at)
       VALUES (?, ?, ?, ?, CURDATE(), TRUE, NOW())`,
      [teamId, userId, jerseyNumber, position]
    );

    res.status(201).json({ message: 'Hráč bol úspešne priradený do kategórie' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/teams/:id/players/:userId - Remove player from team
router.delete('/:id/players/:userId', authenticateToken, async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie upravovať kategórie' });
    }

    const teamId = Number(req.params.id);
    const userId = Number(req.params.userId);

    if (!Number.isInteger(teamId) || teamId <= 0 || !Number.isInteger(userId) || userId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID kategórie alebo hráča' });
    }

    const allowed = await canManageTeam(db, req.user, teamId);
    if (!allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tejto kategórii' });
    }

    const [result] = await db.query(
      `UPDATE team_memberships
       SET is_active = FALSE,
           left_date = CURDATE()
       WHERE team_id = ? AND user_id = ? AND is_active = TRUE`,
      [teamId, userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Hráč nie je aktívne priradený v tejto kategórii' });
    }

    res.json({ message: 'Hráč bol odobratý z kategórie' });
  } catch (error) {
    next(error);
  }
});

const canManageTeam = async (connection, reqUser, teamId) => {
  if (reqUser?.role === 'admin') return true;

  const [teamRows] = await connection.query('SELECT club_id FROM teams WHERE id = ? LIMIT 1', [teamId]);
  if (!teamRows.length) return false;
  const teamClubId = teamRows[0].club_id;

  const ownClubId = await resolveUserClubId(connection, reqUser.id);
  return Boolean(ownClubId && Number(ownClubId) === Number(teamClubId));
};

// PUT /api/teams/:id - Update category/team
router.put('/:id', authenticateToken, async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie upravovať kategórie' });
    }

    const teamId = Number(req.params.id);
    if (!Number.isInteger(teamId) || teamId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID kategórie' });
    }

    const allowed = await canManageTeam(db, req.user, teamId);
    if (!allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k úprave tejto kategórie' });
    }

    const { name, ageGroup, season } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ error: 'Názov kategórie je povinný' });
    }

    const [result] = await db.query(
      `UPDATE teams
       SET name = ?,
           age_group = ?,
           season = ?,
           updated_at = NOW()
       WHERE id = ? AND is_active = TRUE`,
      [
        String(name).trim(),
        (ageGroup || String(name).trim()).toString().trim(),
        (season || '').toString().trim() || null,
        teamId
      ]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Kategória nebola nájdená' });
    }

    res.json({ message: 'Kategória bola úspešne upravená' });
  } catch (error) {
    next(error);
  }
});

// DELETE /api/teams/:id - Soft delete category/team
router.delete('/:id', authenticateToken, async (req, res, next) => {
  try {
    const role = req.user?.role;
    if (!['admin', 'club', 'coach', 'assistant'].includes(role)) {
      return res.status(403).json({ error: 'Nemáte oprávnenie mazať kategórie' });
    }

    const teamId = Number(req.params.id);
    if (!Number.isInteger(teamId) || teamId <= 0) {
      return res.status(400).json({ error: 'Neplatné ID kategórie' });
    }

    const allowed = await canManageTeam(db, req.user, teamId);
    if (!allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k mazaniu tejto kategórie' });
    }

    const [result] = await db.query(
      `UPDATE teams
       SET is_active = FALSE,
           updated_at = NOW()
       WHERE id = ? AND is_active = TRUE`,
      [teamId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'Kategória nebola nájdená' });
    }

    res.json({ message: 'Kategória bola úspešne zmazaná' });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
