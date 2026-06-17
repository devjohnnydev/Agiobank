const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  console.log('🔌 Conectando ao banco de dados...');
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        clients  JSONB NOT NULL DEFAULT '[]'::jsonb,
        loans    JSONB NOT NULL DEFAULT '[]'::jsonb,
        sms_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        settings JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT single_row CHECK (id = 1)
      );
    `);

    // Garantir que existe exatamente uma linha
    await pool.query(`
      INSERT INTO app_state (id, clients, loans, sms_history, settings)
      VALUES (1, '[]', '[]', '[]', '{}')
      ON CONFLICT (id) DO NOTHING;
    `);

    console.log('✅ Banco de dados pronto!');
  } catch (err) {
    console.error('❌ Erro ao inicializar banco:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

initDB();
