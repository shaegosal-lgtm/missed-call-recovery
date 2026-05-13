const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendSMS } = require('../services/twilioService');
const { classifyLead } = require('../services/claudeService');
const { createLead, getLeadByPhone, updateLead, appendToConversation } = require('../services/leadService');
const { notifyOwner } = require('../services/notifyService');
const twilioAuth = require('../middleware/twilioAuth');

router.post('/missed-call', twilioAuth, async (req, res) => {
  const { From, To, CallSid } = req.body;
  console.log(`Incoming call from ${From}, CallSid: ${CallSid}`);

  // Respond with TwiML — ring for 20 seconds with no answer, then go to /no-answer
  res.status(200).type('text/xml').send(`
    <Response>
      <Pause length="20"/>
      <Redirect>/webhooks/twilio/no-answer</Redirect>
    </Response>
  `);
});

router.post('/no-answer', twilioAuth, async (req, res) => {
  const { From, To, CallSid } = req.body;
  console.log(`No answer for call from ${From}, CallSid: ${CallSid}`);

  try {
    const callId = uuidv4();
    db.prepare(`INSERT INTO calls (id, from_number, to_number, call_sid, status) VALUES (?,?,?,?,?)`)
      .run(callId, From, To, CallSid, 'missed');

    createLead(From, callId);

    await sendSMS(From,
      `Hi! You just called us and we missed you. We're sorry about that! ` +
      `Can you tell us your name so we can follow up properly?`
    );

    console.log(`SMS sent to ${From}`);
  } catch (err) {
    console.log(`Duplicate or error: ${err.message}`);
  }

  res.status(200).type('text/xml').send(`<Response><Hangup/></Response>`);
});

router.post('/sms-reply', twilioAuth, async (req, res) => {
  const { From, Body } = req.body;
  const text = Body.trim();

  const lead = getLeadByPhone(From);
  if (!lead) {
    await sendSMS(From, `Thanks for reaching out! Please call us and we'll be happy to help.`);
    return res.status(200).send('<Response></Response>');
  }

  appendToConversation(lead.id, 'customer', text);

  if (!lead.name) {
    updateLead(lead.id, { name: text });
    await sendSMS(From,
      `Thanks ${text}! What can we help you with today? ` +
      `Please describe the reason for your call in a sentence or two.`
    );
  } else if (!lead.reason) {
    updateLead(lead.id, { reason: text });

    await sendSMS(From,
      `Got it, thank you! A team member will call you back shortly. ` +
      `We appreciate your patience.`
    );

    classifyLead(From, text)
      .then(async (result) => {
        updateLead(lead.id, {
          urgency: result.urgency,
          lead_type: result.lead_type,
          ai_summary: result.summary,
        });
        const updatedLead = { ...lead, name: lead.name, reason: text, ...result };
        await notifyOwner(updatedLead);
      })
      .catch(err => console.error('Claude classification failed:', err));
  } else {
    await sendSMS(From, `Thanks! We have your message and will be in touch soon.`);
  }

  res.status(200).send('<Response></Response>');
});

module.exports = router;