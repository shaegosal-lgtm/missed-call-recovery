const cron = require('node-cron');
const db = require('../db/db');

function startFollowUpJob() {
  // Runs every hour
  cron.schedule('30 * * * *', () => {
    console.log('Running silent lead follow-up check...');

    const now = new Date();
    const cutoff = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago

    // Find leads still sitting in 'new' status, created more than 2 hours ago,
    // meaning the customer never substantively replied to the initial text
    // (covers landlines that can't receive texts, and customers who simply went silent)
    const staleLeads = db.prepare(`
      SELECT * FROM leads
      WHERE status = 'new'
      AND created_at <= ?
    `).all(cutoff.toISOString().replace('T', ' ').substring(0, 19));

    console.log(`Found ${staleLeads.length} stale leads to flag for follow-up`);

    for (const lead of staleLeads) {
      try {
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