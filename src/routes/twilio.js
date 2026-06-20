const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendSMS } = require('../services/twilioService');
const { classifyLead, runReceptionistConversation } = require('../services/claudeService');
const { createLead, getLeadByPhone, updateLead, appendToConversation } = require('../services/leadService');
const { notifyOwner } = require('../services/notifyService');
const { sendLeadNotification } = require('../services/emailService');
const twilioAuth = require('../middleware/twilioAuth');

async function sendAndLog(leadId, to, message) {
  try {
    await sendSMS(to, message);
  } catch (err) {
    console.error('[sendAndLog] Failed to send SMS, but continuing:', err.message || err);
  }
  if (leadId) appendToConversation(leadId, 'assistant', message);
}

async function safeNotifyOwner(leadData) {
  try {
    await notifyOwner(leadData);
  } catch (err) {
    console.error('[safeNotifyOwner] Failed, but continuing:', err.message || err);
  }
}

async function safeSendLeadNotification(business, leadData, appointmentDetails) {
  try {
    await sendLeadNotification(business, leadData, appointmentDetails);
  } catch (err) {
    console.error('[safeSendLeadNotification] Failed, but continuing:', err.message || err);
  }
}

router.post('/missed-call', twilioAuth, async (req, res) => {
  const { From, To, CallSid, CallStatus } = req.body;
  console.log(`Call event - From: ${From}, Status: ${CallStatus}, SID: ${CallSid}`);

  const business = db.prepare('SELECT * FROM businesses WHERE twilio_number = ?').get(To);

  if (!CallStatus || CallStatus === 'ringing' || CallStatus === 'in-progress') {
    if (business && business.business_phone) {
      return res.status(200).type('text/xml').send(`
        <Response>
          <Dial timeout="20" action="/webhooks/twilio/missed-call-fallback" method="POST">
            <Number>${business.business_phone}</Number>
          </Dial>
        </Response>
      `);
    }
    return res.status(200).type('text/xml').send(`
      <Response>
        <Say>Thank you for calling. We are unable to take your call right now. Please stay on the line and we will follow up with you shortly.</Say>
        <Pause length="20"/>
        <Hangup/>
      </Response>
    `);
  }

  if (CallStatus === 'no-answer' || CallStatus === 'busy' || CallStatus === 'failed' || CallStatus === 'completed') {
    try {
      const callId = uuidv4();
      db.prepare(`INSERT INTO calls (id, from_number, to_number, call_sid, status) VALUES (?,?,?,?,?)`)
        .run(callId, From, To, CallSid, 'missed');

      const leadId = createLead(From, callId);
      const bizName = business ? business.name : 'us';
      const firstMessage = `Hi! You just called ${bizName} and we missed you. We are sorry about that! How can we help you today?`;

      try {
        await sendSMS(From, firstMessage);
      } catch (smsErr) {
        console.error('[missed-call] Failed to send initial SMS:', smsErr.message || smsErr);
      }
      appendToConversation(leadId, 'assistant', firstMessage);
      console.log(`SMS sent to ${From}`);
    } catch (err) {
      console.log(`Duplicate or error: ${err.message}`);
    }
  }

  res.status(200).type('text/xml').send('<Response></Response>');
});

router.post('/missed-call-fallback', twilioAuth, async (req, res) => {
  const { From, To, CallSid, DialCallStatus } = req.body;
  console.log(`Forwarded call fallback - From: ${From}, DialStatus: ${DialCallStatus}`);

  if (DialCallStatus === 'no-answer' || DialCallStatus === 'busy' || DialCallStatus === 'failed') {
    try {
      const business = db.prepare('SELECT * FROM businesses WHERE twilio_number = ?').get(To);
      const callId = uuidv4();
      db.prepare(`INSERT INTO calls (id, from_number, to_number, call_sid, status) VALUES (?,?,?,?,?)`)
        .run(callId, From, To, CallSid, 'missed');

      const leadId = createLead(From, callId);
      const bizName = business ? business.name : 'us';
      const firstMessage = `Hi! You just called ${bizName} and we missed you. We are sorry about that! How can we help you today?`;

      try {
        await sendSMS(From, firstMessage);
      } catch (smsErr) {
        console.error('[missed-call-fallback] Failed to send initial SMS:', smsErr.message || smsErr);
      }
      appendToConversation(leadId, 'assistant', firstMessage);
      console.log(`SMS sent to ${From} after forwarding failed`);
    } catch (err) {
      console.log(`Duplicate or error: ${err.message}`);
    }
  }

  res.status(200).type('text/xml').send('<Response></Response>');
});

router.post('/sms-reply', twilioAuth, async (req, res) => {
  const { From, Body } = req.body;
  const text = Body.trim();

  const lead = getLeadByPhone(From);
  if (!lead) {
    try {
      await sendSMS(From, `Thanks for reaching out! Please call us and we will be happy to help.`);
    } catch (err) {
      console.error('[sms-reply] Failed to send no-lead SMS:', err.message || err);
    }
    return res.status(200).send('<Response></Response>');
  }

  const business = db.prepare('SELECT * FROM businesses WHERE twilio_number = ?').get(process.env.TWILIO_PHONE_NUMBER);
  const convo = JSON.parse(lead.conversation || '[]');

  appendToConversation(lead.id, 'customer', text);

  // Save first message as reason if not set yet - this is the customer's FIRST response, moving them off "new"
  if (!lead.reason && text.length > 2) {
    updateLead(lead.id, { reason: text });
    lead.reason = text;
  }

  if (!business) {
    await sendAndLog(lead.id, From, `Thanks for reaching out! A team member will get back to you shortly.`);
    updateLead(lead.id, { status: 'needs_followup' });
    return res.status(200).send('<Response></Response>');
  }

  let reply;
  try {
    reply = await runReceptionistConversation(business, lead, convo, text, From);
    await sendAndLog(lead.id, From, reply);

    // Re-classify urgency using the FULL conversation now that it includes this turn's reply
    const updatedConvo = JSON.parse(getLeadByPhone(From)?.conversation || '[]');
    classifyLead(From, updatedConvo)
      .then(async result => {
        updateLead(lead.id, {
          urgency: result.urgency,
          lead_type: result.lead_type,
          ai_summary: result.summary,
        });
        await safeNotifyOwner({ ...lead, ...result });
        await safeSendLeadNotification(business, { ...lead, ...result });
      })
      .catch(err => console.error('[sms-reply] Classification failed:', err.message || err));

    // If a booking just completed, send a dedicated owner notification with appointment details
    if (reply.toLowerCase().includes('confirmation code')) {
      const codeMatch = reply.match(/confirmation code:?\s*(?:is)?\s*([a-z0-9]+)/i);
      const code = codeMatch ? codeMatch[1] : null;
      if (code) {
        await safeNotifyOwner({ ...lead, ai_summary: `Appointment booked. Code: ${code}` });
        await safeSendLeadNotification(business, { ...lead, ai_summary: `Appointment booked. Code: ${code}` }, code);
      }
    }
  } catch (err) {
    console.error('[sms-reply] Receptionist conversation failed:', err.message || err);
    await sendAndLog(lead.id, From, `Sorry, something went wrong on our end. A team member will reach out to help you shortly.`);
    updateLead(lead.id, { status: 'needs_followup' });
  }

  res.status(200).send('<Response></Response>');
});

module.exports = router;