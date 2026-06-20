const { sendSMS } = require('./twilioService');

async function notifyOwner(lead) {
  try {
    const ownerPhone = process.env.OWNER_PHONE_NUMBER;
    if (!ownerPhone) {
      console.error('[notifyOwner] No OWNER_PHONE_NUMBER set, skipping notification.');
      return;
    }

    const urgencyEmoji = { high: '[URGENT]', medium: '[NEW LEAD]', low: '[INFO]' };
    const prefix = urgencyEmoji[lead.urgency] || '[NEW LEAD]';

    const message = `${prefix} Missed call from ${lead.phone}
Name: ${lead.name || 'Unknown'}
Type: ${lead.lead_type}
Reason: ${lead.reason || 'Not provided'}
Note: ${lead.ai_summary}`;

    await sendSMS(ownerPhone, message);
  } catch (err) {
    console.error('[notifyOwner] Failed to notify owner, but continuing normally:', err.message || err);
    // Never let a notification failure break the customer-facing conversation
  }
}

module.exports = { notifyOwner };