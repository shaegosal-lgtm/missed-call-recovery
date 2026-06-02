const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendSMS } = require('../services/twilioService');
const { classifyLead, getReceptionistResponse, analyzeIntent } = require('../services/claudeService');
const { createLead, getLeadByPhone, updateLead, appendToConversation } = require('../services/leadService');
const { notifyOwner } = require('../services/notifyService');
const twilioAuth = require('../middleware/twilioAuth');
const {
  getAvailableSlots,
  getNextAvailableDays,
  bookAppointment,
  cancelAppointment,
  getAppointmentByPhone,
  formatDate,
} = require('../services/schedulingService');

function getNextWeekday(date) {
  const d = new Date(date);
  const day = d.getDay();
  if (day === 6) d.setDate(d.getDate() + 2);
  if (day === 0) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

function parseDayFromText(day) {
  if (!day) return null;
  const today = new Date();
  const todayDay = today.getDay();

  const days = {
    'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
    'thursday': 4, 'friday': 5, 'saturday': 6
  };

  if (day === 'tomorrow') {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return getNextWeekday(tomorrow);
  }

  if (day === 'today') {
    return getNextWeekday(today);
  }

  if (days[day] !== undefined) {
    let daysAhead = days[day] - todayDay;
    if (daysAhead <= 0) daysAhead += 7;
    const target = new Date(today);
    target.setDate(today.getDate() + daysAhead);
    return getNextWeekday(target);
  }

  return getNextWeekday(new Date(today.setDate(today.getDate() + 1)));
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

      createLead(From, callId);

      const bizName = business ? business.name : 'us';
      await sendSMS(From,
        `Hi! You just called ${bizName} and we missed you. We are sorry about that! ` +
        `How can we help you today?`
      );

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

      createLead(From, callId);

      const bizName = business ? business.name : 'us';
      await sendSMS(From,
        `Hi! You just called ${bizName} and we missed you. We are sorry about that! ` +
        `How can we help you today?`
      );

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
    await sendSMS(From, `Thanks for reaching out! Please call us and we will be happy to help.`);
    return res.status(200).send('<Response></Response>');
  }

  const business = db.prepare('SELECT * FROM businesses WHERE twilio_number = ?').get(process.env.TWILIO_PHONE_NUMBER);
  const convo = JSON.parse(lead.conversation || '[]');

  appendToConversation(lead.id, 'customer', text);

  // PRIORITY 1: Pending slots + number selection — check first always
  const recentSystem = [...convo].reverse().find(m => m.role === 'system');
  if (recentSystem && /^[123]$/.test(text.trim())) {
    let pendingData;
    try {
      pendingData = JSON.parse(recentSystem.body);
    } catch {
      await sendSMS(From, `Something went wrong. Please tell us what day you would like to come in.`);
      return res.status(200).send('<Response></Response>');
    }

    const { pendingSlots, businessId } = pendingData;
    const index = parseInt(text.trim()) - 1;
    const chosen = pendingSlots[index];

    if (!chosen) {
      await sendSMS(From, `Please reply with 1, 2, or 3 to select a time.`);
      return res.status(200).send('<Response></Response>');
    }

    const result = bookAppointment(businessId, lead.id, chosen.start);

    if (!result.success) {
      await sendSMS(From, `Sorry, that slot was just taken. What other day works for you?`);
    } else {
      await sendSMS(From,
        `Booked! Your appointment is confirmed for ${chosen.label}. ` +
        `Confirmation code: ${result.confirmationCode}. ` +
        `Reply CANCEL anytime to cancel.`
      );
      await notifyOwner({
        ...lead,
        ai_summary: `Appointment booked for ${chosen.label}. Code: ${result.confirmationCode}`
      });

      if (lead.reason) {
        classifyLead(From, lead.reason)
          .then(r => updateLead(lead.id, {
            urgency: r.urgency,
            lead_type: r.lead_type,
            ai_summary: r.summary,
          }))
          .catch(err => console.error('Classification failed:', err));
      }
    }
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 2: CANCEL keyword
  if (text.toUpperCase() === 'CANCEL') {
    const appt = getAppointmentByPhone(From);
    if (!appt) {
      await sendSMS(From, `We don't have an active appointment on file for your number.`);
    } else {
      cancelAppointment(appt.id);
      await sendSMS(From, `Your appointment has been cancelled. Text us anytime to rebook.`);
    }
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 3: Analyze intent
  let intent;
  try {
    intent = await analyzeIntent(text, convo);
  } catch (err) {
    console.error('Intent analysis failed:', err);
    intent = {};
  }

  console.log('Intent:', JSON.stringify(intent));

  // Extract name if detected
  if (intent.has_name && intent.name && !lead.name) {
    updateLead(lead.id, { name: intent.name });
    lead.name = intent.name;
  }

  // PRIORITY 4: Booking flow — only code handles scheduling, never Claude
  if (intent.wants_to_book || intent.wants_to_reschedule) {
    if (intent.wants_to_reschedule) {
      const appt = getAppointmentByPhone(From);
      if (appt) cancelAppointment(appt.id);
    }

    if (!business) {
      await sendSMS(From, `A team member will reach out shortly to schedule your appointment.`);
      return res.status(200).send('<Response></Response>');
    }

    const targetDate = parseDayFromText(intent.preferred_day);
    let slots = getAvailableSlots(business.id, targetDate);

    if (intent.time_preference === 'morning') {
      slots = slots.filter(s => s.slotHour < 12);
    } else if (intent.time_preference === 'afternoon') {
      slots = slots.filter(s => s.slotHour >= 12 && s.slotHour < 17);
    } else if (intent.time_preference === 'evening') {
      slots = slots.filter(s => s.slotHour >= 17);
    }

    if (slots.length === 0) {
      const available = getNextAvailableDays(business.id, 7);
      if (available.length === 0) {
        await sendSMS(From, `We don't have any openings in the next week. A team member will call you to schedule.`);
        return res.status(200).send('<Response></Response>');
      }
      const next = available[0];
      const offered = next.slots.slice(0, 3);
      const dateLabel = formatDate(next.date);
      const options = offered.map((s, i) => `${i + 1}) ${s.label}`).join(', ');

      appendToConversation(lead.id, 'system', JSON.stringify({
        pendingSlots: offered.map(s => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() })),
        date: next.date,
        businessId: business.id
      }));

      await sendSMS(From, `We are next available on ${dateLabel}: ${options}. Reply 1, 2, or 3 to confirm.`);
    } else {
      const offered = slots.slice(0, 3);
      const dateLabel = formatDate(targetDate);
      const options = offered.map((s, i) => `${i + 1}) ${s.label}`).join(', ');

      appendToConversation(lead.id, 'system', JSON.stringify({
        pendingSlots: offered.map(s => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() })),
        date: targetDate,
        businessId: business.id
      }));

      await sendSMS(From, `On ${dateLabel} we have: ${options}. Reply 1, 2, or 3 to book your spot.`);
    }

    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 5: Claude handles general conversation only — no scheduling
  const reply = await getReceptionistResponse(
    business || { name: 'the business' },
    lead,
    convo,
    text
  );

  await sendSMS(From, reply);

  // Save reason if not set yet
  if (!lead.reason && text.length > 10) {
    updateLead(lead.id, { reason: text });
    classifyLead(From, text)
      .then(result => {
        updateLead(lead.id, {
          urgency: result.urgency,
          lead_type: result.lead_type,
          ai_summary: result.summary,
        });
        notifyOwner({ ...lead, ...result });
      })
      .catch(err => console.error('Classification failed:', err));
  }

  res.status(200).send('<Response></Response>');
});

module.exports = router;