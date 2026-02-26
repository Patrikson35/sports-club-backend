const express = require('express');
const router = express.Router();
const fs = require('fs').promises;
const path = require('path');
const db = require('../config/database');

/**
 * MIGRATION ENDPOINT
 * 
 * Spustí databázovou migraci pouze pokud je požadavek autorizován admin tokenem.
 * 
 * POST /api/migrate/run
 * Headers: { "X-Migration-Token": "SECRET_TOKEN" }
 * Body: { "migrationFile": "20260226_registration_system.sql" }
 */

const MIGRATION_TOKEN = process.env.MIGRATION_TOKEN || 'change-me-in-production';

router.post('/run', async (req, res) => {
  try {
    // Security check
    const token = req.headers['x-migration-token'];
    if (!token || token !== MIGRATION_TOKEN) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized - invalid migration token'
      });
    }

    const { migrationFile } = req.body;
    if (!migrationFile) {
      return res.status(400).json({
        success: false,
        error: 'Migration file name required'
      });
    }

    // Read migration file
    const migrationsDir = path.join(__dirname, '../../migrations');
    const migrationPath = path.join(migrationsDir, migrationFile);
    
    let sqlContent;
    try {
      sqlContent = await fs.readFile(migrationPath, 'utf8');
    } catch (error) {
      return res.status(404).json({
        success: false,
        error: `Migration file not found: ${migrationFile}`
      });
    }

    // Split SQL content by statements (by semicolons, but handle multi-line)
    const statements = sqlContent
      .split(';')
      .map(stmt => stmt.trim())
      .filter(stmt => stmt.length > 0 && !stmt.startsWith('--'));

    console.log(`Running migration: ${migrationFile}`);
    console.log(`Found ${statements.length} SQL statements`);

    const results = [];
    let successCount = 0;
    let errorCount = 0;

    // Execute each statement
    for (let i = 0; i < statements.length; i++) {
      const statement = statements[i] + ';'; // Re-add semicolon
      try {
        console.log(`Executing statement ${i + 1}/${statements.length}...`);
        await db.query(statement);
        successCount++;
        results.push({
          statement: i + 1,
          success: true,
          preview: statement.substring(0, 100) + '...'
        });
      } catch (error) {
        errorCount++;
        const errorMsg = error.message;
        
        // Ignore "table already exists" errors
        if (errorMsg.includes('already exists') || errorMsg.includes('Duplicate')) {
          console.log(`Statement ${i + 1} skipped (already exists)`);
          results.push({
            statement: i + 1,
            success: true,
            skipped: true,
            preview: statement.substring(0, 100) + '...'
          });
          successCount++;
          errorCount--;
        } else {
          console.error(`Statement ${i + 1} failed:`, errorMsg);
          results.push({
            statement: i + 1,
            success: false,
            error: errorMsg,
            preview: statement.substring(0, 100) + '...'
          });
        }
      }
    }

    res.json({
      success: errorCount === 0,
      message: `Migration completed: ${successCount} successful, ${errorCount} errors`,
      migrationFile,
      totalStatements: statements.length,
      successCount,
      errorCount,
      results: results.slice(0, 20) // Return first 20 results to avoid huge response
    });

  } catch (error) {
    console.error('Migration error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * List available migrations
 * GET /api/migrate/list
 */
router.get('/list', async (req, res) => {
  try {
    const migrationsDir = path.join(__dirname, '../../migrations');
    const files = await fs.readdir(migrationsDir);
    const migrations = files.filter(f => f.endsWith('.sql'));

    res.json({
      success: true,
      migrations
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Check migration status (which tables exist)
 * GET /api/migrate/status
 */
router.get('/status', async (req, res) => {
  try {
    const tables = [
      'users',
      'clubs',
      'teams',
      'parent_child_links',
      'private_coach_players',
      'invites',
      'consent_records',
      'coach_assistants',
      'club_members',
      'email_verifications',
      'password_resets'
    ];

    const status = {};
    for (const table of tables) {
      try {
        await db.query(`SELECT 1 FROM ${table} LIMIT 1`);
        status[table] = 'exists';
      } catch (error) {
        status[table] = 'missing';
      }
    }

    res.json({
      success: true,
      tables: status
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
