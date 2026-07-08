const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// ─── PostgreSQL ──────────────────────────────────────────────
const isRailwayInternal = process.env.DATABASE_URL && process.env.DATABASE_URL.includes('internal');

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: isRailwayInternal ? false : { rejectUnauthorized: false },
    })
  : null;


// ─── Middlewares ─────────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '20mb' }));   // selfies em base64 podem ser grandes
app.use(express.static(path.join(__dirname, '.')));

// ─── Auto-init do banco (cria tabelas se não existirem) ─────────
async function initDB() {
  if (!pool) return;
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
        criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        atualizado_em TIMESTAMP NOT NULL DEFAULT NOW(),
        metadata JSONB NOT NULL DEFAULT '{}'::jsonb
      );
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

    console.log('✅ Banco de dados inicializado com sucesso!');
  } catch (err) {
    console.error('❌ Erro ao criar tabelas:', err.message);
  }
}

// ─── Health-check ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, db: !!pool, ts: new Date().toISOString() });
});

// ─── GET /api/state ───────────────────────────────────────────
app.get('/api/state', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Banco não configurado' });

  try {
    // 1. Get configurations
    const stateRes = await pool.query('SELECT * FROM app_state_v2 WHERE id = 1');
    const stateRow = stateRes.rows[0] || { sms_history: [], settings: {} };

    // 2. Get clients
    const cliRes = await pool.query('SELECT * FROM afiliados');
    const clients = cliRes.rows.map(row => ({
      id: row.id,
      nome: row.nome,
      cpf: row.cpf,
      tel: row.telefone,
      email: row.email,
      senha: row.senha,
      score: row.score,
      cadastro: row.criado_em.toISOString(),
      ...(row.metadata || {})
    }));

    // 3. Get loans
    const loanRes = await pool.query('SELECT * FROM emprestimos');
    const loans = loanRes.rows.map(row => ({
      id: row.id,
      clientId: row.afiliado_id,
      creditorId: row.padrinho_id,
      valor: parseFloat(row.valor_principal),
      juros: parseFloat(row.taxa_juros),
      status: row.status,
      createdAt: row.criado_em.toISOString(),
      ...(row.metadata || {})
    }));

    res.json({
      clients,
      loans,
      smsHistory: stateRow.sms_history || [],
      settings: stateRow.settings || {},
    });
  } catch (err) {
    console.error('GET /api/state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/state ──────────────────────────────────────────
app.post('/api/state', async (req, res) => {
  if (!pool) return res.status(503).json({ error: 'Banco não configurado' });

  const { clients, loans, smsHistory, settings } = req.body;
  if (!Array.isArray(clients) || !Array.isArray(loans)) {
    return res.status(400).json({ error: 'Payload inválido' });
  }

  try {
    // 1. Sync config & sms
    await pool.query(`
      INSERT INTO app_state_v2 (id, sms_history, settings, updated_at)
      VALUES (1, $1, $2, NOW())
      ON CONFLICT (id) DO UPDATE
        SET sms_history = EXCLUDED.sms_history,
            settings    = EXCLUDED.settings,
            updated_at  = NOW()
    `, [
      JSON.stringify(smsHistory || []),
      JSON.stringify(settings || {}),
    ]);

    // 2. Sync afiliados
    for (const c of clients) {
      const metadata = { ...c };
      delete metadata.id;
      delete metadata.nome;
      delete metadata.cpf;
      delete metadata.tel;
      delete metadata.email;
      delete metadata.senha;
      delete metadata.score;
      delete metadata.cadastro;

      await pool.query(`
        INSERT INTO afiliados (id, nome, cpf, telefone, email, senha, score, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          nome = EXCLUDED.nome,
          cpf = EXCLUDED.cpf,
          telefone = EXCLUDED.telefone,
          email = EXCLUDED.email,
          senha = EXCLUDED.senha,
          score = EXCLUDED.score,
          metadata = EXCLUDED.metadata,
          atualizado_em = NOW()
      `, [c.id, c.nome, c.cpf, c.tel || '', c.email || '', c.senha || '', c.score || 600, JSON.stringify(metadata)]);
    }

    if (clients.length > 0) {
      const clientIds = clients.map(c => c.id);
      await pool.query('DELETE FROM afiliados WHERE id <> ALL($1)', [clientIds]);
    }

    // 3. Sync emprestimos
    for (const l of loans) {
      const metadata = { ...l };
      delete metadata.id;
      delete metadata.clientId;
      delete metadata.creditorId;
      delete metadata.valor;
      delete metadata.juros;
      delete metadata.status;
      delete metadata.createdAt;

      const createdAtStr = l.createdAt || new Date().toISOString();
      const dataInicio = createdAtStr.split('T')[0];

      await pool.query(`
        INSERT INTO emprestimos (id, afiliado_id, padrinho_id, valor_principal, taxa_juros, data_inicio, status, metadata)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
        ON CONFLICT (id) DO UPDATE SET
          afiliado_id = EXCLUDED.afiliado_id,
          padrinho_id = EXCLUDED.padrinho_id,
          valor_principal = EXCLUDED.valor_principal,
          taxa_juros = EXCLUDED.taxa_juros,
          data_inicio = EXCLUDED.data_inicio,
          status = EXCLUDED.status,
          metadata = EXCLUDED.metadata
      `, [
        l.id,
        l.clientId,
        l.creditorId || 'default',
        l.valor || 0,
        l.juros || 0,
        dataInicio,
        l.status || 'pending',
        JSON.stringify(metadata)
      ]);

      // Sync payments if parcelas exist in metadata
      if (l.parcelas && Array.isArray(l.parcelas)) {
        const paidParcelas = l.parcelas.filter(p => p.status === 'paid');
        for (const p of paidParcelas) {
          const pPaidAt = p.paidAt || new Date().toISOString().split('T')[0];
          const pVal = p.valor || 0;
          
          const existingPayment = await pool.query(
            "SELECT id FROM pagamentos WHERE emprestimo_id = $1 AND (metadata->>'parcela_n')::int = $2",
            [l.id, p.n]
          );
          
          if (existingPayment.rows.length === 0) {
            await pool.query(`
              INSERT INTO pagamentos (emprestimo_id, valor_pago, tipo, data_pagamento, metadata)
              VALUES ($1, $2, $3, $4, $5)
            `, [
              l.id,
              pVal,
              'amortizacao_principal',
              pPaidAt,
              JSON.stringify({ parcela_n: p.n })
            ]);
          }
        }
      }
    }

    if (loans.length > 0) {
      const loanIds = loans.map(l => l.id);
      await pool.query('DELETE FROM emprestimos WHERE id <> ALL($1)', [loanIds]);
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/state error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/afiliados ──────────────────────────────────────
app.post('/api/afiliados', async (req, res) => {
  const { nome, cpf, telefone, email, senha, ...rest } = req.body;
  if (!nome || !cpf) {
    return res.status(400).json({ error: 'Nome e CPF são obrigatórios' });
  }
  try {
    const existing = await pool.query('SELECT * FROM afiliados WHERE cpf = $1 OR telefone = $2', [cpf, telefone]);
    if (existing.rows.length > 0) {
      const client = existing.rows[0];
      // Se o afiliado já foi pré-cadastrado pelo padrinho (não possui senha) e está se cadastrando com senha agora
      if (!client.senha && senha) {
        const result = await pool.query(`
          UPDATE afiliados
          SET nome = $1, telefone = $2, email = $3, senha = $4, metadata = metadata || $5, atualizado_em = NOW()
          WHERE id = $6
          RETURNING *
        `, [nome, telefone || client.telefone, email || client.email || '', senha, JSON.stringify(rest), client.id]);
        
        // Se houver indicação, aumentamos o score de quem indicou (+100)
        if (rest.indicacao) {
          const cleanInd = rest.indicacao.trim();
          const indResult = await pool.query(
            "SELECT id, score FROM afiliados WHERE cpf = $1 OR UPPER(nome) = UPPER($2)",
            [cleanInd, cleanInd]
          );
          if (indResult.rows.length > 0) {
            const indicator = indResult.rows[0];
            const newScore = Math.min(1000, (indicator.score || 600) + 100);
            await pool.query("UPDATE afiliados SET score = $1 WHERE id = $2", [newScore, indicator.id]);
            console.log(`Score do indicador ${indicator.id} aumentado para ${newScore}`);
          }
        }

        const activatedClient = result.rows[0];
        return res.status(200).json({
          message: 'Cadastro de afiliado ativado com sucesso',
          client: { id: activatedClient.id, nome: activatedClient.nome, cpf: activatedClient.cpf, tel: activatedClient.telefone, email: activatedClient.email, senha: activatedClient.senha, score: activatedClient.score, ...(activatedClient.metadata || {}) }
        });
      }

      return res.status(200).json({ 
        message: 'Afiliado já cadastrado', 
        client: { id: client.id, nome: client.nome, cpf: client.cpf, tel: client.telefone, email: client.email, senha: client.senha, score: client.score, ...(client.metadata || {}) } 
      });
    }

    const id = 'c' + Date.now();
    const result = await pool.query(`
      INSERT INTO afiliados (id, nome, cpf, telefone, email, senha, score, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, 600, $7)
      RETURNING *
    `, [id, nome, cpf, telefone, email || '', senha || '', JSON.stringify(rest)]);
    
    // Se houver indicação, aumentamos o score de quem indicou (+100)
    if (rest.indicacao) {
      const cleanInd = rest.indicacao.trim();
      const indResult = await pool.query(
        "SELECT id, score FROM afiliados WHERE cpf = $1 OR UPPER(nome) = UPPER($2)",
        [cleanInd, cleanInd]
      );
      if (indResult.rows.length > 0) {
        const indicator = indResult.rows[0];
        const newScore = Math.min(1000, (indicator.score || 600) + 100);
        await pool.query("UPDATE afiliados SET score = $1 WHERE id = $2", [newScore, indicator.id]);
        console.log(`Score do indicador ${indicator.id} aumentado para ${newScore}`);
      }
    }

    const client = result.rows[0];
    res.status(201).json({
      message: 'Afiliado cadastrado com sucesso',
      client: { id: client.id, nome: client.nome, cpf: client.cpf, tel: client.telefone, email: client.email, senha: client.senha, score: client.score, ...(client.metadata || {}) }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/emprestimos ────────────────────────────────────
app.post('/api/emprestimos', async (req, res) => {
  const { afiliado_id, cpf, padrinho_id, valor_principal, taxa_juros, data_inicio, observacoes, ...rest } = req.body;
  let finalAfiliadoId = afiliado_id;
  
  try {
    if (!finalAfiliadoId && cpf) {
      const af = await pool.query('SELECT id FROM afiliados WHERE cpf = $1', [cpf]);
      if (af.rows.length === 0) {
        return res.status(404).json({ error: 'Afiliado não encontrado para o CPF informado' });
      }
      finalAfiliadoId = af.rows[0].id;
    }

    if (!finalAfiliadoId) {
      return res.status(400).json({ error: 'afiliado_id ou cpf é obrigatório' });
    }


    const id = 'l' + Date.now();
    const result = await pool.query(`
      INSERT INTO emprestimos (id, afiliado_id, padrinho_id, valor_principal, taxa_juros, data_inicio, status, observacoes, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, $8)
      RETURNING *
    `, [
      id,
      finalAfiliadoId,
      padrinho_id || 'default',
      valor_principal,
      taxa_juros,
      data_inicio || new Date().toISOString().split('T')[0],
      observacoes || '',
      JSON.stringify(rest)
    ]);

    res.status(201).json({
      message: 'Empréstimo criado com sucesso',
      loan: result.rows[0]
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/afiliados/:id/emprestimos ────────────────────────
app.get('/api/afiliados/:id/emprestimos', async (req, res) => {
  const { id } = req.params;
  try {
    const af = await pool.query('SELECT * FROM afiliados WHERE id = $1', [id]);
    if (af.rows.length === 0) {
      return res.status(404).json({ error: 'Afiliado não encontrado' });
    }

    const loansRes = await pool.query('SELECT * FROM emprestimos WHERE afiliado_id = $1', [id]);
    const loans = [];
    let totalDevedorConsolidado = 0;

    for (const loan of loansRes.rows) {
      // Query payments
      const payRes = await pool.query('SELECT SUM(valor_pago) as total_pago FROM pagamentos WHERE emprestimo_id = $1', [loan.id]);
      const totalPago = parseFloat(payRes.rows[0].total_pago || 0);

      // Calculamos o tempo decorrido em meses.
      // Usamos juros simples: Juros = Principal * (Taxa / 100) * Meses.
      // Se for menor que 1 mês, consideramos 1 mês para a taxa mensal mínima aplicável.
      const start = new Date(loan.data_inicio);
      const end = loan.data_quitacao ? new Date(loan.data_quitacao) : new Date();

      const freq = (loan.metadata && loan.metadata.frequencia) || 'mensal';
      let periods = 1;

      if (freq === 'diario') {
        const diffTime = Math.abs(end - start);
        const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
        periods = diffDays < 1 ? 1 : diffDays;
      } else if (freq === 'semanal') {
        const diffTime = Math.abs(end - start);
        const diffWeeks = Math.ceil(diffTime / (1000 * 60 * 60 * 24 * 7));
        periods = diffWeeks < 1 ? 1 : diffWeeks;
      } else { // mensal
        let months = (end.getFullYear() - start.getFullYear()) * 12 + (end.getMonth() - start.getMonth());
        periods = months < 1 ? 1 : months;
      }

      const principal = parseFloat(loan.valor_principal);
      const jurosRate = parseFloat(loan.taxa_juros) / 100;
      const jurosAcumulados = principal * jurosRate * periods;

      let saldoDevedor = principal + jurosAcumulados - totalPago;
      if (saldoDevedor < 0) saldoDevedor = 0;

      if (loan.status === 'ativo' || loan.status === 'active' || loan.status === 'overdue' || loan.status === 'inadimplente') {
        totalDevedorConsolidado += saldoDevedor;
      }

      loans.push({
        id: loan.id,
        padrinho_id: loan.padrinho_id,
        valor_principal: principal,
        taxa_juros: parseFloat(loan.taxa_juros),
        data_inicio: loan.data_inicio,
        data_quitacao: loan.data_quitacao,
        status: loan.status,
        juros_acumulados: jurosAcumulados,
        total_pago: totalPago,
        saldo_devedor: parseFloat(saldoDevedor.toFixed(2)),
        observacoes: loan.observacoes,
        metadata: loan.metadata
      });
    }

    res.json({
      afiliado: {
        id: af.rows[0].id,
        nome: af.rows[0].nome,
        cpf: af.rows[0].cpf,
        telefone: af.rows[0].telefone,
        email: af.rows[0].email
      },
      emprestimos: loans,
      total_devedor_consolidado: parseFloat(totalDevedorConsolidado.toFixed(2))
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/emprestimos/:id/pagamentos ──────────────────────
app.post('/api/emprestimos/:id/pagamentos', async (req, res) => {
  const { id } = req.params;
  const { valor_pago, tipo } = req.body;
  
  if (!valor_pago || !tipo) {
    return res.status(400).json({ error: 'valor_pago e tipo são obrigatórios' });
  }

  try {
    const loanRes = await pool.query('SELECT * FROM emprestimos WHERE id = $1', [id]);
    if (loanRes.rows.length === 0) {
      return res.status(404).json({ error: 'Empréstimo não encontrado' });
    }

    const loan = loanRes.rows[0];

    await pool.query(`
      INSERT INTO pagamentos (emprestimo_id, valor_pago, tipo, data_pagamento)
      VALUES ($1, $2, $3, CURRENT_DATE)
    `, [id, valor_pago, tipo]);

    // Atualiza status se quitacao_total
    if (tipo === 'quitacao_total') {
      await pool.query(`
        UPDATE emprestimos
        SET status = 'quitado', data_quitacao = CURRENT_DATE
        WHERE id = $1
      `, [id]);
    }

    // Lógica de ajuste de Score
    const clientRes = await pool.query("SELECT score FROM afiliados WHERE id = $1", [loan.afiliado_id]);
    if (clientRes.rows.length > 0) {
      const currentScore = clientRes.rows[0].score || 600;
      // Se o empréstimo estiver vencido (overdue/inadimplente), perde 150 pontos; senão ganha 50 por pagar em dia
      const isLate = (loan.status === 'overdue' || loan.status === 'inadimplente');
      const scoreDiff = isLate ? -150 : 50;
      const newScore = Math.max(0, Math.min(1000, currentScore + scoreDiff));
      await pool.query("UPDATE afiliados SET score = $1 WHERE id = $2", [newScore, loan.afiliado_id]);
      console.log(`Score do afiliado ${loan.afiliado_id} atualizado de ${currentScore} para ${newScore} (${scoreDiff > 0 ? '+' : ''}${scoreDiff})`);
    }

    res.json({ message: 'Pagamento registrado com sucesso' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SPA fallback ─────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────
app.listen(port, '0.0.0.0', async () => {
  console.log(`🚀 ÁgilBank rodando na porta ${port}`);
  if (pool) {
    console.log('🔌 PostgreSQL conectado via DATABASE_URL');
    await initDB();
  } else {
    console.log('⚠️  DATABASE_URL não definida — modo localStorage apenas');
  }
});
