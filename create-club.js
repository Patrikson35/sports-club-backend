// Create new club
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

async function createClub() {
  console.log('🏟️  Vytvoření nového klubu\n');
  
  const name = await question('Název klubu: ');
  const address = await question('Adresa (volitelné): ');
  const email = await question('Email (volitelné): ');
  const phone = await question('Telefon (volitelné): ');
  
  rl.close();
  
  const connection = await mysql.createConnection(config);
  
  try {
    const [result] = await connection.query(
      'INSERT INTO clubs (name, address, email, phone, created_at) VALUES (?, ?, ?, ?, NOW())',
      [name, address || null, email || null, phone || null]
    );
    
    console.log('\n✅ Klub úspěšně vytvořen!');
    console.log(`   ID: ${result.insertId}`);
    console.log(`   Název: ${name}`);
    console.log('\nTeď můžete vytvořit týmy v tomto klubu!');
    
  } catch (error) {
    console.error('❌ Chyba:', error.message);
  } finally {
    await connection.end();
  }
}

createClub();
