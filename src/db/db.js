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

  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    owner_phone TEXT NOT NULL,
    timezone TEXT DEFAULT 'America/Toronto',
    appointment_duration_mins INTEGER DEFAULT 60,
    twilio_number TEXT UNIQUE NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS business_hours (
    id TEXT PRIMARY KEY,
    business_id TEXT REFERENCES businesses(id),
    day_of_week INTEGER NOT NULL,
    open_time TEXT NOT NULL,
    close_time TEXT NOT NULL,
    is_open INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS appointments (
    id TEXT PRIMARY KEY,
    lead_id TEXT REFERENCES leads(id),
    business_id TEXT REFERENCES businesses(id),
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    status TEXT DEFAULT 'scheduled',
    service_type TEXT,
    notes TEXT,
    confirmation_code TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS blocked_times (
    id TEXT PRIMARY KEY,
    business_id TEXT REFERENCES businesses(id),
    start_time DATETIME NOT NULL,
    end_time DATETIME NOT NULL,
    reason TEXT
  );
`);

module.exports = db;