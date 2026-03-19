const mysql = require('mysql2/promise');
require('dotenv').config();

async function deleteClubs() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    console.log('🔌 Pripojený k databáze...');
    
    // Delete clubs
    const [clubsResult] = await connection.query('DELETE FROM clubs');
    console.log(`✅ Vymazaných klubov: ${clubsResult.affectedRows}`);
    
    // Delete email verifications for club users (if table exists)
    try {
      const [verifyResult] = await connection.query(
        'DELETE FROM email_verifications WHERE user_id IN (SELECT id FROM users WHERE role = "club")'
      );
      console.log(`✅ Vymazaných email verifikácií: ${verifyResult.affectedRows}`);
    } catch (err) {
      console.log('⚠️ Tabuľka email_verifications neexistuje, preskakujem...');
    }
    
    // Delete club users
    const [usersResult] = await connection.query('DELETE FROM users WHERE role = "club"');
    console.log(`✅ Vymazaných používateľov (role=club): ${usersResult.affectedRows}`);
    
    console.log('\n✅ Všetky kluby boli úspešne vymazané!');
  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

deleteClubs();
