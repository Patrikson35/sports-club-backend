const express = require('express');
const router = express.Router();
const db = require('../config/database');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { authenticateToken, requireRole } = require('../middleware/auth');

const ensureParentTables = async (connection = db) => {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS parents (
      id INT AUTO_INCREMENT PRIMARY KEY,
      first_name VARCHAR(100) NOT NULL,
      last_name VARCHAR(100) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await connection.query(`
    CREATE TABLE IF NOT EXISTS parent_child_links (
      id INT AUTO_INCREMENT PRIMARY KEY,
      parent_id INT NOT NULL,
      child_user_id INT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_parent_child (parent_id, child_user_id),
      FOREIGN KEY (parent_id) REFERENCES parents(id) ON DELETE CASCADE,
      FOREIGN KEY (child_user_id) REFERENCES users(id) ON DELETE CASCADE
    )
  `);
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

const ensureUsersVirtualColumn = async (connection = db) => {
  try {
    await connection.query(`ALTER TABLE users ADD COLUMN is_virtual BOOLEAN DEFAULT FALSE`);
  } catch (error) {
    if (error?.code !== 'ER_DUP_FIELDNAME') {
      throw error;
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

// GET /api/players - Get all players
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { teamId, search } = req.query;
    const role = req.user?.role;
    
    let query = `
      SELECT 
        p.id,
        p.jersey_number,
        p.position,
        p.is_active,
        u.id as user_id,
        u.first_name,
        u.last_name,
        u.email,
        u.date_of_birth,
        u.avatar_url,
        t.id as team_id,
        t.name as team_name,
        t.age_group
      FROM team_memberships p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN teams t ON p.team_id = t.id
      WHERE p.is_active = TRUE
    `;
    
    const params = [];
    
    if (teamId) {
      query += ' AND p.team_id = ?';
      params.push(teamId);
    }
    
    if (search) {
      query += ' AND (u.first_name LIKE ? OR u.last_name LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }

    if (role === 'player') {
      query += ' AND u.id = ?';
      params.push(req.user.id);
    }

    if (role === 'parent') {
      const childUserIds = await getParentScopedChildUserIds(db, req.user.id);
      if (!childUserIds.length) {
        return res.json({ total: 0, players: [] });
      }

      query += ` AND u.id IN (${childUserIds.map(() => '?').join(',')})`;
      params.push(...childUserIds);
    }
    
    query += ' ORDER BY u.last_name, u.first_name';
    
    const [players] = await db.query(query, params);
    
    res.json({
      total: players.length,
      players: players.map(p => ({
        id: p.id,
        userId: p.user_id,
        firstName: p.first_name,
        lastName: p.last_name,
        name: `${p.first_name} ${p.last_name}`,
        email: p.email,
        dateOfBirth: p.date_of_birth,
        avatar: p.avatar_url,
        jerseyNumber: p.jersey_number,
        position: p.position,
        team: p.team_id ? {
          id: p.team_id,
          name: p.team_name,
          ageGroup: p.age_group
        } : null
      }))
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/players/my-profile - Complete own player profile (18+ flow)
router.put('/my-profile', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    if (req.user?.role !== 'player') {
      return res.status(403).json({ error: 'Endpoint je dostupný iba pre hráča' });
    }

    const { clubName, personalId, photo } = req.body;

    if (!clubName || !String(clubName).trim()) {
      return res.status(400).json({ error: 'Pole klub je povinné' });
    }

    if (!personalId || !String(personalId).trim()) {
      return res.status(400).json({ error: 'Rodné číslo je povinné' });
    }

    await connection.beginTransaction();
    await ensurePlayerProfilesTable(connection);

    await connection.query(
      'UPDATE users SET avatar_url = ? WHERE id = ?',
      [photo || null, req.user.id]
    );

    await connection.query(
      `INSERT INTO player_profiles (user_id, club_name, personal_id, photo_url)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         club_name = VALUES(club_name),
         personal_id = VALUES(personal_id),
         photo_url = VALUES(photo_url),
         updated_at = CURRENT_TIMESTAMP`,
      [
        req.user.id,
        String(clubName).trim(),
        String(personalId).trim(),
        photo || null
      ]
    );

    await connection.commit();

    res.json({ message: 'Profil hráča bol úspešne uložený' });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// GET /api/players/my-profile - Get own player profile (18+ flow)
router.get('/my-profile', authenticateToken, async (req, res, next) => {
  try {
    if (req.user?.role !== 'player') {
      return res.status(403).json({ error: 'Endpoint je dostupný iba pre hráča' });
    }

    await ensurePlayerProfilesTable();

    const [profiles] = await db.query(
      `SELECT pp.club_name, pp.personal_id, pp.photo_url, u.avatar_url
       FROM users u
       LEFT JOIN player_profiles pp ON pp.user_id = u.id
       WHERE u.id = ?
       LIMIT 1`,
      [req.user.id]
    );

    const profile = profiles[0] || {};

    res.json({
      clubName: profile.club_name || '',
      personalId: profile.personal_id || '',
      photo: profile.photo_url || profile.avatar_url || ''
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/players/my-children-profiles - Save parent-flow children profiles
router.put('/my-children-profiles', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    if (req.user?.role !== 'player') {
      return res.status(403).json({ error: 'Endpoint je dostupný iba pre hráča' });
    }

    const children = Array.isArray(req.body?.children) ? req.body.children : [];

    if (!children.length) {
      return res.status(400).json({ error: 'Je potrebné pridať aspoň jedno dieťa' });
    }

    const hasInvalidChild = children.some((child) => {
      return !child
        || !String(child.firstName || '').trim()
        || !String(child.lastName || '').trim()
        || !String(child.clubName || '').trim()
        || !String(child.personalId || '').trim();
    });

    if (hasInvalidChild) {
      return res.status(400).json({ error: 'Meno, priezvisko, klub a rodné číslo sú povinné pre každé dieťa' });
    }

    await connection.beginTransaction();
    await ensureParentTables(connection);
    await ensurePlayerProfilesTable(connection);

    const [parentLinks] = await connection.query(
      'SELECT parent_id FROM parent_child_links WHERE child_user_id = ? LIMIT 1',
      [req.user.id]
    );

    if (!parentLinks.length) {
      await connection.rollback();
      return res.status(400).json({ error: 'Pre aktuálneho používateľa neexistuje parent-child väzba' });
    }

    const parentId = parentLinks[0].parent_id;
    const savedChildUserIds = [];

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const firstName = String(child.firstName).trim();
      const lastName = String(child.lastName).trim();
      const clubName = String(child.clubName).trim();
      const personalId = String(child.personalId).trim();
      const photo = child.photo || null;

      let childUserId;

      if (index === 0) {
        childUserId = req.user.id;
        await connection.query(
          'UPDATE users SET first_name = ?, last_name = ?, avatar_url = ? WHERE id = ?',
          [firstName, lastName, photo, childUserId]
        );
      } else {
        const childEmail = `child_${parentId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@sportsclub.local`;
        const passwordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);

        const [childInsert] = await connection.query(
          `INSERT INTO users (email, password_hash, first_name, last_name, role, is_active, is_verified, avatar_url)
           VALUES (?, ?, ?, ?, 'player', TRUE, TRUE, ?)`,
          [childEmail, passwordHash, firstName, lastName, photo]
        );

        childUserId = childInsert.insertId;

        await connection.query(
          `INSERT INTO parent_child_links (parent_id, child_user_id)
           VALUES (?, ?)
           ON DUPLICATE KEY UPDATE created_at = created_at`,
          [parentId, childUserId]
        );
      }

      await connection.query(
        `INSERT INTO player_profiles (user_id, club_name, personal_id, photo_url)
         VALUES (?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           club_name = VALUES(club_name),
           personal_id = VALUES(personal_id),
           photo_url = VALUES(photo_url),
           updated_at = CURRENT_TIMESTAMP`,
        [childUserId, clubName, personalId, photo]
      );

      savedChildUserIds.push(childUserId);
    }

    await connection.commit();

    res.json({
      message: 'Profily detí boli úspešne uložené',
      childrenSaved: savedChildUserIds.length,
      childUserIds: savedChildUserIds
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// GET /api/players/my-children-profiles - Get parent-flow children profiles
router.get('/my-children-profiles', authenticateToken, async (req, res, next) => {
  try {
    if (req.user?.role !== 'player') {
      return res.status(403).json({ error: 'Endpoint je dostupný iba pre hráča' });
    }

    await ensureParentTables();
    await ensurePlayerProfilesTable();

    const [parentLinks] = await db.query(
      'SELECT parent_id FROM parent_child_links WHERE child_user_id = ? LIMIT 1',
      [req.user.id]
    );

    if (!parentLinks.length) {
      return res.json({ total: 0, children: [] });
    }

    const parentId = parentLinks[0].parent_id;

    const [rows] = await db.query(
      `SELECT
         u.id AS user_id,
         u.first_name,
         u.last_name,
         u.avatar_url,
         pp.club_name,
         pp.personal_id,
         pp.photo_url
       FROM parent_child_links pcl
       JOIN users u ON u.id = pcl.child_user_id
       LEFT JOIN player_profiles pp ON pp.user_id = u.id
       WHERE pcl.parent_id = ?
       ORDER BY (u.id = ?) DESC, pcl.id ASC`,
      [parentId, req.user.id]
    );

    res.json({
      total: rows.length,
      children: rows.map((row) => ({
        userId: row.user_id,
        firstName: row.first_name || '',
        lastName: row.last_name || '',
        clubName: row.club_name || '',
        personalId: row.personal_id || '',
        photo: row.photo_url || row.avatar_url || ''
      }))
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/players/unlink-child/:childUserId - Unlink child from parent flow (no delete)
router.post('/unlink-child/:childUserId', authenticateToken, async (req, res, next) => {
  const connection = await db.getConnection();

  try {
    if (req.user?.role !== 'player') {
      return res.status(403).json({ error: 'Endpoint je dostupný iba pre hráča' });
    }

    const childUserId = Number(req.params.childUserId);
    if (!Number.isInteger(childUserId) || childUserId <= 0) {
      return res.status(400).json({ error: 'Neplatné childUserId' });
    }

    if (childUserId === req.user.id) {
      return res.status(400).json({ error: 'Nie je možné odpojiť primárny účet dieťaťa' });
    }

    await connection.beginTransaction();
    await ensureParentTables(connection);
    await ensureUsersVirtualColumn(connection);

    const [parentLinks] = await connection.query(
      'SELECT parent_id FROM parent_child_links WHERE child_user_id = ? LIMIT 1',
      [req.user.id]
    );

    if (!parentLinks.length) {
      await connection.rollback();
      return res.status(400).json({ error: 'Pre aktuálneho používateľa neexistuje parent-child väzba' });
    }

    const parentId = parentLinks[0].parent_id;

    const [linkRows] = await connection.query(
      'SELECT id FROM parent_child_links WHERE parent_id = ? AND child_user_id = ? LIMIT 1',
      [parentId, childUserId]
    );

    if (!linkRows.length) {
      await connection.rollback();
      return res.status(404).json({ error: 'Väzba rodič-dieťa nebola nájdená' });
    }

    const virtualEmail = `unlinked_${childUserId}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}@sportsclub.local`;
    const passwordHash = await bcrypt.hash(crypto.randomBytes(16).toString('hex'), 10);

    await connection.query(
      `UPDATE users
       SET is_virtual = TRUE,
           is_active = TRUE,
           is_verified = TRUE,
           email = ?,
           password_hash = ?
       WHERE id = ? AND role = 'player'`,
      [virtualEmail, passwordHash, childUserId]
    );

    await connection.query(
      'DELETE FROM parent_child_links WHERE parent_id = ? AND child_user_id = ?',
      [parentId, childUserId]
    );

    await connection.commit();

    res.json({
      message: 'Dieťa bolo odpojené od rodiča. Účet bol prevedený na imaginárny účet.',
      childUserId,
      isVirtual: true
    });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

// DELETE /api/players/:id - Hard delete player (admin only)
router.delete('/:id', authenticateToken, requireRole(['admin']), async (req, res, next) => {
  try {
    const playerId = Number(req.params.id);
    if (!Number.isInteger(playerId) || playerId <= 0) {
      return res.status(400).json({ error: 'Neplatné playerId' });
    }

    const [users] = await db.query('SELECT id, role FROM users WHERE id = ? LIMIT 1', [playerId]);
    if (!users.length) {
      return res.status(404).json({ error: 'Hráč nebol nájdený' });
    }

    if (users[0].role !== 'player') {
      return res.status(400).json({ error: 'Tento endpoint je určený iba na mazanie hráča' });
    }

    await db.query('DELETE FROM users WHERE id = ?', [playerId]);

    res.json({ message: 'Hráčsky účet bol vymazaný (admin operácia)' });
  } catch (error) {
    next(error);
  }
});

// GET /api/players/:id - Get player detail
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const role = req.user?.role;
    const [players] = await db.query(`
      SELECT 
        p.*,
        u.first_name,
        u.last_name,
        u.email,
        u.date_of_birth,
        u.phone,
        u.avatar_url,
        t.name as team_name,
        t.age_group
      FROM team_memberships p
      JOIN users u ON p.user_id = u.id
      LEFT JOIN teams t ON p.team_id = t.id
      WHERE p.id = ?
    `, [req.params.id]);
    
    if (players.length === 0) {
      return res.status(404).json({ error: 'Player not found' });
    }
    
    const player = players[0];

    if (role === 'player' && player.user_id !== req.user.id) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto hráčovi' });
    }

    if (role === 'parent') {
      const childUserIds = await getParentScopedChildUserIds(db, req.user.id);
      if (!childUserIds.includes(player.user_id)) {
        return res.status(403).json({ error: 'Nemáte prístup k tomuto hráčovi' });
      }
    }
    
    // Get player stats
    const [matchStats] = await db.query(`
      SELECT 
        COUNT(DISTINCT ml.match_id) as matches_played,
        COUNT(CASE WHEN me.event_type = 'goal' THEN 1 END) as goals,
        COUNT(CASE WHEN me.event_type = 'yellow_card' THEN 1 END) as yellow_cards,
        COUNT(CASE WHEN me.event_type = 'red_card' THEN 1 END) as red_cards
      FROM match_lineup ml
      LEFT JOIN match_events me ON ml.user_id = me.user_id
      WHERE ml.user_id = (SELECT user_id FROM team_memberships WHERE id = ?)
    `, [req.params.id]);
    
    const [attendance] = await db.query(`
      SELECT 
        COUNT(*) as total_trainings,
        SUM(CASE WHEN status = 'present' THEN 1 ELSE 0 END) as attended
      FROM attendance
      WHERE user_id = (SELECT user_id FROM team_memberships WHERE id = ?)
    `, [req.params.id]);
    
    res.json({
      id: player.id,
      userId: player.user_id,
      firstName: player.first_name,
      lastName: player.last_name,
      name: `${player.first_name} ${player.last_name}`,
      email: player.email,
      phone: player.phone,
      dateOfBirth: player.date_of_birth,
      avatar: player.avatar_url,
      jerseyNumber: player.jersey_number,
      position: player.position,
      team: player.team_id ? {
        id: player.team_id,
        name: player.team_name,
        ageGroup: player.age_group
      } : null,
      stats: {
        matchesPlayed: matchStats[0].matches_played,
        goals: matchStats[0].goals,
        yellowCards: matchStats[0].yellow_cards,
        redCards: matchStats[0].red_cards,
        trainingAttendance: attendance[0].total_trainings > 0 
          ? Math.round((attendance[0].attended / attendance[0].total_trainings) * 100) 
          : 0
      }
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
