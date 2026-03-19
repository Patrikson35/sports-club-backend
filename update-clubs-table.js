require('dotenv').config();
const mysql = require('mysql2/promise');

async function updateClubsTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    console.log('🔧 Aktualizujem clubs tabuľku...');

    // Pridať stĺpce ak neexistujú
    const alterations = [
      "ALTER TABLE clubs ADD COLUMN city VARCHAR(100) DEFAULT ''",
      "ALTER TABLE clubs ADD COLUMN country VARCHAR(2) DEFAULT 'SK'",
      "ALTER TABLE clubs ADD COLUMN website VARCHAR(255) DEFAULT ''",
      "ALTER TABLE clubs ADD COLUMN owner_id INT",
      "ALTER TABLE clubs ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP",
      "ALTER TABLE clubs ADD CONSTRAINT fk_club_owner FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE SET NULL"
    ];

    for (const sql of alterations) {
      try {
        await connection.query(sql);
        console.log('✅', sql.substring(0, 60) + '...');
      } catch (err) {
        if (err.code === 'ER_DUP_FIELDNAME' || err.code === 'ER_DUP_KEYNAME') {
          console.log('⏭️  Stĺpec už existuje:', sql.substring(0, 50) + '...');
        } else {
          console.error('❌ Chyba:', err.message);
        }
      }
    }

    console.log('✅ Aktualizácia dokončená!');
  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

updateClubsTable();
