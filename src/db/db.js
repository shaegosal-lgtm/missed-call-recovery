const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, '../../database.sqlite'));

db.exec(`
  CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY,
    from_number TEXT NOT NULL,
    to_number TEXT NOT NULL,
    call_sid TEXT UNIQUE NOT NULL,
    status TEXT DEFAULT 'missed',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS leads (
    id TEXT PRIMARY KEY,
    call_id TEXT REFERENCES calls(id),
    phone TEXT NOT NULL,
    name TEXT,
    reason TEXT,
    urgency TEXT DEFAULT 'unknown',
    lead_type TEXT DEFAULT 'unknown',
    ai_summary TEXT,
    status TEXT DEFAULT 'new',
    conversation TEXT DEFAULT '[]',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

module.exports = db;