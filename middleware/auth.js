const jwt = require('jsonwebtoken');
const db = require('../config/database');

const normalizeRole = (role) => {
  if (['system_admin', 'super_admin', 'founder'].includes(role)) return 'admin';
  if (role === 'club_admin') return 'club';
  return role;
};

const expandAllowedRoles = (allowedRoles) => {
  const expanded = new Set((Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles]).map(normalizeRole));

  if (expanded.has('coach')) expanded.add('assistant');
  if (expanded.has('assistant')) expanded.add('coach');
  if (expanded.has('club')) expanded.add('club_admin');

  return [...expanded];
};

const loadUserById = async (userId) => {
  try {
    const [users] = await db.query(
      `SELECT id, email, first_name, last_name, role, is_active, is_verified
       FROM users WHERE id = ?`,
      [userId]
    );

    return users;
  } catch (error) {
    // Older schema fallback: missing is_active/is_verified columns.
    if (error?.code === 'ER_BAD_FIELD_ERROR') {
      const [users] = await db.query(
        `SELECT id, email, first_name, last_name, role
         FROM users WHERE id = ?`,
        [userId]
      );

      return users.map((user) => ({
        ...user,
        is_active: true,
        is_verified: true
      }));
    }

    throw error;
  }
};

// Verify JWT token and load full user
const authenticate = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    return res.status(401).json({ error: 'Access token required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    
    // Load full user from database
    const users = await loadUserById(decoded.id);

    if (users.length === 0) {
      return res.status(401).json({ error: 'User not found' });
    }

    const user = users[0];

    // Check if user is active
    if (!user.is_active) {
      return res.status(403).json({ error: 'Account deactivated' });
    }

    // Attach user to request
    req.user = {
      id: user.id,
      email: user.email,
      firstName: user.first_name,
      lastName: user.last_name,
      role: normalizeRole(user.role),
      originalRole: user.role,
      isVerified: user.is_verified
    };

    next();
  } catch (err) {
    return res.status(403).json({ error: 'Invalid or expired token' });
  }
};

// Optional authentication (doesn't fail if no token)
const optionalAuth = async (req, res, next) => {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];

  if (token) {
    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      
      const users = await loadUserById(decoded.id);

      if (users.length > 0 && users[0].is_active) {
        const user = users[0];
        req.user = {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: normalizeRole(user.role),
          originalRole: user.role,
          isVerified: user.is_verified
        };
      }
    } catch (err) {
      // Silently fail for optional auth
    }
  }
  next();
};

// Require specific role(s)
const requireRole = (allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const roles = expandAllowedRoles(allowedRoles);
    
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ 
        error: 'Insufficient permissions', 
        required: roles,
        current: req.user.role
      });
    }

    next();
  };
};

// Check if user has access to club
const requireClubAccess = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const clubId = req.params.clubId || req.body.clubId;
  
  if (!clubId) {
    return res.status(400).json({ error: 'Club ID required' });
  }

  try {
    const [access] = await db.query(
      `SELECT id FROM club_members 
       WHERE club_id = ? AND user_id = ? AND is_active = TRUE`,
      [clubId, req.user.id]
    );

    if (access.length === 0 && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'No access to this club' });
    }

    req.clubId = clubId;
    next();
  } catch (error) {
    next(error);
  }
};

// Check if user is club admin
const requireClubAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  const clubId = req.params.clubId || req.body.clubId;

  try {
    const [access] = await db.query(
      `SELECT id FROM club_members 
       WHERE club_id = ? AND user_id = ? AND member_role IN ('club', 'club_admin') AND is_active = TRUE`,
      [clubId, req.user.id]
    );

    if (access.length === 0 && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Club admin access required' });
    }

    req.clubId = clubId;
    next();
  } catch (error) {
    next(error);
  }
};

// Export all middleware
module.exports = { 
  authenticate, 
  authenticateToken: authenticate, // Backward compatibility
  optionalAuth,
  requireRole,
  requireClubAccess,
  requireClubAdmin
};
