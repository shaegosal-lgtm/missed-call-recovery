const db = require('../db/db');
const { v4: uuidv4 } = require('uuid');

// Manual appointments live in the SAME appointments table as AI bookings, so the
// existing getAvailableSlots / bookAppointment conflict checks automatically treat
// them as taken slots and block the AI from double-booking. Manual ones have a
// NULL lead_id and store their own title/customer fields (added via migration).

function generateConfirmationCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// Detect once whether the manual columns exist (added by db.js migration).
const apptColumns = (() => {
  try {
    return new Set(db.prepare(`PRAGMA table_info(appointments)`).all().map(c => c.name));
  } catch {
    return new Set();
  }
})();
const HAS_MANUAL_FIELDS = apptColumns.has('manual_title');

// Create a manual appointment. Blocks if the slot conflicts with any existing
// non-cancelled appointment (AI or manual), matching bookAppointment's rule.
function createManualAppointment(businessId, data) {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) return { success: false, error: 'business_not_found' };

  const startTime = data.startTime; // ISO string
  const duration = parseInt(data.durationMins) || business.appointment_duration_mins || 60;
  const endTime = new Date(new Date(startTime).getTime() + duration * 60000).toISOString();

  // Conflict check — same logic the AI booking uses.
  const conflict = db.prepare(`
    SELECT id FROM appointments
    WHERE business_id = ?
    AND status != 'cancelled'
    AND start_time < ?
    AND end_time > ?
  `).get(businessId, endTime, startTime);

  if (conflict) return { success: false, error: 'slot_taken' };

  const id = uuidv4();
  const confirmationCode = generateConfirmationCode();

  if (HAS_MANUAL_FIELDS) {
    db.prepare(`
      INSERT INTO appointments
      (id, lead_id, business_id, start_time, end_time, status, notes, confirmation_code,
       manual_title, manual_customer_name, manual_customer_phone, manual_address, is_manual)
      VALUES (?, NULL, ?, ?, ?, 'scheduled', ?, ?, ?, ?, ?, ?, 1)
    `).run(
      id, businessId, startTime, endTime,
      data.notes || null, confirmationCode,
      data.title || null, data.customerName || null,
      data.customerPhone || null, data.address || null
    );
  } else {
    // Fallback if migration hasn't run: store what we can.
    db.prepare(`
      INSERT INTO appointments
      (id, lead_id, business_id, start_time, end_time, status, notes, confirmation_code)
      VALUES (?, NULL, ?, ?, ?, 'scheduled', ?, ?)
    `).run(id, businessId, startTime, endTime, data.notes || data.title || null, confirmationCode);
  }

  return { success: true, appointmentId: id };
}

// Edit a manual appointment. Re-checks conflict (excluding itself).
function editManualAppointment(appointmentId, businessId, data) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND business_id = ?')
    .get(appointmentId, businessId);
  if (!appt) return { success: false, error: 'not_found' };

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  const startTime = data.startTime;
  const duration = parseInt(data.durationMins) || business.appointment_duration_mins || 60;
  const endTime = new Date(new Date(startTime).getTime() + duration * 60000).toISOString();

  const conflict = db.prepare(`
    SELECT id FROM appointments
    WHERE business_id = ?
    AND id != ?
    AND status != 'cancelled'
    AND start_time < ?
    AND end_time > ?
  `).get(businessId, appointmentId, endTime, startTime);

  if (conflict) return { success: false, error: 'slot_taken' };

  if (HAS_MANUAL_FIELDS) {
    db.prepare(`
      UPDATE appointments SET
        start_time = ?, end_time = ?, notes = ?,
        manual_title = ?, manual_customer_name = ?, manual_customer_phone = ?, manual_address = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      startTime, endTime, data.notes || null,
      data.title || null, data.customerName || null,
      data.customerPhone || null, data.address || null,
      appointmentId
    );
  } else {
    db.prepare(`
      UPDATE appointments SET start_time = ?, end_time = ?, notes = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(startTime, endTime, data.notes || data.title || null, appointmentId);
  }

  return { success: true };
}

// Delete a manual appointment outright (they have no lead, so it's a hard delete).
// Safety: only deletes if it's actually a manual appointment (lead_id IS NULL).
function deleteManualAppointment(appointmentId, businessId) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ? AND business_id = ?')
    .get(appointmentId, businessId);
  if (!appt) return { success: false, error: 'not_found' };
  if (appt.lead_id) return { success: false, error: 'not_manual' };

  db.prepare('DELETE FROM appointments WHERE id = ?').run(appointmentId);
  return { success: true };
}

// Get every non-cancelled appointment for a business in a given month (for the grid).
// Returns both AI and manual appointments so the calendar shows everything.
function getAppointmentsForMonth(businessId, year, month) {
  // month is 1-12. Build a YYYY-MM prefix for a simple date match.
  const mm = String(month).padStart(2, '0');
  const prefix = `${year}-${mm}`;

  const rows = db.prepare(`
    SELECT a.*, l.name AS lead_name, l.phone AS lead_phone
    FROM appointments a
    LEFT JOIN leads l ON a.lead_id = l.id
    WHERE a.business_id = ?
    AND a.status != 'cancelled'
    AND substr(a.start_time, 1, 7) = ?
    ORDER BY a.start_time ASC
  `).all(businessId, prefix);

  return rows;
}

function getAppointmentById(appointmentId, businessId) {
  return db.prepare('SELECT * FROM appointments WHERE id = ? AND business_id = ?')
    .get(appointmentId, businessId);
}

module.exports = {
  createManualAppointment,
  editManualAppointment,
  deleteManualAppointment,
  getAppointmentsForMonth,
  getAppointmentById,
};