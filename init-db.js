const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/agilbank',
});

async function initDB() {
  console.log("Inicializando banco de dados...");
  
  try {
    // Tabela de Usuários (Clientes e Admin)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        nome VARCHAR(255) NOT NULL,
        cpf VARCHAR(20) UNIQUE NOT NULL,
        email VARCHAR(255),
        telefone VARCHAR(20),
        senha VARCHAR(255) NOT NULL,
        nascimento DATE,
        rg VARCHAR(20),
        estado_civil VARCHAR(50),
        cep VARCHAR(20),
        cidade VARCHAR(100),
        estado VARCHAR(2),
        endereco TEXT,
        emprego VARCHAR(100),
        trabalho VARCHAR(100),
        renda VARCHAR(50),
        garantia TEXT,
        indicacao VARCHAR(255),
        role VARCHAR(20) DEFAULT 'client',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Inserir Admin padrão se não existir
    const adminCheck = await pool.query("SELECT * FROM users WHERE role = 'admin'");
    if (adminCheck.rows.length === 0) {
      await pool.query(`
        INSERT INTO users (nome, cpf, senha, role) 
        VALUES ('Administrador', 'admin', 'admin123', 'admin')
      `);
      console.log("Usuário admin criado (admin / admin123)");
    }

    // Tabela de Empréstimos
    await pool.query(`
      CREATE TABLE IF NOT EXISTS loans (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES users(id),
        valor DECIMAL(10,2) NOT NULL,
        prazo INTEGER NOT NULL,
        motivo VARCHAR(255),
        descricao TEXT,
        status VARCHAR(50) DEFAULT 'pending',
        juros_taxa DECIMAL(5,2),
        total_com_juros DECIMAL(10,2),
        selfie TEXT,
        location_lat DECIMAL(10,8),
        location_lng DECIMAL(11,8),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabela de Parcelas
    await pool.query(`
      CREATE TABLE IF NOT EXISTS installments (
        id SERIAL PRIMARY KEY,
        loan_id INTEGER REFERENCES loans(id),
        numero INTEGER NOT NULL,
        valor DECIMAL(10,2) NOT NULL,
        vencimento DATE NOT NULL,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Tabela de Configurações
    await pool.query(`
      CREATE TABLE IF NOT EXISTS settings (
        id SERIAL PRIMARY KEY,
        key VARCHAR(50) UNIQUE NOT NULL,
        value TEXT NOT NULL
      );
    `);

    // Tabela de Histórico SMS
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sms_history (
        id SERIAL PRIMARY KEY,
        client_id INTEGER REFERENCES users(id),
        telefone VARCHAR(20),
        mensagem TEXT,
        status VARCHAR(20) DEFAULT 'sent',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    console.log("✅ Banco de dados inicializado com sucesso!");
  } catch (err) {
    console.error("❌ Erro ao inicializar banco de dados:", err);
  } finally {
    await pool.end();
  }
}

initDB();
