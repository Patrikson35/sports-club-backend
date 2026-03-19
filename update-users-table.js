require('dotenv').config();
const mysql = require('mysql2/promise');

async function updateUsersTable() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    console.log('🔧 Aktualizujem users tabuľku...');

    const sql = "ALTER TABLE users ADD COLUMN club_id INT NULL";
    
    try {
      await connection.query(sql);
      console.log('✅ Stĺpec club_id pridaný');
    } catch (err) {
      if (err.code === 'ER_DUP_FIELDNAME') {
        console.log('⏭️  Stĺpec club_id už existuje');
      } else {
        throw err;
      }
    }

    // Pridať foreign key
    const fkSql = "ALTER TABLE users ADD CONSTRAINT fk_user_club FOREIGN KEY (club_id) REFERENCES clubs(id) ON DELETE SET NULL";
    try {
      await connection.query(fkSql);
      console.log('✅ Foreign key constraint pridaný');
    } catch (err) {
      if (err.code === 'ER_DUP_KEYNAME') {
        console.log('⏭️  Foreign key už existuje');
      } else {
        console.log('⚠️  Warning:', err.message);
      }
    }

    console.log('✅ Aktualizácia dokončená!');
  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

updateUsersTable();
