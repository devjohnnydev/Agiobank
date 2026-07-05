require('dotenv').config();
const { Pool } = require('pg');
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function run() {
  try {
    await pool.query(`UPDATE app_state SET clients='[]', loans='[]', sms_history='[]', settings='{}' WHERE id=1;`);
    console.log("DB RESET OK");
  } catch (e) {
    console.error(e);
  } finally {
    await pool.end();
  }
}
run();
