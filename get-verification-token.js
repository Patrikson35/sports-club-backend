const mysql = require('mysql2/promise');
require('dotenv').config();

async function getVerificationToken(email) {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    console.log('🔌 Pripojený k databáze...\n');
    
    const [rows] = await connection.query(`
      SELECT 
        ev.token, 
        ev.email, 
        ev.expires_at,
        u.first_name,
        u.last_name,
        u.role
      FROM email_verifications ev
      JOIN users u ON ev.user_id = u.id
      WHERE ev.email = ? 
        AND ev.verified_at IS NULL 
        AND ev.expires_at > NOW()
      ORDER BY ev.created_at DESC
      LIMIT 1
    `, [email]);
    
    if (rows.length === 0) {
      console.log('❌ Žiadny aktívny token pre email:', email);
      return;
    }
    
    const token = rows[0].token;
    const verificationUrl = `http://localhost:5173/verify-email?token=${token}`;
    
    console.log('✅ Overovací token nájdený!\n');
    console.log('📧 Email:', rows[0].email);
    console.log('👤 Meno:', rows[0].first_name, rows[0].last_name);
    console.log('🎭 Rola:', rows[0].role);
    console.log('⏰ Platnosť do:', rows[0].expires_at);
    console.log('\n🔗 OVEROVACÍ LINK:');
    console.log(verificationUrl);
    console.log('\n📋 TOKEN:');
    console.log(token);
    
  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

const email = process.argv[2] || 'ppavlenda@gmail.com';
getVerificationToken(email);
