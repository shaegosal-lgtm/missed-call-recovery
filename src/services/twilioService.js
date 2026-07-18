const twilio = require('twilio');

function getClient() {
  return twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );
}

async function sendSMS(to, body) {
  const client = getClient();

  try {
    const message = await client.messages.create({
      body,
      from: process.env.TWILIO_PHONE_NUMBER,
      to,
    });
    console.log(`SMS sent to ${to}: ${message.sid}`);
    return message;
  } catch (err) {
    console.error('Failed to send SMS:', err.message);
    throw err;
  }
}

// Look up the line type of a phone number via Twilio Lookup.
// Returns one of: 'landline', 'mobile', 'voip', or 'unknown'.
// Never throws — on any error it returns 'unknown' so callers can treat
// uncertain results as "text anyway" (the safe default for real customers).
async function lookupLineType(phoneNumber) {
  try {
    const client = getClient();
    // Lookup v2 with line_type_intelligence returns the carrier line type.
    const result = await client.lookups.v2
      .phoneNumbers(phoneNumber)
      .fetch({ fields: 'line_type_intelligence' });

    const lti = result && result.lineTypeIntelligence;
    const type = lti && lti.type ? String(lti.type).toLowerCase() : null;

    if (type === 'landline') return 'landline';
    if (type === 'mobile') return 'mobile';
    if (type === 'voip' || type === 'nonFixedVoip' || type === 'fixedVoip') return 'voip';
    if (type === 'nonfixedvoip' || type === 'fixedvoip') return 'voip';
    return 'unknown';
  } catch (err) {
    console.error(`[lookupLineType] Failed for ${phoneNumber}, treating as unknown:`, err.message || err);
    return 'unknown';
  }
}

module.exports = { sendSMS, lookupLineType };