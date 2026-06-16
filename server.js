const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 3000;

// Configuração do PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agilbank',
});

// Middlewares
app.use(cors());
// Aumentar o limite para suportar imagens em Base64 grandes (selfies)
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, '.')));

// ----------------------------------------------------
// ROTAS DE AUTENTICAÇÃO E CLIENTES
// ----------------------------------------------------

// Registrar novo cliente
app.post('/api/register', async (req, res) => {
  const { nome, cpf, email, tel, senha, nasc, rg, estadoCivil, cep, cidade, estado, endereco, emprego, trabalho, renda, garantia, indicacao } = req.body;
  
  try {
    const result = await pool.query(
      `INSERT INTO users 
      (nome, cpf, email, telefone, senha, nascimento, rg, estado_civil, cep, cidade, estado, endereco, emprego, trabalho, renda, garantia, indicacao) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) 
      RETURNING id, nome, cpf, role`,
      [nome, cpf, email, tel, senha, nasc, rg, estadoCivil, cep, cidade, estado, endereco, emprego, trabalho, renda, garantia, indicacao]
    );
    res.json({ success: true, user: result.rows[0] });
  } catch (err) {
    console.error(err);
    if (err.constraint === 'users_cpf_key') {
      return res.status(400).json({ error: 'CPF já cadastrado.' });
    }
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Login (Cliente ou Admin)
app.post('/api/login', async (req, res) => {
  const { user, pass, type } = req.body; // user = CPF para cliente, username para admin
  
  try {
    let result;
    if (type === 'admin') {
      result = await pool.query("SELECT * FROM users WHERE cpf = $1 AND role = 'admin'", [user]);
    } else {
      result = await pool.query("SELECT * FROM users WHERE (cpf = $1 OR email = $1) AND role = 'client'", [user]);
    }

    if (result.rows.length === 0 || result.rows[0].senha !== pass) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos' });
    }

    const userData = result.rows[0];
    delete userData.senha; // Não retornar a senha!

    res.json({ success: true, user: userData });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro no servidor' });
  }
});

// Buscar perfil do usuário
app.get('/api/users/:id', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Não encontrado' });
    const user = result.rows[0];
    delete user.senha;
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

// ----------------------------------------------------
// ROTAS DE EMPRÉSTIMOS
// ----------------------------------------------------

// Criar novo pedido
app.post('/api/loans', async (req, res) => {
  const { clientId, valor, prazo, motivo, descricao, selfie, location } = req.body;
  
  try {
    const lat = location ? location.lat : null;
    const lng = location ? location.lng : null;

    const result = await pool.query(
      `INSERT INTO loans (client_id, valor, prazo, motivo, descricao, selfie, location_lat, location_lng)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [clientId, valor, prazo, motivo, descricao, selfie, lat, lng]
    );
    res.json({ success: true, loan: result.rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro ao criar empréstimo' });
  }
});

// Listar empréstimos do cliente
app.get('/api/loans/client/:id', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM loans WHERE client_id = $1 ORDER BY created_at DESC", [req.params.id]);
    
    // Buscar parcelas para esses empréstimos
    const loans = result.rows;
    for (let loan of loans) {
      const instResult = await pool.query("SELECT * FROM installments WHERE loan_id = $1 ORDER BY numero", [loan.id]);
      loan.parcelas = instResult.rows;
    }
    
    res.json(loans);
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

// ----------------------------------------------------
// ROTAS DO ADMIN
// ----------------------------------------------------

// Listar todos os empréstimos (para o Admin)
app.get('/api/admin/loans', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT l.*, u.nome as client_nome, u.cpf as client_cpf, u.telefone as client_tel,
             u.emprego as client_emprego, u.renda as client_renda, u.cidade as client_cidade, u.estado as client_estado,
             u.trabalho as client_trabalho, u.garantia as client_garantia, u.indicacao as client_indicacao
      FROM loans l
      JOIN users u ON l.client_id = u.id
      ORDER BY l.created_at DESC
    `);
    
    const loans = result.rows;
    for (let loan of loans) {
      const instResult = await pool.query("SELECT * FROM installments WHERE loan_id = $1 ORDER BY numero", [loan.id]);
      loan.parcelas = instResult.rows;
      // Formatar de volta location se existir
      if (loan.location_lat && loan.location_lng) {
        loan.location = { lat: loan.location_lat, lng: loan.location_lng };
      }
    }
    
    res.json(loans);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Erro' });
  }
});

// Listar clientes
app.get('/api/admin/clients', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM users WHERE role = 'client' ORDER BY nome");
    const clients = result.rows.map(c => { delete c.senha; return c; });
    res.json(clients);
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

// Aprovar Empréstimo
app.post('/api/admin/loans/:id/approve', async (req, res) => {
  const { taxaJuros, totalComJuros, parcelas } = req.body;
  const loanId = req.params.id;

  try {
    await pool.query("BEGIN");
    
    // Update loan
    await pool.query(
      "UPDATE loans SET status = 'active', juros_taxa = $1, total_com_juros = $2 WHERE id = $3",
      [taxaJuros, totalComJuros, loanId]
    );

    // Insert installments
    for (let p of parcelas) {
      await pool.query(
        "INSERT INTO installments (loan_id, numero, valor, vencimento) VALUES ($1, $2, $3, $4)",
        [loanId, p.numero, p.valor, p.vencimento]
      );
    }

    await pool.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    console.error(err);
    res.status(500).json({ error: 'Erro ao aprovar' });
  }
});

// Rejeitar Empréstimo
app.post('/api/admin/loans/:id/reject', async (req, res) => {
  try {
    await pool.query("UPDATE loans SET status = 'rejected' WHERE id = $1", [req.params.id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Erro ao rejeitar' });
  }
});

// Pagar Parcela
app.post('/api/admin/installments/:id/pay', async (req, res) => {
  try {
    const instId = req.params.id;
    await pool.query("BEGIN");
    
    await pool.query("UPDATE installments SET status = 'paid' WHERE id = $1", [instId]);
    
    // Check if loan is fully paid
    const loanResult = await pool.query("SELECT loan_id FROM installments WHERE id = $1", [instId]);
    const loanId = loanResult.rows[0].loan_id;
    
    const pendingInstResult = await pool.query("SELECT count(*) FROM installments WHERE loan_id = $1 AND status != 'paid'", [loanId]);
    if (parseInt(pendingInstResult.rows[0].count) === 0) {
      await pool.query("UPDATE loans SET status = 'paid' WHERE id = $1", [loanId]);
    }
    
    await pool.query("COMMIT");
    res.json({ success: true });
  } catch (err) {
    await pool.query("ROLLBACK");
    res.status(500).json({ error: 'Erro ao pagar' });
  }
});

// Frontend route fallback (For SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Iniciar Servidor
app.listen(port, () => {
  console.log(`🚀 Servidor rodando na porta ${port}`);
});
