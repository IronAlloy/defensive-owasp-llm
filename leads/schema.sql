-- vr_leads — real participant emails for the playbook. Kept apart from the demo entirely.
DROP TABLE IF EXISTS leads;
CREATE TABLE leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  email TEXT NOT NULL,
  name TEXT,
  lang TEXT,
  consent_playbook INTEGER NOT NULL DEFAULT 0,   -- required to receive the playbook
  consent_marketing INTEGER NOT NULL DEFAULT 0,  -- optional future updates
  consent_text_version TEXT,
  source TEXT
);
CREATE UNIQUE INDEX idx_leads_email ON leads(email);
