const db = require('../db/db');
const { v4: uuidv4 } = require('uuid');

function createLead(phone, callId) {
  const id = uuidv4();
  db.prepare(`
    INSERT INTO leads (id, call_id, phone) VALUES (?, ?, ?)
  `).run(id, callId, phone);
  return id;
}

// Only returns LIVE leads (not in the trash).
function getLeadByPhone(phone) {
  return db.prepare(`
    SELECT * FROM leads
    WHERE phone = ? AND status != 'closed' AND deleted_at IS NULL
    ORDER BY created_at DESC LIMIT 1
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

// Live leads only — this is what the main dashboard shows.
function getAllLeads() {
  return db.prepare(`
    SELECT * FROM leads WHERE deleted_at IS NULL ORDER BY created_at DESC
  `).all();
}

// Trashed leads only — this is what the "Deleted" section shows.
function getDeletedLeads() {
  return db.prepare(`
    SELECT * FROM leads WHERE deleted_at IS NOT NULL ORDER BY deleted_at DESC
  `).all();
}

// Checks whether a lead has an appointment that is scheduled AND in the future.
// Such a lead may NOT be deleted (per the chosen safety rule).
function leadHasActiveUpcomingAppointment(leadId) {
  const nowIso = new Date().toISOString();
  const row = db.prepare(`
    SELECT 1 FROM appointments
    WHERE lead_id = ? AND status = 'scheduled' AND start_time > ?
    LIMIT 1
  `).get(leadId, nowIso);
  return !!row;
}

// Move a lead to the trash (soft delete). Returns a result object so the
// route can tell the user WHY it failed if it's blocked.
function deleteLead(id) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) {
    return { success: false, reason: 'not_found' };
  }
  if (lead.deleted_at) {
    return { success: false, reason: 'already_deleted' };
  }
  if (leadHasActiveUpcomingAppointment(id)) {
    return { success: false, reason: 'has_active_appointment' };
  }
  db.prepare('UPDATE leads SET deleted_at = ? WHERE id = ?')
    .run(new Date().toISOString(), id);
  return { success: true };
}

// Bring a lead back out of the trash.
function recoverLead(id) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) {
    return { success: false, reason: 'not_found' };
  }
  if (!lead.deleted_at) {
    return { success: false, reason: 'not_deleted' };
  }
  db.prepare('UPDATE leads SET deleted_at = NULL WHERE id = ?').run(id);
  return { success: true };
}

// Permanently erase a SINGLE lead that is already in the trash, plus its
// appointments. Only works on already-trashed leads (a safety guard so a
// live lead can never be hard-deleted by accident).
function permanentlyDeleteLead(id) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  if (!lead) {
    return { success: false, reason: 'not_found' };
  }
  if (!lead.deleted_at) {
    return { success: false, reason: 'not_in_trash' };
  }
  const run = db.transaction(() => {
    db.prepare('DELETE FROM appointments WHERE lead_id = ?').run(id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  });
  run();
  return { success: true };
}

// Permanently erase any lead that has been in the trash longer than 30 days.
// Also erases that lead's appointments (only old/cancelled ones can exist here,
// since active upcoming appointments block deletion in the first place).
function purgeOldDeletedLeads() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const expired = db.prepare(`
    SELECT id FROM leads WHERE deleted_at IS NOT NULL AND deleted_at < ?
  `).all(cutoff);

  if (expired.length === 0) return 0;

  const deleteAppts = db.prepare('DELETE FROM appointments WHERE lead_id = ?');
  const deleteLeadRow = db.prepare('DELETE FROM leads WHERE id = ?');

  const runPurge = db.transaction((rows) => {
    for (const row of rows) {
      deleteAppts.run(row.id);
      deleteLeadRow.run(row.id);
    }
  });

  runPurge(expired);
  console.log(`[purge] Permanently erased ${expired.length} lead(s) deleted more than 30 days ago.`);
  return expired.length;
}

module.exports = {
  createLead,
  getLeadByPhone,
  updateLead,
  appendToConversation,
  getAllLeads,
  getDeletedLeads,
  leadHasActiveUpcomingAppointment,
  deleteLead,
  recoverLead,
  permanentlyDeleteLead,
  purgeOldDeletedLeads,
};