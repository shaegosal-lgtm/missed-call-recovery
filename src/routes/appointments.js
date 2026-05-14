const express = require('express');
const router = express.Router();
const db = require('../db/db');
const {
  getAvailableSlots,
  getNextAvailableDays,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment
} = require('../services/schedulingService');

router.get('/slots', (req, res) => {
  const { businessId, date } = req.query;
  if (!businessId || !date) return res.status(400).json({ error: 'businessId and date required' });
  try {
    const slots = getAvailableSlots(businessId, date);
    res.json(slots);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/availability', (req, res) => {
  const { businessId, days } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  try {
    const result = getNextAvailableDays(businessId, parseInt(days) || 7);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get('/', (req, res) => {
  const { businessId } = req.query;
  if (!businessId) return res.status(400).json({ error: 'businessId required' });
  const appts = db.prepare(`
    SELECT a.*, l.name, l.phone, l.reason FROM appointments a
    JOIN leads l ON a.lead_id = l.id
    WHERE a.business_id = ?
    ORDER BY a.start_time ASC
  `).all(businessId);
  res.json(appts);
});

router.post('/', (req, res) => {
  const { businessId, leadId, startTime, serviceType, notes } = req.body;
  if (!businessId || !leadId || !startTime) {
    return res.status(400).json({ error: 'businessId, leadId, and startTime required' });
  }
  const result = bookAppointment(businessId, leadId, startTime, serviceType, notes);
  if (!result.success) return res.status(409).json({ error: result.error });
  res.status(201).json(result);
});

router.patch('/:id/reschedule', (req, res) => {
  const { newStartTime } = req.body;
  if (!newStartTime) return res.status(400).json({ error: 'newStartTime required' });
  const result = rescheduleAppointment(req.params.id, newStartTime);
  if (!result.success) return res.status(409).json({ error: result.error });
  res.json(result);
});

router.patch('/:id/cancel', (req, res) => {
  const result = cancelAppointment(req.params.id);
  res.json(result);
});

module.exports = router;