const cron = require('node-cron');
const db = require('../db/db');
const { sendSMS } = require('./twilioService');
const { planAllows } = require('../config/plans');

function startReminderJob() {
  // Runs every hour
  cron.schedule('0 * * * *', async () => {
    console.log('Running appointment reminder check...');

    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in23Hours = new Date(now.getTime() + 23 * 60 * 60 * 1000);

    // Find appointments in the next 23-24 hour window that haven't been reminded.
    // Pull the business plan too so we can skip reminders for plans that don't include them.
    const appointments = db.prepare(`
      SELECT a.*, l.name, l.phone, b.plan AS business_plan
      FROM appointments a
      JOIN leads l ON a.lead_id = l.id
      JOIN businesses b ON a.business_id = b.id
      WHERE a.status = 'scheduled'
      AND a.start_time >= ?
      AND a.start_time <= ?
      AND (a.reminder_sent IS NULL OR a.reminder_sent = 0)
    `).all(in23Hours.toISOString(), in24Hours.toISOString());

    console.log(`Found ${appointments.length} appointments to remind`);

    for (const appt of appointments) {
      try {
        // FEATURE GATE: only send reminders for plans that include them (Basic/Pro).
        if (!planAllows(appt.business_plan, 'reminders')) {
          // Mark as "sent" so we don't re-check this same appointment every hour.
          db.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(appt.id);
          console.log(`Reminder skipped for ${appt.id} (plan "${appt.business_plan}" has no reminders)`);
          continue;
        }

        const apptDate = new Date(appt.start_time);
        const timeLabel = apptDate.toLocaleTimeString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true
        });
        const dateLabel = apptDate.toLocaleDateString('en-US', {
          weekday: 'long',
          month: 'long',
          day: 'numeric'
        });

        await sendSMS(appt.phone,
          `Hi ${appt.name}! Just a reminder that you have an appointment tomorrow at ${timeLabel} on ${dateLabel}. ` +
          `Reply CANCEL if you need to cancel.`
        );

        // Mark reminder as sent
        db.prepare('UPDATE appointments SET reminder_sent = 1 WHERE id = ?').run(appt.id);
        console.log(`Reminder sent to ${appt.phone} for appointment ${appt.id}`);
      } catch (err) {
        console.error(`Failed to send reminder for ${appt.id}:`, err.message);
      }
    }
  });

  console.log('Appointment reminder job started');
}

module.exports = { startReminderJob };