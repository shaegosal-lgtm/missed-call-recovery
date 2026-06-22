const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.RAILWAY_ENVIRONMENT
  ? '/data/database.sqlite'
  : path.join(__dirname, '../../database.sqlite');

console.log('Database path:', dbPath);

const db = new Database(dbPath);

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
    viewed INTEGER DEFAULT 0,
    deleted_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS businesses (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    business_phone TEXT,
    owner_phone TEXT NOT NULL,
    timezone TEXT DEFAULT 'America/Toronto',
    appointment_duration_mins INTEGER DEFAULT 60,
    twilio_number TEXT UNIQUE NOT NULL,
    business_info TEXT,
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
    reminder_sent INTEGER DEFAULT 0,
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

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    business_id TEXT REFERENCES businesses(id),
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT DEFAULT 'business',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// --- Safe migrations: add columns to existing databases without data loss ---
// CREATE TABLE IF NOT EXISTS won't alter a table that already exists, so we add
// newer columns here. Each is wrapped so a re-run (column already present) is a no-op.
function ensureColumn(table, column, definition) {
  try {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
    if (!cols.includes(column)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      console.log(`Migration: added ${table}.${column}`);
    }
  } catch (err) {
    console.error(`Migration failed for ${table}.${column}:`, err.message);
  }
}

ensureColumn('leads', 'viewed', 'INTEGER DEFAULT 0');
ensureColumn('leads', 'deleted_at', 'DATETIME');

module.exports = db;