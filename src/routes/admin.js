const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../db/db');

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Create a new business
router.post('/businesses', adminAuth, (req, res) => {
  const {
    name, ownerPhone, twilioNumber, businessPhone,
    timezone, durationMins, businessInfo, openTime, closeTime, workDays
  } = req.body;

  if (!name || !ownerPhone || !twilioNumber) {
    return res.status(400).json({ error: 'name, ownerPhone, and twilioNumber are required' });
  }

  try {
    const existing = db.prepare('SELECT id FROM businesses WHERE twilio_number = ?').get(twilioNumber);
    if (existing) {
      return res.status(409).json({ error: 'A business with this Twilio number already exists' });
    }

    const id = uuidv4();
    db.prepare(`
      INSERT INTO businesses 
      (id, name, owner_phone, twilio_number, business_phone, timezone, appointment_duration_mins, business_info)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, name, ownerPhone, twilioNumber, businessPhone || null,
      timezone || 'America/Toronto', durationMins || 60, businessInfo || null);

    const days = workDays || [1, 2, 3, 4, 5];
    const open = openTime || '09:00';
    const close = closeTime || '17:00';

    days.forEach(day => {
      db.prepare(`
        INSERT INTO business_hours (id, business_id, day_of_week, open_time, close_time, is_open)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(uuidv4(), id, day, open, close);
    });

    res.status(201).json({ success: true, businessId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all businesses
router.get('/businesses', adminAuth, (req, res) => {
  const businesses = db.prepare('SELECT * FROM businesses').all();
  res.json(businesses);
});

// Get a single business
router.get('/businesses/:id', adminAuth, (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!business) return res.status(404).json({ error: 'Not found' });
  res.json(business);
});

// Update business
router.patch('/businesses/:id', adminAuth, (req, res) => {
  const {
    name, ownerPhone, businessPhone, timezone,
    durationMins, businessInfo, openTime, closeTime, workDays
  } = req.body;

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!business) return res.status(404).json({ error: 'Not found' });

  db.prepare(`
    UPDATE businesses SET
      name = COALESCE(?, name),
      owner_phone = COALESCE(?, owner_phone),
      business_phone = COALESCE(?, business_phone),
      timezone = COALESCE(?, timezone),
      appointment_duration_mins = COALESCE(?, appointment_duration_mins),
      business_info = COALESCE(?, business_info)
    WHERE id = ?
  `).run(name, ownerPhone, businessPhone, timezone, durationMins, businessInfo, req.params.id);

  if (openTime || closeTime || workDays) {
    db.prepare('DELETE FROM business_hours WHERE business_id = ?').run(req.params.id);
    const days = workDays || [1, 2, 3, 4, 5];
    const open = openTime || '09:00';
    const close = closeTime || '17:00';
    days.forEach(day => {
      db.prepare(`
        INSERT INTO business_hours (id, business_id, day_of_week, open_time, close_time, is_open)
        VALUES (?, ?, ?, ?, ?, 1)
      `).run(uuidv4(), req.params.id, day, open, close);
    });
  }

  res.json({ success: true });
});

// Delete a business
router.delete('/businesses/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM business_hours WHERE business_id = ?').run(req.params.id);
  db.prepare('DELETE FROM users WHERE business_id = ?').run(req.params.id);
  db.prepare('DELETE FROM businesses WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Create a user for a business
router.post('/businesses/:id/users', adminAuth, async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ error: 'username and password are required' });
  }

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!business) return res.status(404).json({ error: 'Business not found' });

  try {
    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(409).json({ error: 'Username already taken' });

    const passwordHash = await bcrypt.hash(password, 10);
    const id = uuidv4();

    db.prepare(`
      INSERT INTO users (id, business_id, username, password_hash, role)
      VALUES (?, ?, ?, ?, 'business')
    `).run(id, req.params.id, username, passwordHash);

    res.status(201).json({ success: true, userId: id, username });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users for a business
router.get('/businesses/:id/users', adminAuth, (req, res) => {
  const users = db.prepare(`
    SELECT id, username, role, created_at FROM users WHERE business_id = ?
  `).all(req.params.id);
  res.json(users);
});

// Delete a user
router.delete('/users/:id', adminAuth, (req, res) => {
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Get all leads for a business
router.get('/businesses/:id/leads', adminAuth, (req, res) => {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!business) return res.status(404).json({ error: 'Not found' });

  const leads = db.prepare(`
    SELECT * FROM leads WHERE call_id IN (
      SELECT id FROM calls WHERE to_number = ?
    ) ORDER BY created_at DESC
  `).all(business.twilio_number);
  res.json(leads);
});

// Get all appointments for a business
router.get('/businesses/:id/appointments', adminAuth, (req, res) => {
  const appointments = db.prepare(`
    SELECT a.*, l.name, l.phone FROM appointments a
    JOIN leads l ON a.lead_id = l.id
    WHERE a.business_id = ?
    ORDER BY a.start_time ASC
  `).all(req.params.id);
  res.json(appointments);
});

// Setup endpoint (kept for convenience)
router.post('/setup-business', (req, res) => {
  const { name, ownerPhone, twilioNumber, timezone, durationMins } = req.body;
  try {
    const id = uuidv4();
    db.prepare(`INSERT INTO businesses (id, name, owner_phone, timezone, appointment_duration_mins, twilio_number) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(id, name || 'My Business', ownerPhone, timezone || 'America/Toronto', durationMins || 60, twilioNumber);

    const days = [1, 2, 3, 4, 5];
    days.forEach(day => {
      db.prepare(`INSERT INTO business_hours (id, business_id, day_of_week, open_time, close_time, is_open) VALUES (?, ?, ?, ?, ?, 1)`)
        .run(uuidv4(), id, day, '09:00', '17:00');
    });

    res.json({ success: true, businessId: id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update business phone endpoint
router.post('/update-business-phone', (req, res) => {
  const { twilioNumber, businessPhone } = req.body;
  try {
    db.exec('ALTER TABLE businesses ADD COLUMN IF NOT EXISTS business_phone TEXT');
  } catch (e) {}
  db.prepare('UPDATE businesses SET business_phone = ? WHERE twilio_number = ?')
    .run(businessPhone, twilioNumber);
  res.json({ success: true });
});

module.exports = router;