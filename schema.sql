-- Tabela de afiliados (cadastro único, reaproveitável)
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

-- Tabela de empréstimos: 1 afiliado -> N empréstimos
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

-- Histórico de pagamentos (juros e amortização separados)
CREATE TABLE IF NOT EXISTS pagamentos (
    id SERIAL PRIMARY KEY,
    emprestimo_id VARCHAR(50) NOT NULL REFERENCES emprestimos(id) ON DELETE CASCADE,
    valor_pago NUMERIC(12,2) NOT NULL,
    tipo VARCHAR(30) NOT NULL CHECK (tipo IN ('juros', 'amortizacao', 'quitacao_total', 'juros_pagos', 'amortizacao_principal')),
    data_pagamento DATE NOT NULL DEFAULT CURRENT_DATE,
    criado_em TIMESTAMP NOT NULL DEFAULT NOW(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- Estado do app (para configurações e SMS)
CREATE TABLE IF NOT EXISTS app_state_v2 (
  id INTEGER PRIMARY KEY DEFAULT 1,
  sms_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO app_state_v2 (id, sms_history, settings) 
VALUES (1, '[]', '{}') 
ON CONFLICT (id) DO NOTHING;

-- Remove o limite de 2 empréstimos ativos por afiliado
DROP INDEX IF EXISTS idx_emprestimos_afiliado_ativo;
