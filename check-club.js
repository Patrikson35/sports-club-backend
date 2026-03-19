require('dotenv').config();
const mysql = require('mysql2/promise');

async function checkClub() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST,
    port: process.env.DB_PORT,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME
  });

  try {
    console.log('🔌 Pripojený k databáze...\n');

    const [clubs] = await connection.query(
      'SELECT id, name, city, country, created_at, updated_at FROM clubs ORDER BY created_at DESC LIMIT 5'
    );
    
    if (clubs.length > 0) {
      console.log('✅ Posledné kluby v databáze:');
      for (const club of clubs) {
        console.log(club);
      }
    } else {
      console.log('❌ Žiadny klub v databáze');
      return;
    }

    const selectedClub = clubs[0];
    const [members] = await connection.query(
      `SELECT 
         u.id,
         u.email,
         u.first_name,
         u.last_name,
         u.role,
         cm.member_role,
         cm.is_active,
         cm.joined_at
       FROM club_members cm
       JOIN users u ON u.id = cm.user_id
       WHERE cm.club_id = ?
       ORDER BY cm.is_active DESC, cm.joined_at DESC`,
      [selectedClub.id]
    );

    console.log(`\n✅ Členovia klubu "${selectedClub.name}":`);
    if (members.length === 0) {
      console.log('   (žiadni členovia)');
    } else {
      for (const member of members) {
        console.log(member);
      }
    }

    const [clubUsers] = await connection.query(
      `SELECT id, email, first_name, last_name, role, created_at
       FROM users
       WHERE role IN ('club', 'club_admin', 'admin')
       ORDER BY created_at DESC
       LIMIT 10`
    );

    console.log('\n✅ Poslední používatelia s rolou club/club_admin/admin:');
    if (clubUsers.length === 0) {
      console.log('   (žiadni)');
    } else {
      for (const user of clubUsers) {
        console.log(user);
      }
    }

  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

checkClub();
