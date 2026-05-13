const express = require('express');
const router = express.Router();
const { getAllLeads } = require('../services/leadService');
const db = require('../db/db');

router.get('/', (req, res) => {
  const leads = getAllLeads();
  res.json(leads);
});

router.get('/:id', (req, res) => {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(req.params.id);
  if (!lead) return res.status(404).json({ error: 'Lead not found' });
  res.json(lead);
});

router.patch('/:id', (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

module.exports = router;