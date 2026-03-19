const db = require('./config/database');

async function cleanLocalDb() {
  try {
    await db.query('SET FOREIGN_KEY_CHECKS = 0');

    const queries = [
      'DELETE FROM club_member_delegations',
      'DELETE FROM coach_profiles',
      'DELETE FROM player_profiles',
      'DELETE FROM parent_child_links',
      'DELETE FROM parents',
      'DELETE FROM private_coach_players',
      'DELETE FROM invites',
      'DELETE FROM club_members',
      'DELETE FROM password_resets',
      'DELETE FROM attendance',
      'DELETE FROM match_lineup',
      'DELETE FROM match_events',
      'DELETE FROM match_statistics',
      'DELETE FROM matches',
      'DELETE FROM training_exercises',
      'DELETE FROM training_sections',
      'DELETE FROM training_sessions',
      'DELETE FROM team_memberships',
      'DELETE FROM teams',
      'DELETE FROM test_results',
      'DELETE FROM tests',
      'DELETE FROM test_categories',
      'DELETE FROM evaluations',
      'DELETE FROM media',
      'DELETE FROM assistant_links',
      'DELETE FROM consent_records',
      'DELETE FROM audit_logs',
      'DELETE FROM refresh_tokens',
      'DELETE FROM email_verifications',
      'DELETE FROM clubs',
      "DELETE FROM users WHERE role != 'admin'",
    ];

    for (const query of queries) {
      try {
        await db.query(query);
      } catch (error) {
        console.log(`skip: ${query} - ${error.code || error.message}`);
      }
    }

    await db.query('SET FOREIGN_KEY_CHECKS = 1');

    const [rows] = await db.query(
      "SELECT (SELECT COUNT(*) FROM users WHERE role != 'admin') AS non_admin_users, (SELECT COUNT(*) FROM clubs) AS clubs_count, (SELECT COUNT(*) FROM email_verifications) AS verifications_count"
    );

    console.log('CLEAN_OK', JSON.stringify(rows[0]));
    process.exit(0);
  } catch (error) {
    console.error('CLEAN_FAIL', error.message);
    try {
      await db.query('SET FOREIGN_KEY_CHECKS = 1');
    } catch {}
    process.exit(1);
  }
}

cleanLocalDb();
