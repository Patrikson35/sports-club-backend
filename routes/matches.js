const express = require('express');
const router = express.Router();
const db = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

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

module.exports = router;
