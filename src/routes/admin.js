const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');

// Simple API key check for admin routes
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
    name,
    ownerPhone,
    twilioNumber,
    businessPhone,
    timezone,
    durationMins,
    businessInfo,
    openTime,
    closeTime,
    workDays
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
    `).run(
      id,
      name,
      ownerPhone,
      twilioNumber,
      businessPhone || null,
      timezone || 'America/Toronto',
      durationMins || 60,
      businessInfo || null
    );

    // Set up business hours
    const days = workDays || [1, 2, 3, 4, 5]; // Mon-Fri by default
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

// Update business info
router.patch('/businesses/:id', adminAuth, (req, res) => {
  const {
    name,
    ownerPhone,
    businessPhone,
    timezone,
    durationMins,
    businessInfo,
    openTime,
    closeTime,
    workDays
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
  db.prepare('DELETE FROM businesses WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Get all leads for a business
router.get('/businesses/:id/leads', adminAuth, (req, res) => {
  const leads = db.prepare(`
    SELECT * FROM leads 
    WHERE call_id IN (
      SELECT id FROM calls WHERE to_number = (
        SELECT twilio_number FROM businesses WHERE id = ?
      )
    )
    ORDER BY created_at DESC
  `).all(req.params.id);
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

module.exports = router;