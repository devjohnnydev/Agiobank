require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function force() {
  try {
    await pool.query('DELETE FROM app_state WHERE id=1;');
    await pool.query(`INSERT INTO app_state (id, clients, loans, sms_history, settings) VALUES (1, '[]', '[]', '[]', '{}');`);
    console.log('FORCED WIPE');
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
    process.exit(0);
  }
}
force();
