// Create new team
const mysql = require('mysql2/promise');
const readline = require('readline');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const question = (query) => new Promise((resolve) => rl.question(query, resolve));

const config = {
  host: 'metro.proxy.rlwy.net',
  port: 25931,
  user: 'root',
  password: 'mFAWViiIDJrkrtjFmYhqWCSPYLPCEzfo',
  database: 'railway'
};

async function createTeam() {
  console.log('⚽ Vytvoření nového týmu\n');
  
  const connection = await mysql.createConnection(config);
  
  try {
    // Show available clubs
    const [clubs] = await connection.query('SELECT id, name FROM clubs');
    
    if (clubs.length === 0) {
      console.log('❌ Nejdřív musíte vytvořit klub!');
      console.log('   Spusťte: node create-club.js');
      rl.close();
      await connection.end();
      return;
    }
    
    console.log('Dostupné kluby:');
    clubs.forEach(club => console.log(`   ${club.id}. ${club.name}`));
    console.log('');
    
    const clubId = await question('ID klubu: ');
    const name = await question('Název týmu (např. U11, U13): ');
    const ageGroup = await question('Věková kategorie (např. U11): ');
    const season = await question('Sezóna (např. 2025/2026): ');
    
    rl.close();
    
    const [result] = await connection.query(
      'INSERT INTO teams (club_id, name, age_group, season, created_at) VALUES (?, ?, ?, ?, NOW())',
      [clubId, name, ageGroup, season]
    );
    
    console.log('\n✅ Tým úspěšně vytvořen!');
    console.log(`   ID: ${result.insertId}`);
    console.log(`   Název: ${name} (${ageGroup})`);
    console.log(`   Sezóna: ${season}`);
    console.log('\nTeď můžete přidávat hráče do týmu přes web admin!');
    
  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

createTeam();
