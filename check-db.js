// Check database state
const mysql = require('mysql2/promise');

const config = {
  host: 'metro.proxy.rlwy.net',
  port: 25931,
  user: 'root',
  password: 'mFAWViiIDJrkrtjFmYhqWCSPYLPCEzfo',
  database: 'railway'
};

async function checkDatabase() {
  console.log('📊 Checking Railway database state...\n');
  
  const connection = await mysql.createConnection(config);
  
  try {
    const [clubs] = await connection.query('SELECT COUNT(*) as count FROM clubs');
    const [teams] = await connection.query('SELECT COUNT(*) as count FROM teams');
    const [users] = await connection.query('SELECT COUNT(*) as count FROM users');
    const [players] = await connection.query('SELECT COUNT(*) as count FROM team_memberships');
    const [trainings] = await connection.query('SELECT COUNT(*) as count FROM training_sessions');
    const [matches] = await connection.query('SELECT COUNT(*) as count FROM matches');
    const [attendance] = await connection.query('SELECT COUNT(*) as count FROM attendance');
    
    console.log('Current state:');
    console.log(`   Clubs: ${clubs[0].count}`);
    console.log(`   Teams: ${teams[0].count}`);
    console.log(`   Users: ${users[0].count}`);
    console.log(`   Players: ${players[0].count}`);
    console.log(`   Trainings: ${trainings[0].count}`);
    console.log(`   Matches: ${matches[0].count}`);
    console.log(`   Attendance: ${attendance[0].count}`);
    
    if (clubs[0].count === 0 && teams[0].count === 0 && players[0].count === 0) {
      console.log('\n✅ Database is clean!');
    } else {
      console.log('\n⚠️  Database still contains data.');
      console.log('Run: node clean-db.js');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

checkDatabase();
