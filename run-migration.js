#!/usr/bin/env node

/**
 * AUTO-MIGRATION SCRIPT
 * 
 * Čeká dokud není backend připravený a pak automaticky spustí databázovou migraci.
 * 
 * Usage:
 *   node run-migration.js
 * 
 * Environment:
 *   BACKEND_URL - URL backendu (default: production Railway)
 *   MIGRATION_TOKEN - Token pro autorizaci migrace
 *   MIGRATION_FILE - Název SQL souboru (default: 20260226_registration_system.sql)
 */

const https = require('https');

const BACKEND_URL = process.env.BACKEND_URL || 'https://outstanding-blessing-production-2cba.up.railway.app';
const MIGRATION_TOKEN = process.env.MIGRATION_TOKEN || 'CHANGE_ME_IN_PRODUCTION';
const MIGRATION_FILE = process.env.MIGRATION_FILE || '20260226_registration_system.sql';

const MAX_RETRIES = 30; // max 30 pokusů
const RETRY_DELAY = 10000; // 10 sekund mezi pokusy

/**
 * HTTP GET request
 */
function httpGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try {
            resolve({ statusCode: res.statusCode, body: JSON.parse(data) });
          } catch (e) {
            resolve({ statusCode: res.statusCode, body: data });
          }
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${data}`));
        }
      });
    }).on('error', reject);
  });
}

/**
 * HTTP POST request
 */
function httpPost(url, data, headers = {}) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    
    const options = {
      hostname: urlObj.hostname,
      port: 443,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
        ...headers
      }
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', chunk => responseData += chunk);
      res.on('end', () => {
        try {
          resolve({ statusCode: res.statusCode, body: JSON.parse(responseData) });
        } catch (e) {
          resolve({ statusCode: res.statusCode, body: responseData });
        }
      });
    });

    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

/**
 * Počká dokud backend neodpovídá
 */
async function waitForBackend() {
  console.log('🔍 Čekání na backend ready...');
  console.log(`Backend: ${BACKEND_URL}`);
  
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`[${attempt}/${MAX_RETRIES}] Pokus o připojení...`);
      const response = await httpGet(`${BACKEND_URL}/health`);
      
      if (response.statusCode === 200 && response.body.status === 'OK') {
        console.log('✅ Backend je připravený!');
        console.log(`   Environment: ${response.body.environment}`);
        console.log(`   Timestamp: ${response.body.timestamp}`);
        return true;
      }
      
      console.log(`⚠️  Backend ještě není ready (status: ${response.body.status})`);
    } catch (error) {
      console.log(`❌ Backend nedostupný: ${error.message}`);
    }
    
    if (attempt < MAX_RETRIES) {
      console.log(`   Čekání ${RETRY_DELAY / 1000} sekund...`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY));
    }
  }
  
  throw new Error('Backend nebyl připravený ani po maximálním počtu pokusů');
}

/**
 * Zkontroluje stav databázových tabulek
 */
async function checkMigrationStatus() {
  console.log('\n📊 Kontrola stavu databáze...');
  
  try {
    const response = await httpGet(`${BACKEND_URL}/api/migrate/status`);
    
    if (response.statusCode === 200 && response.body.success) {
      const tables = response.body.tables;
      const existing = Object.entries(tables).filter(([_, status]) => status === 'exists');
      const missing = Object.entries(tables).filter(([_, status]) => status === 'missing');
      
      console.log(`✅ Existující tabulky: ${existing.length}`);
      existing.forEach(([name]) => console.log(`   - ${name}`));
      
      if (missing.length > 0) {
        console.log(`❌ Chybějící tabulky: ${missing.length}`);
        missing.forEach(([name]) => console.log(`   - ${name}`));
        return false; // potřebuje migraci
      } else {
        console.log('✅ Všechny tabulky existují - migrace už byla spuštěna');
        return true; // migrace není potřeba
      }
    }
    
    console.log('⚠️  Nepodařilo se zkontrolovat stav databáze');
    return false;
  } catch (error) {
    console.log(`❌ Chyba při kontrole: ${error.message}`);
    return false;
  }
}

/**
 * Spustí databázovou migraci
 */
async function runMigration() {
  console.log('\n🚀 Spouštění databázové migrace...');
  console.log(`Migration file: ${MIGRATION_FILE}`);
  console.log(`Token: ${MIGRATION_TOKEN.substring(0, 10)}...`);
  
  try {
    const response = await httpPost(
      `${BACKEND_URL}/api/migrate/run`,
      { migrationFile: MIGRATION_FILE },
      { 'X-Migration-Token': MIGRATION_TOKEN }
    );
    
    if (response.statusCode === 200 || response.statusCode === 201) {
      const result = response.body;
      
      console.log('\n✅ MIGRACE DOKONČENA!');
      console.log(`   Celkem SQL příkazů: ${result.totalStatements}`);
      console.log(`   Úspěšných: ${result.successCount}`);
      console.log(`   Chyb: ${result.errorCount}`);
      
      if (result.errorCount > 0) {
        console.log('\n⚠️  Některé příkazy selhaly:');
        result.results
          .filter(r => !r.success)
          .forEach(r => {
            console.log(`   Statement ${r.statement}: ${r.error}`);
          });
      }
      
      return result.errorCount === 0;
    } else if (response.statusCode === 401) {
      console.error('\n❌ CHYBA: Neplatný MIGRATION_TOKEN');
      console.error('   Nastavte správný token v environment variable MIGRATION_TOKEN');
      return false;
    } else {
      console.error(`\n❌ CHYBA: HTTP ${response.statusCode}`);
      console.error(JSON.stringify(response.body, null, 2));
      return false;
    }
  } catch (error) {
    console.error(`\n❌ MIGRACE SELHALA: ${error.message}`);
    return false;
  }
}

/**
 * Finální validace
 */
async function validateMigration() {
  console.log('\n🔍 Finální validace...');
  
  const isComplete = await checkMigrationStatus();
  
  if (isComplete) {
    console.log('\n🎉 MIGRACE ÚSPĚŠNÁ - všechny tabulky existují!');
    return true;
  } else {
    console.log('\n⚠️  Některé tabulky stále chybí');
    return false;
  }
}

/**
 * Main execution
 */
async function main() {
  console.log('═══════════════════════════════════════════');
  console.log('📦 AUTO-MIGRATION SCRIPT');
  console.log('═══════════════════════════════════════════\n');
  
  try {
    // 1. Počkat na backend
    await waitForBackend();
    
    // 2. Zkontrolovat stav databáze
    const alreadyMigrated = await checkMigrationStatus();
    
    if (alreadyMigrated) {
      console.log('\n✅ Migrace již byla provedena - konec');
      process.exit(0);
    }
    
    // 3. Spustit migraci
    const migrationSuccess = await runMigration();
    
    if (!migrationSuccess) {
      console.error('\n❌ Migrace selhala');
      process.exit(1);
    }
    
    // 4. Validovat výsledek
    const validationSuccess = await validateMigration();
    
    if (validationSuccess) {
      console.log('\n═══════════════════════════════════════════');
      console.log('✅ HOTOVO - Systém připravený k použití');
      console.log('═══════════════════════════════════════════');
      process.exit(0);
    } else {
      console.error('\n❌ Validace selhala');
      process.exit(1);
    }
    
  } catch (error) {
    console.error('\n❌ KRITICKÁ CHYBA:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

// Run
if (require.main === module) {
  main();
}

module.exports = { waitForBackend, runMigration, checkMigrationStatus };
