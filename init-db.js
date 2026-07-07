const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function initDB() {
  console.log('🔌 Conectando ao banco de dados...');
  try {
    // 1. Tabela de afiliados
    await pool.query(`
      CREATE TABLE IF NOT EXISTS afiliados (
        id VARCHAR(50) PRIMARY KEY,
        nome VARCHAR(150) NOT NULL,
        cpf VARCHAR(14) UNIQUE NOT NULL,
        telefone VARCHAR(20),
        email VARCHAR(150),
        senha VARCHAR(100),
        score INTEGER NOT NULL DEFAULT 600,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);
    
    // Add column if table already existed without it
    await pool.query(`
      ALTER TABLE afiliados ADD COLUMN IF NOT EXISTS score INTEGER NOT NULL DEFAULT 600;
    `);

    // 2. Tabela de empréstimos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS emprestimos (
        id VARCHAR(50) PRIMARY KEY,
        afiliado_id VARCHAR(50) NOT NULL REFERENCES afiliados(id) ON DELETE CASCADE,
        padrinho_id VARCHAR(50) NOT NULL,
        valor_principal NUMERIC(12,2) NOT NULL,
        taxa_juros NUMERIC(5,2) NOT NULL,
        data_inicio DATE NOT NULL DEFAULT CURRENT_DATE,
        data_quitacao DATE,
        status VARCHAR(30) NOT NULL DEFAULT 'pending'
          CHECK (status IN ('ativo', 'quitado', 'inadimplente', 'pending', 'active', 'overdue', 'rejected', 'paid')),
        observacoes TEXT,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    // 3. Tabela de pagamentos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS pagamentos (
        id SERIAL PRIMARY KEY,
        emprestimo_id VARCHAR(50) NOT NULL REFERENCES emprestimos(id) ON DELETE CASCADE,
        valor_pago NUMERIC(12,2) NOT NULL,
        tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('juros', 'amortizacao', 'quitacao_total', 'juros_pagos', 'amortizacao_principal')),
        data_pagamento DATE NOT NULL DEFAULT CURRENT_DATE,
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
    `);

    // 4. Estado do app (configurações e SMS)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS app_state_v2 (
        id INTEGER PRIMARY KEY DEFAULT 1,
        sms_history JSONB NOT NULL DEFAULT '[]'::jsonb,
        settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT single_row CHECK (id = 1)
      );
    `);

    // Garantir que existe exatamente uma linha de estado
    await pool.query(`
      INSERT INTO app_state_v2 (id, sms_history, settings)
      VALUES (1, '[]', '{}')
      ON CONFLICT (id) DO NOTHING;
    `);

    // 5. Índice de empréstimos ativos
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_emprestimos_afiliado_ativo
      ON emprestimos (afiliado_id)
      WHERE status IN ('ativo', 'active', 'overdue', 'inadimplente');
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
