require('dotenv').config();
console.log('ENV CHECK - SID starts with:', process.env.TWILIO_ACCOUNT_SID?.substring(0, 4));
const express = require('express');
const session = require('express-session');
const { v4: uuidv4 } = require('uuid');
const db = require('./db/db');
const { startReminderJob } = require('./services/reminderService');

const twilioRoutes = require('./routes/twilio');
const leadRoutes = require('./routes/leads');
const appointmentRoutes = require('./routes/appointments');
const adminRoutes = require('./routes/admin');
const dashboardRoutes = require('./routes/dashboard');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(session({
  secret: process.env.ADMIN_KEY || 'fallback-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 hours
}));

app.use('/webhooks/twilio', twilioRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/appointments', appointmentRoutes);
app.use('/api/admin', adminRoutes);
app.use('/dashboard', dashboardRoutes);

app.get('/', (req, res) => res.redirect('/dashboard'));

function runMigrations() {
  const migrations = [
    `ALTER TABLE businesses ADD COLUMN business_phone TEXT`,
    `ALTER TABLE appointments ADD COLUMN reminder_sent INTEGER DEFAULT 0`,
    `ALTER TABLE businesses ADD COLUMN business_info TEXT`,
  ];

  migrations.forEach(sql => {
    try {
      db.exec(sql);
      console.log('Migration applied:', sql);
    } catch (e) {
      // Column already exists — skip silently
    }
  });
}

function setupBusiness() {
  const twilioNumber = process.env.TWILIO_PHONE_NUMBER;
  const ownerPhone = process.env.OWNER_PHONE_NUMBER;

  if (!twilioNumber || !ownerPhone) return;

  const existing = db.prepare('SELECT id FROM businesses WHERE twilio_number = ?').get(twilioNumber);
  if (existing) {
    console.log('Business already set up:', existing.id);
    return;
  }

  const id = uuidv4();
  db.prepare(`INSERT INTO businesses (id, name, owner_phone, timezone, appointment_duration_mins, twilio_number) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, 'My Business', ownerPhone, 'America/Toronto', 60, twilioNumber);

  const days = [1, 2, 3, 4, 5];
  days.forEach(day => {
    db.prepare(`INSERT INTO business_hours (id, business_id, day_of_week, open_time, close_time, is_open) VALUES (?, ?, ?, ?, ?, 1)`)
      .run(uuidv4(), id, day, '09:00', '17:00');
  });

  console.log('Business auto-created:', id);
}

runMigrations();
setupBusiness();
startReminderJob();

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});