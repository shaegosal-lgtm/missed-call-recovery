const cron = require('node-cron');
const db = require('../db/db');
const { sendSMS } = require('./twilioService');

function startReminderJob() {
  // Runs every hour
  cron.schedule('0 * * * *', async () => {
    console.log('Running appointment reminder check...');

    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const in23Hours = new Date(now.getTime() + 23 * 60 * 60 * 1000);

    // Find appointments in the next 23-24 hour window that haven't been reminded
    const appointments = db.prepare(`
      SELECT a.*, l.name, l.phone FROM appointments a
      JOIN leads l ON a.lead_id = l.id
      WHERE a.status = 'scheduled'
      AND a.start_time >= ?
      AND a.start_time <= ?
      AND (a.reminder_sent IS NULL OR a.reminder_sent = 0)
    `).all(in23Hours.toISOString(), in24Hours.toISOString());

    console.log(`Found ${appointments.length} appointments to remind`);

    for (const appt of appointments) {
      try {
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