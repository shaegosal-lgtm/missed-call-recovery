const { sendSMS } = require('./twilioService');

async function notifyOwner(lead) {
  const urgencyEmoji = { high: '[URGENT]', medium: '[NEW LEAD]', low: '[INFO]' };
  const prefix = urgencyEmoji[lead.urgency] || '[NEW LEAD]';
  
  const message = `${prefix} Missed call from ${lead.phone}
Name: ${lead.name || 'Unknown'}
Type: ${lead.lead_type}
Reason: ${lead.reason || 'Not provided'}
Note: ${lead.ai_summary}`;

  await sendSMS(process.env.OWNER_PHONE_NUMBER, message);
}

module.exports = { notifyOwner };