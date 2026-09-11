const db = require('../db/db');
const { v4: uuidv4 } = require('uuid');
const googleCalendar = require('./googleCalendarService');

console.log('[SCHED VERSION] Timezone-aware scheduling service loaded v4');

// Convert a wall-clock time (hour:minute) on a given date, in a given IANA
// timezone, to the correct UTC Date. Handles daylight saving automatically.
function zonedTimeToUtc(dateStr, hour, minute, timeZone) {
  const guess = new Date(`${dateStr}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  });
  const parts = dtf.formatToParts(guess);
  const map = {};
  for (const p of parts) map[p.type] = p.value;
  let asLocalHour = parseInt(map.hour);
  if (asLocalHour === 24) asLocalHour = 0;
  const asLocalMinute = parseInt(map.minute);
  const desiredMins = hour * 60 + minute;
  const gotMins = asLocalHour * 60 + asLocalMinute;
  let diff = desiredMins - gotMins;
  if (diff > 720) diff -= 1440;
  if (diff < -720) diff += 1440;
  return new Date(guess.getTime() + diff * 60000);
}

// Format a UTC Date as a time label (e.g. "9:00 AM") in the business's timezone.
function formatTimeInZone(date, timeZone) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

// Which weekday (0-6, Sun-Sat) is this date in the business's timezone?
function weekdayInZone(dateStr, timeZone) {
  const noon = new Date(`${dateStr}T12:00:00Z`);
  const wd = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(noon);
  const map = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[wd];
}

function getLocalHour(date, timezone) {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(formatter.format(date));
  } catch {
    return date.getHours();
  }
}

async function getAvailableSlots(businessId, date) {
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(businessId);
  if (!business) throw new Error('Business not found');

  const duration = business.appointment_duration_mins;
  const timezone = business.timezone || 'America/Toronto';

  const dayOfWeek = weekdayInZone(date, timezone);

  const hours = db.prepare(`
    SELECT * FROM business_hours 
    WHERE business_id = ? AND day_of_week = ? AND is_open = 1
  `).get(businessId, dayOfWeek);

  if (!hours) return [];

  const slots = [];
  const [openH, openM] = hours.open_time.split(':').map(Number);
  const [closeH, closeM] = hours.close_time.split(':').map(Number);

  const openMinutes = openH * 60 + openM;
  const closeMinutes = closeH * 60 + closeM;

  let currentMinutes = openMinutes;

  while (currentMinutes + duration <= closeMinutes) {
    const slotHour = Math.floor(currentMinutes / 60);
    const slotMin = currentMinutes % 60;

    // KEY FIX: correct UTC instant for this wall-clock time in the business tz.
    const startDate = zonedTimeToUtc(date, slotHour, slotMin, timezone);
    const endDate = new Date(startDate.getTime() + duration * 60000);

    const label = formatTimeInZone(startDate, timezone);

    slots.push({
      start: startDate,
      end: endDate,
      label,
      slotHour,
    });

    currentMinutes += duration;
  }

  const now = new Date();

  const dayBefore = new Date(new Date(date + 'T00:00:00Z').getTime() - 86400000).toISOString().split('T')[0];
  const dayAfter = new Date(new Date(date + 'T00:00:00Z').getTime() + 86400000).toISOString().split('T')[0];

  const bookedSlots = db.prepare(`
    SELECT start_time, end_time FROM appointments
    WHERE business_id = ? 
    AND date(start_time) BETWEEN ? AND ?
    AND status != 'cancelled'
  `).all(businessId, dayBefore, dayAfter);

  const blockedSlots = db.prepare(`
    SELECT start_time, end_time FROM blocked_times
    WHERE business_id = ?
    AND date(start_time) BETWEEN ? AND ?
  `).all(businessId, dayBefore, dayAfter);

  let googleBusy = [];
  console.log(`[getAvailableSlots DEBUG] business=${businessId} tz=${timezone} connected=${business.google_calendar_connected} hasRefresh=${!!business.google_refresh_token} date=${date} dow=${dayOfWeek}`);
  try {
    if (business.google_calendar_connected) {
      const dayStart = new Date(date + 'T00:00:00Z');
      dayStart.setTime(dayStart.getTime() - 86400000);
      const dayEnd = new Date(date + 'T23:59:59Z');
      dayEnd.setTime(dayEnd.getTime() + 86400000);
      const busy = await googleCalendar.getBusyTimes(business, dayStart, dayEnd);
      googleBusy = busy.map(b => ({ start_time: b.start.toISOString(), end_time: b.end.toISOString() }));
      console.log(`[getAvailableSlots DEBUG] google returned ${googleBusy.length} busy blocks`);
    }
  } catch (err) {
    console.error('[getAvailableSlots] Google busy-times lookup failed, ignoring:', err.message || err);
  }

  const unavailable = [...bookedSlots, ...blockedSlots, ...googleBusy];

  return slots.filter(slot => {
    if (slot.start <= now) return false;
    return !unavailable.some(u => {
      const uStart = new Date(u.start_time);
      const uEnd = new Date(u.end_time);
      return slot.start < uEnd && slot.end > uStart;
    });
  });
}

async function getNextAvailableDays(businessId, daysAhead = 7) {
  const results = [];
  const today = new Date();

  for (let i = 0; i <= daysAhead; i++) {
    const date = new Date(today);
    date.setDate(today.getDate() + i);
    const dateStr = date.toISOString().split('T')[0];
    const slots = await getAvailableSlots(businessId, dateStr);
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

function formatHour(hour, minute) {
  const period = hour >= 12 ? 'PM' : 'AM';
  const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
  const displayMin = minute === 0 ? '00' : minute.toString().padStart(2, '0');
  return `${displayHour}:${displayMin} ${period}`;
}

function formatTime(date) {
  return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
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
  zonedTimeToUtc,
  formatTimeInZone,
};