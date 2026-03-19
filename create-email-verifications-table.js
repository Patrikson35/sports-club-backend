const mysql = require('mysql2/promise');
require('dotenv').config();

async function createEmailVerificationsTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    console.log('🔌 Pripojený k databáze...');
    
    // Create email_verifications table
    await connection.query(`
      CREATE TABLE IF NOT EXISTS email_verifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        token VARCHAR(64) NOT NULL UNIQUE,
        email VARCHAR(255) NOT NULL,
        expires_at DATETIME NOT NULL,
        verified_at DATETIME DEFAULT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_token (token),
        INDEX idx_user_id (user_id),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
    `);
    
    console.log('✅ Tabuľka email_verifications bola úspešne vytvorená!');
  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

createEmailVerificationsTable();
