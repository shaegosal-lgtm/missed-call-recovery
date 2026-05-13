const twilio = require('twilio');

async function sendSMS(to, body) {
  const client = twilio(
    process.env.TWILIO_ACCOUNT_SID,
    process.env.TWILIO_AUTH_TOKEN
  );

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

module.exports = { sendSMS };