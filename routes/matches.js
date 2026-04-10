const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

let matchEvidenceTablesReady = false;

const ensureMatchEvidenceTables = async () => {
  if (matchEvidenceTablesReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS match_category_settings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      team_id INT NOT NULL,
      category_key VARCHAR(64) NOT NULL,
      indicators_json JSON NOT NULL,
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_team_category (team_id, category_key),
      INDEX idx_team (team_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS match_evidence (
      id INT AUTO_INCREMENT PRIMARY KEY,
      match_id INT NOT NULL,
      home_score INT NULL,
      away_score INT NULL,
      scorers_json JSON NULL,
      assists_json JSON NULL,
      cards_json JSON NULL,
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_match (match_id),
      INDEX idx_match (match_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS match_pairings (
      id INT AUTO_INCREMENT PRIMARY KEY,
      match_id INT NOT NULL,
      paired_club_id INT NOT NULL,
      status ENUM('pending', 'confirmed') DEFAULT 'pending',
      updated_by INT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY unique_match_pairing (match_id),
      INDEX idx_paired_club (paired_club_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  try {
    const [columns] = await db.query('SHOW COLUMNS FROM match_evidence');
    const hasAssistsColumn = Array.isArray(columns)
      ? columns.some((column) => String(column?.Field || '').trim().toLowerCase() === 'assists_json')
      : false;

    if (!hasAssistsColumn) {
      await db.query('ALTER TABLE match_evidence ADD COLUMN assists_json JSON NULL AFTER scorers_json');
    }
  } catch (error) {
    if (error?.code !== 'ER_DUP_FIELDNAME') {
      throw error;
    }
  }

  matchEvidenceTablesReady = true;
};

const normalizeIndicators = (value) => {
  const source = value && typeof value === 'object' ? value : {};
  const normalized = {
    result: source.result !== false,
    scorers: source.scorers !== false,
    assists: Boolean(source.assists),
    yellowCards: Boolean(source.yellowCards),
    redCards: Boolean(source.redCards),
  };

  Object.entries(source).forEach(([rawKey, rawValue]) => {
    const indicatorKey = String(rawKey || '').trim();
    if (!indicatorKey || Object.prototype.hasOwnProperty.call(normalized, indicatorKey)) return;
    normalized[indicatorKey] = Boolean(rawValue);
  });

  return normalized;
};

const parseJsonSafe = (value, fallback) => {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
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

const ensureMatchAccess = async (connection, reqUser, matchId) => {
  const scopedTeamIds = await getScopedTeamIds(connection, reqUser);

  if (!Array.isArray(scopedTeamIds)) {
    return { allowed: true };
  }

  if (!scopedTeamIds.length) {
    return { allowed: false };
  }

  const [matches] = await connection.query(
    'SELECT team_id FROM matches WHERE id = ? LIMIT 1',
    [matchId]
  );

  if (!matches.length) {
    return { allowed: false, notFound: true };
  }

  return { allowed: scopedTeamIds.includes(matches[0].team_id), notFound: false };
};

// GET /api/matches - Get all matches
router.get('/', authenticateToken, async (req, res, next) => {
  try {
    const { teamId, status, limit = 50 } = req.query;
    const scopedTeamIds = await getScopedTeamIds(db, req.user);

    if (Array.isArray(scopedTeamIds) && scopedTeamIds.length === 0) {
      return res.json({ total: 0, matches: [] });
    }
    
    let query = `
      SELECT 
        m.*,
        t.name as team_name,
        t.age_group
      FROM matches m
      LEFT JOIN teams t ON m.team_id = t.id
      WHERE 1=1
    `;
    
    const params = [];
    
    if (teamId) {
      if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(Number(teamId))) {
        return res.json({ total: 0, matches: [] });
      }

      query += ' AND m.team_id = ?';
      params.push(teamId);
    }

    if (Array.isArray(scopedTeamIds) && !teamId) {
      query += ` AND m.team_id IN (${scopedTeamIds.map(() => '?').join(',')})`;
      params.push(...scopedTeamIds);
    }
    
    if (status) {
      query += ' AND m.status = ?';
      params.push(status);
    }
    
    query += ' ORDER BY m.match_date DESC LIMIT ?';
    params.push(parseInt(limit));
    
    const [matches] = await db.query(query, params);
    
    res.json({
      total: matches.length,
      matches: matches.map(m => ({
        id: m.id,
        opponent: m.opponent_team,
        matchDate: m.match_date,
        location: m.location,
        matchType: m.match_type,
        homeScore: m.home_score,
        awayScore: m.away_score,
        result: m.home_score !== null && m.away_score !== null 
          ? `${m.home_score}:${m.away_score}` 
          : null,
        status: m.status,
        team: {
          id: m.team_id,
          name: m.team_name,
          ageGroup: m.age_group
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/matches/:id - Get match detail
router.get('/:id', authenticateToken, async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const access = await ensureMatchAccess(db, req.user, matchId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Match not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto zápasu' });
    }

    const [matches] = await db.query(`
      SELECT 
        m.*,
        t.name as team_name,
        t.age_group
      FROM matches m
      LEFT JOIN teams t ON m.team_id = t.id
      WHERE m.id = ?
    `, [matchId]);
    
    if (matches.length === 0) {
      return res.status(404).json({ error: 'Match not found' });
    }
    
    const match = matches[0];
    
    res.json({
      id: match.id,
      opponent: match.opponent_team,
      matchDate: match.match_date,
      location: match.location,
      matchType: match.match_type,
      homeScore: match.home_score,
      awayScore: match.away_score,
      result: match.home_score !== null && match.away_score !== null 
        ? `${match.home_score}:${match.away_score}` 
        : null,
      status: match.status,
      notes: match.notes,
      team: {
        id: match.team_id,
        name: match.team_name,
        ageGroup: match.age_group
      }
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/matches/:id/lineup - Get match lineup
router.get('/:id/lineup', authenticateToken, async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const access = await ensureMatchAccess(db, req.user, matchId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Match not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto zápasu' });
    }

    const [lineup] = await db.query(`
      SELECT 
        ml.*,
        u.id as player_id,
        tm.jersey_number,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM match_lineup ml
      JOIN users u ON ml.user_id = u.id
      LEFT JOIN team_memberships tm ON ml.user_id = tm.user_id
      WHERE ml.match_id = ?
      ORDER BY ml.lineup_type, tm.jersey_number
    `, [matchId]);
    
    res.json({
      total: lineup.length,
      starting: lineup.filter(l => l.lineup_type === 'starting').map(l => ({
        id: l.id,
        position: l.position,
        jerseyNumber: l.jersey_number,
        player: {
          id: l.player_id,
          jerseyNumber: l.jersey_number,
          firstName: l.first_name,
          lastName: l.last_name,
          name: `${l.first_name} ${l.last_name}`,
          avatar: l.avatar_url
        }
      })),
      substitutes: lineup.filter(l => l.lineup_type === 'substitute').map(l => ({
        id: l.id,
        position: l.position,
        jerseyNumber: l.jersey_number,
        player: {
          id: l.player_id,
          jerseyNumber: l.jersey_number,
          firstName: l.first_name,
          lastName: l.last_name,
          name: `${l.first_name} ${l.last_name}`,
          avatar: l.avatar_url
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/matches/:id/events - Get match events (goals, cards, etc.)
router.get('/:id/events', authenticateToken, async (req, res, next) => {
  try {
    const matchId = Number(req.params.id);
    const access = await ensureMatchAccess(db, req.user, matchId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Match not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto zápasu' });
    }

    const [events] = await db.query(`
      SELECT 
        me.*,
        tm.jersey_number,
        u.first_name,
        u.last_name,
        u.avatar_url
      FROM match_events me
      JOIN users u ON me.user_id = u.id
      LEFT JOIN team_memberships tm ON me.user_id = tm.user_id
      WHERE me.match_id = ?
      ORDER BY me.minute
    `, [matchId]);
    
    res.json({
      total: events.length,
      events: events.map(e => ({
        id: e.id,
        eventType: e.event_type,
        minute: e.minute,
        description: e.description,
        player: {
          id: e.player_id,
          jerseyNumber: e.jersey_number,
          firstName: e.first_name,
          lastName: e.last_name,
          name: `${e.first_name} ${e.last_name}`,
          avatar: e.avatar_url
        }
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/matches/table/:teamId - Get league table for team
router.get('/table/:teamId', authenticateToken, async (req, res, next) => {
  try {
    const teamId = Number(req.params.teamId);
    const scopedTeamIds = await getScopedTeamIds(db, req.user);

    if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(teamId)) {
      return res.status(403).json({ error: 'Nemáte prístup k tabuľke tohto tímu' });
    }

    // Get team's age group
    const [teams] = await db.query('SELECT age_group FROM teams WHERE id = ?', [teamId]);
    
    if (teams.length === 0) {
      return res.status(404).json({ error: 'Team not found' });
    }
    
    const ageGroup = teams[0].age_group;
    
    // Get all teams in same age group with stats
    const [table] = await db.query(`
      SELECT 
        t.id,
        t.name,
        COUNT(m.id) as matches,
        SUM(CASE WHEN m.home_score > m.away_score THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN m.home_score = m.away_score THEN 1 ELSE 0 END) as draws,
        SUM(CASE WHEN m.home_score < m.away_score THEN 1 ELSE 0 END) as losses,
        SUM(m.home_score) as goals_for,
        SUM(m.away_score) as goals_against,
        SUM(m.home_score) - SUM(m.away_score) as goal_difference,
        SUM(CASE 
          WHEN m.home_score > m.away_score THEN 3
          WHEN m.home_score = m.away_score THEN 1
          ELSE 0
        END) as points
      FROM teams t
      LEFT JOIN matches m ON t.id = m.team_id AND m.status = 'completed'
      WHERE t.age_group = ?
      GROUP BY t.id
      ORDER BY points DESC, goal_difference DESC, goals_for DESC
    `, [ageGroup]);
    
    res.json({
      ageGroup,
      total: table.length,
      table: table.map((r, index) => ({
        position: index + 1,
        team: {
          id: r.id,
          name: r.name
        },
        matches: r.matches || 0,
        wins: r.wins || 0,
        draws: r.draws || 0,
        losses: r.losses || 0,
        goalsFor: r.goals_for || 0,
        goalsAgainst: r.goals_against || 0,
        goalDifference: r.goal_difference || 0,
        points: r.points || 0
      }))
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/matches/settings/category-indicators - get indicators settings per category/team
router.get('/settings/category-indicators', authenticateToken, async (req, res, next) => {
  try {
    await ensureMatchEvidenceTables();

    const scopedTeamIds = await getScopedTeamIds(db, req.user);
    const requestedTeamId = Number(req.query.teamId || 0);

    let whereSql = '';
    const params = [];

    if (Array.isArray(scopedTeamIds)) {
      if (!scopedTeamIds.length) {
        return res.json({ total: 0, settings: [] });
      }
      whereSql = `WHERE mcs.team_id IN (${scopedTeamIds.map(() => '?').join(',')})`;
      params.push(...scopedTeamIds);
    }

    if (requestedTeamId > 0) {
      if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(requestedTeamId)) {
        return res.status(403).json({ error: 'Nemáte prístup k tomuto tímu' });
      }
      whereSql += whereSql ? ' AND mcs.team_id = ?' : 'WHERE mcs.team_id = ?';
      params.push(requestedTeamId);
    }

    const [rows] = await db.query(
      `SELECT
        mcs.id,
        mcs.team_id,
        mcs.category_key,
        mcs.indicators_json,
        t.name AS team_name,
        t.age_group
      FROM match_category_settings mcs
      LEFT JOIN teams t ON t.id = mcs.team_id
      ${whereSql}
      ORDER BY mcs.team_id, mcs.category_key`,
      params
    );

    return res.json({
      total: rows.length,
      settings: rows.map((row) => ({
        id: row.id,
        teamId: row.team_id,
        teamName: row.team_name,
        ageGroup: row.age_group,
        categoryKey: row.category_key,
        indicators: normalizeIndicators(parseJsonSafe(row.indicators_json, {})),
      })),
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/matches/settings/category-indicators - upsert category indicators
router.put('/settings/category-indicators', authenticateToken, async (req, res, next) => {
  try {
    await ensureMatchEvidenceTables();

    const teamId = Number(req.body?.teamId || 0);
    const categoryKey = String(req.body?.categoryKey || '').trim();
    const indicators = normalizeIndicators(req.body?.indicators);

    if (!teamId || !categoryKey) {
      return res.status(400).json({ error: 'teamId a categoryKey sú povinné' });
    }

    const scopedTeamIds = await getScopedTeamIds(db, req.user);
    if (Array.isArray(scopedTeamIds) && !scopedTeamIds.includes(teamId)) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto tímu' });
    }

    await db.query(
      `INSERT INTO match_category_settings (team_id, category_key, indicators_json, updated_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE indicators_json = VALUES(indicators_json), updated_by = VALUES(updated_by)`,
      [teamId, categoryKey, JSON.stringify(indicators), req.user?.id || null]
    );

    return res.json({
      message: 'Nastavenie kategórie bolo uložené',
      setting: { teamId, categoryKey, indicators },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/matches/:id/evidence - get custom match evidence and pairing
router.get('/:id/evidence', authenticateToken, async (req, res, next) => {
  try {
    await ensureMatchEvidenceTables();

    const matchId = Number(req.params.id);
    const access = await ensureMatchAccess(db, req.user, matchId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Match not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto zápasu' });
    }

    const [[evidenceRow] = []] = await db.query(
      `SELECT home_score, away_score, scorers_json, assists_json, cards_json
       FROM match_evidence
       WHERE match_id = ?
       LIMIT 1`,
      [matchId]
    );

    const [[pairingRow] = []] = await db.query(
      `SELECT mp.paired_club_id, mp.status, c.name AS paired_club_name
       FROM match_pairings mp
       LEFT JOIN clubs c ON c.id = mp.paired_club_id
       WHERE mp.match_id = ?
       LIMIT 1`,
      [matchId]
    );

    return res.json({
      matchId,
      evidence: {
        homeScore: evidenceRow?.home_score ?? null,
        awayScore: evidenceRow?.away_score ?? null,
        scorers: parseJsonSafe(evidenceRow?.scorers_json, []),
        assists: parseJsonSafe(evidenceRow?.assists_json, []),
        cards: parseJsonSafe(evidenceRow?.cards_json, []),
      },
      pairing: pairingRow
        ? {
            pairedClubId: pairingRow.paired_club_id,
            pairedClubName: pairingRow.paired_club_name,
            status: pairingRow.status,
          }
        : null,
    });
  } catch (error) {
    next(error);
  }
});

// PUT /api/matches/:id/evidence - upsert match evidence and optional pairing
router.put('/:id/evidence', authenticateToken, async (req, res, next) => {
  try {
    await ensureMatchEvidenceTables();

    const matchId = Number(req.params.id);
    const access = await ensureMatchAccess(db, req.user, matchId);
    if (access.notFound) {
      return res.status(404).json({ error: 'Match not found' });
    }
    if (!access.allowed) {
      return res.status(403).json({ error: 'Nemáte prístup k tomuto zápasu' });
    }

    const homeScore = req.body?.homeScore === '' || req.body?.homeScore === null || req.body?.homeScore === undefined
      ? null
      : Number(req.body.homeScore);
    const awayScore = req.body?.awayScore === '' || req.body?.awayScore === null || req.body?.awayScore === undefined
      ? null
      : Number(req.body.awayScore);
    const scorers = Array.isArray(req.body?.scorers) ? req.body.scorers : [];
    const assists = Array.isArray(req.body?.assists) ? req.body.assists : [];
    const cards = Array.isArray(req.body?.cards) ? req.body.cards : [];
    const pairedClubId = Number(req.body?.pairedClubId || 0);

    await db.query(
      `INSERT INTO match_evidence (match_id, home_score, away_score, scorers_json, assists_json, cards_json, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         home_score = VALUES(home_score),
         away_score = VALUES(away_score),
         scorers_json = VALUES(scorers_json),
         assists_json = VALUES(assists_json),
         cards_json = VALUES(cards_json),
         updated_by = VALUES(updated_by)`,
      [
        matchId,
        Number.isFinite(homeScore) ? homeScore : null,
        Number.isFinite(awayScore) ? awayScore : null,
        JSON.stringify(scorers),
        JSON.stringify(assists),
        JSON.stringify(cards),
        req.user?.id || null,
      ]
    );

    if (pairedClubId > 0) {
      const [clubs] = await db.query('SELECT id, name FROM clubs WHERE id = ? LIMIT 1', [pairedClubId]);
      if (!clubs.length) {
        return res.status(400).json({ error: 'Sparovaný klub neexistuje' });
      }

      await db.query(
        `INSERT INTO match_pairings (match_id, paired_club_id, status, updated_by)
         VALUES (?, ?, 'pending', ?)
         ON DUPLICATE KEY UPDATE
           paired_club_id = VALUES(paired_club_id),
           status = 'pending',
           updated_by = VALUES(updated_by)`,
        [matchId, pairedClubId, req.user?.id || null]
      );
    } else {
      await db.query('DELETE FROM match_pairings WHERE match_id = ?', [matchId]);
    }

    return res.json({
      message: 'Evidencia zápasu bola uložená',
      matchId,
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
