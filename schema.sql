CREATE TABLE IF NOT EXISTS app_state (
  id INTEGER PRIMARY KEY DEFAULT 1,
  clients     JSONB NOT NULL DEFAULT '[]'::jsonb,
  loans       JSONB NOT NULL DEFAULT '[]'::jsonb,
  sms_history JSONB NOT NULL DEFAULT '[]'::jsonb,
  settings    JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT single_row CHECK (id = 1)
);

INSERT INTO app_state (id, clients, loans, sms_history, settings) 
VALUES (1, '[]', '[]', '[]', '{}') 
ON CONFLICT (id) DO NOTHING;
