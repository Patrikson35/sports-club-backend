// Clean Railway database via Node.js
const mysql = require('mysql2/promise');

const config = {
  host: 'metro.proxy.rlwy.net',
  port: 25931,
  user: 'root',
  password: 'mFAWViiIDJrkrtjFmYhqWCSPYLPCEzfo',
  database: 'railway',
  multipleStatements: true
};

const cleanSQL = `
SET FOREIGN_KEY_CHECKS = 0;

DELETE FROM attendance WHERE id > 0;
DELETE FROM match_lineup WHERE id > 0;
DELETE FROM match_events WHERE id > 0;
DELETE FROM matches WHERE id > 0;
DELETE FROM training_sessions WHERE id > 0;
DELETE FROM team_memberships WHERE id > 0;
DELETE FROM test_results WHERE id > 0;
DELETE FROM test_categories WHERE id > 0;
DELETE FROM teams WHERE id > 0;
DELETE FROM users WHERE role != 'admin';
DELETE FROM clubs WHERE id > 0;

SET FOREIGN_KEY_CHECKS = 1;

ALTER TABLE clubs AUTO_INCREMENT = 1;
ALTER TABLE teams AUTO_INCREMENT = 1;
ALTER TABLE users AUTO_INCREMENT = 1;
ALTER TABLE team_memberships AUTO_INCREMENT = 1;
ALTER TABLE training_sessions AUTO_INCREMENT = 1;
ALTER TABLE attendance AUTO_INCREMENT = 1;
ALTER TABLE matches AUTO_INCREMENT = 1;
ALTER TABLE match_lineup AUTO_INCREMENT = 1;
ALTER TABLE match_events AUTO_INCREMENT = 1;
ALTER TABLE test_categories AUTO_INCREMENT = 1;
ALTER TABLE test_results AUTO_INCREMENT = 1;
`;

async function cleanDatabase() {
  console.log('🗑️  Cleaning Railway database...\n');
  
  const connection = await mysql.createConnection(config);
  
  try {
    // Execute clean script
    await connection.query(cleanSQL);
    console.log('✅ All test data deleted');
    
    // Verify
    const [clubs] = await connection.query('SELECT COUNT(*) as count FROM clubs');
    const [teams] = await connection.query('SELECT COUNT(*) as count FROM teams');
    const [users] = await connection.query('SELECT COUNT(*) as count FROM users');
    const [players] = await connection.query('SELECT COUNT(*) as count FROM team_memberships');
    const [trainings] = await connection.query('SELECT COUNT(*) as count FROM training_sessions');
    const [matches] = await connection.query('SELECT COUNT(*) as count FROM matches');
    
    console.log('\n📊 Database state:');
    console.log(`   Clubs: ${clubs[0].count}`);
    console.log(`   Teams: ${teams[0].count}`);
    console.log(`   Users: ${users[0].count} (admin only)`);
    console.log(`   Players: ${players[0].count}`);
    console.log(`   Trainings: ${trainings[0].count}`);
    console.log(`   Matches: ${matches[0].count}`);
    console.log('\n✅ Database is clean and ready for production!');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await connection.end();
  }
}

cleanDatabase();
