const jwt = require('jsonwebtoken');
const db = require('../config/database');

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
    const [users] = await db.query(
      `SELECT id, email, first_name, last_name, role, is_active, is_verified, is_virtual 
       FROM users WHERE id = ?`,
      [decoded.id]
    );

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
      role: user.role,
      isVerified: user.is_verified,
      isVirtual: user.is_virtual
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
      
      const [users] = await db.query(
        `SELECT id, email, first_name, last_name, role, is_active, is_verified 
         FROM users WHERE id = ?`,
        [decoded.id]
      );

      if (users.length > 0 && users[0].is_active) {
        const user = users[0];
        req.user = {
          id: user.id,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
          role: user.role,
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

    const roles = Array.isArray(allowedRoles) ? allowedRoles : [allowedRoles];
    
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
       WHERE club_id = ? AND user_id = ? AND member_role = 'club_admin' AND is_active = TRUE`,
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
