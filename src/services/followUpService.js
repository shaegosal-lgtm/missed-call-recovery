const cron = require('node-cron');
const db = require('../db/db');
const { planAllows } = require('../config/plans');

function startFollowUpJob() {
  // Runs every hour
  cron.schedule('30 * * * *', () => {
    console.log('Running silent lead follow-up check...');

    const now = new Date();
    const cutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago

    // Find leads still sitting in 'new' status, created more than 2 hours ago,
    // meaning the customer never substantively replied to the initial text.
    // Join through calls -> businesses to get each lead's plan so we can gate.
    const staleLeads = db.prepare(`
      SELECT l.*, b.plan AS business_plan
      FROM leads l
      LEFT JOIN calls c ON l.call_id = c.id
      LEFT JOIN businesses b ON c.to_number = b.twilio_number
      WHERE l.status = 'new'
      AND l.created_at <= ?
    `).all(cutoff.toISOString().replace('T', ' ').substring(0, 19));

    console.log(`Found ${staleLeads.length} stale leads to check for follow-up`);

    for (const lead of staleLeads) {
      try {
        // FEATURE GATE: only flag for plans that include follow-up flagging (Basic/Pro).
        // If we couldn't resolve a plan (no matching business), default-deny to be safe.
        if (!lead.business_plan || !planAllows(lead.business_plan, 'followUpFlagging')) {
          continue;
        }

        db.prepare('UPDATE leads SET status = ? WHERE id = ?').run('needs_followup', lead.id);
        console.log(`Lead ${lead.id} (${lead.phone}) flagged for follow-up - no customer response after 2+ hours`);
      } catch (err) {
        console.error(`Failed to flag lead ${lead.id} for follow-up:`, err.message);
      }
    }
  });

  console.log('Silent lead follow-up job started');
}

module.exports = { startFollowUpJob };