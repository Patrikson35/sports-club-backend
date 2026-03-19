const mysql = require('mysql2/promise');
require('dotenv').config();

// Create connection pool
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0
});

const DEFAULT_SPORT_FIELD_TYPES = [
  { sportKey: 'football', typeKey: 'natural_grass', typeLabel: 'Prírodná tráva', sortOrder: 1 },
  { sportKey: 'football', typeKey: 'artificial_grass', typeLabel: 'Umelá tráva', sortOrder: 2 },
  { sportKey: 'football', typeKey: 'multifunctional_field', typeLabel: 'Multifunkčné ihrisko', sortOrder: 3 },
  { sportKey: 'football', typeKey: 'indoor_hall', typeLabel: 'Hala', sortOrder: 4 },

  { sportKey: 'hockey', typeKey: 'ice_rink', typeLabel: 'Ľadová plocha', sortOrder: 1 },
  { sportKey: 'hockey', typeKey: 'inline_surface', typeLabel: 'Inline plocha', sortOrder: 2 },
  { sportKey: 'hockey', typeKey: 'multifunctional_field', typeLabel: 'Multifunkčné ihrisko', sortOrder: 3 },
  { sportKey: 'hockey', typeKey: 'indoor_hall', typeLabel: 'Hala', sortOrder: 4 },

  { sportKey: 'basketball', typeKey: 'indoor_hall', typeLabel: 'Hala', sortOrder: 1 },
  { sportKey: 'basketball', typeKey: 'outdoor_court', typeLabel: 'Vonkajšie ihrisko', sortOrder: 2 },
  { sportKey: 'basketball', typeKey: 'multifunctional_field', typeLabel: 'Multifunkčné ihrisko', sortOrder: 3 },

  { sportKey: 'handball', typeKey: 'indoor_hall', typeLabel: 'Hala', sortOrder: 1 },
  { sportKey: 'handball', typeKey: 'outdoor_court', typeLabel: 'Vonkajšie ihrisko', sortOrder: 2 },
  { sportKey: 'handball', typeKey: 'multifunctional_field', typeLabel: 'Multifunkčné ihrisko', sortOrder: 3 },

  { sportKey: 'volleyball', typeKey: 'indoor_hall', typeLabel: 'Hala', sortOrder: 1 },
  { sportKey: 'volleyball', typeKey: 'outdoor_court', typeLabel: 'Vonkajšie ihrisko', sortOrder: 2 },
  { sportKey: 'volleyball', typeKey: 'sand_court', typeLabel: 'Pieskové ihrisko', sortOrder: 3 },

  { sportKey: 'tennis', typeKey: 'clay_court', typeLabel: 'Antuka', sortOrder: 1 },
  { sportKey: 'tennis', typeKey: 'hard_court', typeLabel: 'Tvrdý povrch', sortOrder: 2 },
  { sportKey: 'tennis', typeKey: 'grass_court', typeLabel: 'Tráva', sortOrder: 3 },
  { sportKey: 'tennis', typeKey: 'indoor_hall', typeLabel: 'Hala', sortOrder: 4 }
];

const ensureCoreTables = async () => {
  const addColumnIfMissing = async (statement) => {
    try {
      await pool.query(statement);
    } catch (error) {
      if (error?.code !== 'ER_DUP_FIELDNAME') {
        throw error;
      }
    }
  };

  await pool.query(`
    CREATE TABLE IF NOT EXISTS club_members (
      id INT AUTO_INCREMENT PRIMARY KEY,
      club_id INT NOT NULL,
      user_id INT NOT NULL,
      member_role ENUM('club_admin', 'club', 'coach', 'assistant', 'player') NOT NULL,
      joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      left_at DATETIME NULL,
      is_active BOOLEAN DEFAULT TRUE,
      added_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL,
      UNIQUE KEY unique_club_user (club_id, user_id),
      INDEX idx_club (club_id),
      INDEX idx_user (user_id),
      INDEX idx_role (member_role)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS invites (
      id INT AUTO_INCREMENT PRIMARY KEY,
      invite_code VARCHAR(64) NOT NULL UNIQUE,
      invite_type ENUM('coach', 'assistant', 'player', 'parent', 'club_admin') NOT NULL,
      email VARCHAR(255) NOT NULL,
      invited_by INT NOT NULL,
      club_id INT NULL,
      team_id INT NULL,
      player_id INT NULL,
      metadata JSON,
      status ENUM('pending', 'accepted', 'declined', 'expired') DEFAULT 'pending',
      expires_at DATETIME NOT NULL,
      accepted_at DATETIME NULL,
      accepted_by INT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      FOREIGN KEY (invited_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE CASCADE,
      FOREIGN KEY (team_id) REFERENCES teams(id) ON DELETE CASCADE,
      FOREIGN KEY (player_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY (accepted_by) REFERENCES users(id) ON DELETE SET NULL,
      INDEX idx_invite_code (invite_code),
      INDEX idx_email (email),
      INDEX idx_status (status),
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS email_verifications (
      id INT AUTO_INCREMENT PRIMARY KEY,
      user_id INT NOT NULL,
      token VARCHAR(64) NOT NULL UNIQUE,
      email VARCHAR(255) NOT NULL,
      expires_at DATETIME NOT NULL,
      verified_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
      INDEX idx_token (token),
      INDEX idx_user (user_id),
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id INT AUTO_INCREMENT PRIMARY KEY,
      email VARCHAR(255) NOT NULL,
      token VARCHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME NOT NULL,
      used_at DATETIME NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_token (token),
      INDEX idx_email (email),
      INDEX idx_expires (expires_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  await addColumnIfMissing('ALTER TABLE users ADD COLUMN sport VARCHAR(64) NULL');
  await addColumnIfMissing('ALTER TABLE users ADD COLUMN date_of_birth DATE NULL');
  await addColumnIfMissing('ALTER TABLE users ADD COLUMN is_active BOOLEAN DEFAULT TRUE');
  await addColumnIfMissing('ALTER TABLE users ADD COLUMN is_verified BOOLEAN DEFAULT FALSE');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN sport VARCHAR(64) NULL');
  await addColumnIfMissing('ALTER TABLE clubs ADD COLUMN is_active BOOLEAN DEFAULT TRUE');

  await pool.query(`
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
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);

  for (const item of DEFAULT_SPORT_FIELD_TYPES) {
    await pool.query(
      `INSERT INTO sport_field_types (sport_key, type_key, type_label, sort_order, is_active)
       VALUES (?, ?, ?, ?, TRUE)
       ON DUPLICATE KEY UPDATE
         type_label = VALUES(type_label),
         sort_order = VALUES(sort_order),
         is_active = TRUE`,
      [item.sportKey, item.typeKey, item.typeLabel, item.sortOrder]
    );
  }
};

// Test connection
pool.getConnection()
  .then(async connection => {
    console.log('✅ MySQL Database connected successfully');
    connection.release();

    try {
      await ensureCoreTables();
      console.log('✅ Core tables check completed');
    } catch (error) {
      console.error('⚠️ Core tables check failed:', error.message);
    }
  })
  .catch(err => {
    console.error('❌ Database connection failed:', err.message);
  });

pool.ensureCoreTables = ensureCoreTables;

module.exports = pool;
