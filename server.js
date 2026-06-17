const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// ─── PostgreSQL ──────────────────────────────────────────────
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    })
  : null;

// ─── Middlewares ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '20mb' }));   // selfies em base64 podem ser grandes
app.use(express.static(path.join(__dirname, '.')));

// ─── Auto-init do banco (cria tabela se não existir) ─────────
async function initDB() {
  if (!pool) return;
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state (
        id INTEGER PRIMARY KEY DEFAULT 1,
        clients     JSONB NOT NULL DEFAULT '[]'::jsonb,
        loans       JSONB NOT NULL DEFAULT '[]'::jsonb,
        sms_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT single_row CHECK (id = 1)
      );
    `);
    await pool.query(`
      INSERT INTO app_state (id) VALUES (1)
      ON CONFLICT (id) DO NOTHING;
    `);
    console.log('✅ Tabela app_state pronta!');
  } catch (err) {
    console.error('❌ Erro ao criar tabela:', err.message);
  }
}

// ─── Health-check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: !!pool, ts: new Date().toISOString() });
});

// ─── GET /api/state ───────────────────────────────────────────
// Retorna o estado completo (clients, loans, sms_history, settings)
app.get('/api/state', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Banco não configurado' });

  try {
    // Garante a linha única
    await pool.query(`
      INSERT INTO app_state (id, clients, loans, sms_history, settings)
      VALUES (1, '[]', '[]', '[]', '{}')
      ON CONFLICT (id) DO NOTHING
    `);

    const result = await pool.query('SELECT * FROM app_state WHERE id = 1');
    const row = result.rows[0];
    res.json({
      clients:    row.clients    || [],
      loans:      row.loans      || [],
      smsHistory: row.sms_history || [],
      settings:   row.settings   || {},
    });
  } catch (err) {
    console.error('GET /api/state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/state ──────────────────────────────────────────
// Recebe o estado completo e salva no banco
app.post('/api/state', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Banco não configurado' });

  const { clients, loans, smsHistory, settings } = req.body;
  if (
    !Array.isArray(clients) ||
    !Array.isArray(loans)
  ) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  try {
    await pool.query(`
      INSERT INTO app_state (id, clients, loans, sms_history, settings, updated_at)
      VALUES (1, $1, $2, $3, $4, NOW())
      ON CONFLICT (id) DO UPDATE
        SET clients     = EXCLUDED.clients,
            loans       = EXCLUDED.loans,
            sms_history = EXCLUDED.sms_history,
            settings    = EXCLUDED.settings,
            updated_at  = NOW()
    `, [
      JSON.stringify(clients),
      JSON.stringify(loans),
      JSON.stringify(smsHistory || []),
      JSON.stringify(settings || {}),
    ]);

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────
app.listen(port, async () => {
  console.log(`🚀 ÁgilBank rodando na porta ${port}`);
  if (pool) {
    console.log('🔌 PostgreSQL conectado via DATABASE_URL');
    await initDB();
  } else {
    console.log('⚠️  DATABASE_URL não definida — modo localStorage apenas');
  }
});
