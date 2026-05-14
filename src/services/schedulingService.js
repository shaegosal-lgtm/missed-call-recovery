const db = require('../db/db');
const { v4: uuidv4 } = require('uuid');

function getAvailableSlots(businessId, date) {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) throw new Error('Business not found');

  const duration = business.appointment_duration_mins;
  const d = new Date(date);
  const dayOfWeek = d.getDay();

  const hours = db.prepare(`
    SELECT * FROM business_hours 
    WHERE business_id = ? AND day_of_week = ? AND is_open = 1
  `).get(businessId, dayOfWeek);

  if (!hours) return [];

  const slots = [];
  const [openH, openM] = hours.open_time.split(':').map(Number);
  const [closeH, closeM] = hours.close_time.split(':').map(Number);

  let current = new Date(date);
  current.setHours(openH, openM, 0, 0);
  const closing = new Date(date);
  closing.setHours(closeH, closeM, 0, 0);

  while (current < closing) {
    const slotEnd = new Date(current.getTime() + duration * 60000);
    if (slotEnd <= closing) {
      slots.push({
        start: new Date(current),
        end: new Date(slotEnd),
        label: formatTime(current),
      });
    }
    current = new Date(current.getTime() + duration * 60000);
  }

  const bookedSlots = db.prepare(`
    SELECT start_time, end_time FROM appointments
    WHERE business_id = ? 
    AND date(start_time) = date(?)
    AND status != 'cancelled'
  `).all(businessId, date);

  const blockedSlots = db.prepare(`
    SELECT start_time, end_time FROM blocked_times
    WHERE business_id = ?
    AND date(start_time) = date(?)
  `).all(businessId, date);

  const unavailable = [...bookedSlots, ...blockedSlots];

  return slots.filter(slot => {
    return !unavailable.some(u => {
      const uStart = new Date(u.start_time);
      const uEnd = new Date(u.end_time);
      return slot.start < uEnd && slot.end > uStart;
    });
  });
}

function getNextAvailableDays(businessId, daysAhead = 7) {
  const results = [];
  const today = new Date();

  for (let i = 1; i <= daysAhead; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const slots = getAvailableSlots(businessId, dateStr);
    if (slots.length > 0) {
      results.push({ date: dateStr, slots });
    }
  }

  return results;
}

function bookAppointment(businessId, leadId, startTime, serviceType = null, notes = null) {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  const duration = business.appointment_duration_mins;
  const endTime = new Date(new Date(startTime).getTime() + duration * 60000);

  const conflict = db.prepare(`
    SELECT id FROM appointments
    WHERE business_id = ?
    AND status != 'cancelled'
    AND start_time < ?
    AND end_time > ?
  `).get(businessId, endTime.toISOString(), startTime);

  if (conflict) {
    return { success: false, error: 'slot_taken' };
  }

  const id = uuidv4();
  const confirmationCode = generateConfirmationCode();

  db.prepare(`
    INSERT INTO appointments 
    (id, lead_id, business_id, start_time, end_time, status, service_type, notes, confirmation_code)
    VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?, ?)
  `).run(id, leadId, businessId, startTime, endTime.toISOString(), serviceType, notes, confirmationCode);

  db.prepare('UPDATE leads SET status = ? WHERE id = ?').run('scheduled', leadId);

  return { success: true, appointmentId: id, confirmationCode, endTime };
}

function rescheduleAppointment(appointmentId, newStartTime) {
  const appt = db.prepare('SELECT * FROM appointments WHERE id = ?').get(appointmentId);
  if (!appt) return { success: false, error: 'not_found' };

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(appt.business_id);
  const duration = business.appointment_duration_mins;
  const newEndTime = new Date(new Date(newStartTime).getTime() + duration * 60000);

  const conflict = db.prepare(`
    SELECT id FROM appointments
    WHERE business_id = ?
    AND id != ?
    AND status != 'cancelled'
    AND start_time < ?
    AND end_time > ?
  `).get(appt.business_id, appointmentId, newEndTime.toISOString(), newStartTime);

  if (conflict) return { success: false, error: 'slot_taken' };

  db.prepare(`
    UPDATE appointments 
    SET start_time = ?, end_time = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(newStartTime, newEndTime.toISOString(), appointmentId);

  return { success: true };
}

function cancelAppointment(appointmentId) {
  db.prepare(`
    UPDATE appointments SET status = 'cancelled', updated_at = CURRENT_TIMESTAMP WHERE id = ?
  `).run(appointmentId);

  const appt = db.prepare('SELECT lead_id FROM appointments WHERE id = ?').get(appointmentId);
  if (appt) {
    db.prepare('UPDATE leads SET status = ? WHERE id = ?').run('new', appt.lead_id);
  }

  return { success: true };
}

function getAppointmentByPhone(phone) {
  return db.prepare(`
    SELECT a.* FROM appointments a
    JOIN leads l ON a.lead_id = l.id
    WHERE l.phone = ? AND a.status = 'scheduled'
    ORDER BY a.created_at DESC LIMIT 1
  `).get(phone);
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00');
  return d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

function generateConfirmationCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

module.exports = {
  getAvailableSlots,
  getNextAvailableDays,
  bookAppointment,
  rescheduleAppointment,
  cancelAppointment,
  getAppointmentByPhone,
  formatTime,
  formatDate,
};