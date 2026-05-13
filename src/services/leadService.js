const db = require('../db/db');
const { v4: uuidv4 } = require('uuid');

function createLead(phone, callId) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO leads (id, call_id, phone) VALUES (?, ?, ?)
  `).run(id, callId, phone);
  return id;
}

function getLeadByPhone(phone) {
  return db.prepare(`
    SELECT * FROM leads WHERE phone = ? AND status = 'new' ORDER BY created_at DESC LIMIT 1
  `).get(phone);
}

function updateLead(id, fields) {
  const keys = Object.keys(fields);
  const setClause = keys.map(k => `${k} = ?`).join(', ');
  db.prepare(`UPDATE leads SET ${setClause} WHERE id = ?`)
    .run(...Object.values(fields), id);
}

function appendToConversation(id, role, body) {
  const lead = db.prepare('SELECT conversation FROM leads WHERE id = ?').get(id);
  const convo = JSON.parse(lead.conversation || '[]');
  convo.push({ role, body, ts: new Date().toISOString() });
  db.prepare('UPDATE leads SET conversation = ? WHERE id = ?')
    .run(JSON.stringify(convo), id);
}

function getAllLeads() {
  return db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
}

module.exports = { createLead, getLeadByPhone, updateLead, appendToConversation, getAllLeads };