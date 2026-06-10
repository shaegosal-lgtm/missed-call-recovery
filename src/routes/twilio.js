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

function parseDateFromMessage(text) {
  const t = text.toLowerCase().trim();
  const today = new Date();
  const todayDay = today.getDay();

  const days = {
    'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
    'thursday': 4, 'friday': 5, 'saturday': 6
  };

  // Check for day names
  for (const [dayName, dayNum] of Object.entries(days)) {
    if (t.includes(dayName)) {
      let daysAhead = dayNum - todayDay;
      if (daysAhead <= 0) daysAhead += 7;
      const target = new Date(today);
      target.setDate(today.getDate() + daysAhead);
      return getNextWeekday(target);
    }
  }

  if (t.includes('tomorrow')) {
    const tomorrow = new Date(today);
    tomorrow.setDate(today.getDate() + 1);
    return getNextWeekday(tomorrow);
  }

  if (t.includes('today')) {
    return getNextWeekday(today);
  }

  if (t.includes('next week')) {
    const monday = new Date(today);
    const daysUntilMonday = (8 - todayDay) % 7 || 7;
    monday.setDate(today.getDate() + daysUntilMonday);
    return monday.toISOString().split('T')[0];
  }

  // Check for specific dates like "June 1st", "June 1", "the 15th"
  const months = {
    'january': 1, 'february': 2, 'march': 3, 'april': 4,
    'may': 5, 'june': 6, 'july': 7, 'august': 8,
    'september': 9, 'october': 10, 'november': 11, 'december': 12
  };

  for (const [monthName, monthNum] of Object.entries(months)) {
    if (t.includes(monthName)) {
      const match = t.match(/(\d+)/);
      if (match) {
        const day = parseInt(match[1]);
        const year = today.getFullYear();
        const date = new Date(year, monthNum - 1, day);
        if (date < today) date.setFullYear(year + 1);
        return getNextWeekday(date);
      }
    }
  }

  return null;
}

function getTimePreferenceFromText(text) {
  const t = text.toLowerCase();
  if (t.includes('morning') || t.includes(' am')) return 'morning';
  if (t.includes('afternoon') || t.includes('lunch')) return 'afternoon';
  if (t.includes('evening') || t.includes('night') || t.includes(' pm')) return 'evening';
  return null;
}

async function sendAndLog(leadId, to, message) {
  await sendSMS(to, message);
  if (leadId) appendToConversation(leadId, 'assistant', message);
}

function isYes(text) {
  const t = text.toLowerCase().trim();
  return ['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'definitely',
    'absolutely', 'please', 'yes please', 'sounds good', 'of course'].includes(t);
}

function isNo(text) {
  const t = text.toLowerCase().trim();
  return ['no', 'nope', 'nah', 'not now', 'no thanks', 'no thank you'].includes(t);
}

async function showSlotsForDate(lead, business, targetDate, timePreference, From) {
  let slots = getAvailableSlots(business.id, targetDate);

  if (timePreference === 'morning') slots = slots.filter(s => s.slotHour < 12);
  else if (timePreference === 'afternoon') slots = slots.filter(s => s.slotHour >= 12 && s.slotHour < 17);
  else if (timePreference === 'evening') slots = slots.filter(s => s.slotHour >= 17);

  if (slots.length === 0) {
    const available = getNextAvailableDays(business.id, 7);
    if (available.length === 0) {
      await sendAndLog(lead.id, From, `We do not have any openings in the next week. A team member will call you to get you scheduled.`);
      return;
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

    await sendAndLog(lead.id, From, `We are not available that day. The next opening is ${dateLabel}: ${options}. Reply 1, 2, or 3 to confirm.`);
  } else {
    const offered = slots.slice(0, 3);
    const dateLabel = formatDate(targetDate);
    const options = offered.map((s, i) => `${i + 1}) ${s.label}`).join(', ');

    appendToConversation(lead.id, 'system', JSON.stringify({
      pendingSlots: offered.map(s => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() })),
      date: targetDate,
      businessId: business.id
    }));

    await sendAndLog(lead.id, From, `On ${dateLabel} we have: ${options}. Reply 1, 2, or 3 to confirm your spot.`);
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

      await sendSMS(From, firstMessage);
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

      await sendSMS(From, firstMessage);
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
    await sendSMS(From, `Thanks for reaching out! Please call us and we will be happy to help.`);
    return res.status(200).send('<Response></Response>');
  }

  const business = db.prepare('SELECT * FROM businesses WHERE twilio_number = ?').get(process.env.TWILIO_PHONE_NUMBER);
  const convo = JSON.parse(lead.conversation || '[]');

  appendToConversation(lead.id, 'customer', text);

  // PRIORITY 1: Pending slots + number selection
  const recentSystem = [...convo].reverse().find(m => m.role === 'system');
  if (recentSystem && /^[123]$/.test(text.trim())) {
    let pendingData;
    try {
      pendingData = JSON.parse(recentSystem.body);
    } catch {
      await sendAndLog(lead.id, From, `Something went wrong. What day would you like to come in?`);
      return res.status(200).send('<Response></Response>');
    }

    const { pendingSlots, businessId } = pendingData;
    const index = parseInt(text.trim()) - 1;
    const chosen = pendingSlots[index];

    if (!chosen) {
      await sendAndLog(lead.id, From, `Please reply with 1, 2, or 3 to select a time.`);
      return res.status(200).send('<Response></Response>');
    }

    const result = bookAppointment(businessId, lead.id, chosen.start);

    if (!result.success) {
      await sendAndLog(lead.id, From, `Sorry, that time was just taken. What other day works for you?`);
    } else {
      const confirmMsg = `You are all set! Your appointment is confirmed for ${chosen.label}. Confirmation code: ${result.confirmationCode}. Reply CANCEL anytime to cancel. May I get your name for our records?`;
      await sendAndLog(lead.id, From, confirmMsg);
      updateLead(lead.id, { status: 'scheduled' });
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
      await sendAndLog(lead.id, From, `We do not have an active appointment on file for your number.`);
    } else {
      cancelAppointment(appt.id);
      await sendAndLog(lead.id, From, `Your appointment has been cancelled. Feel free to text us anytime to rebook.`);
    }
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 3: First message — customer just gave their reason
  if (!lead.reason && text.length > 3) {
    updateLead(lead.id, { reason: text });

    classifyLead(From, text)
      .then(result => {
        updateLead(lead.id, {
          urgency: result.urgency,
          lead_type: result.lead_type,
          ai_summary: result.summary,
        });
        notifyOwner({ ...lead, reason: text, ...result });
      })
      .catch(err => console.error('Classification failed:', err));

    await sendAndLog(lead.id, From, `Got it, thank you for letting us know. Would you like to book an appointment?`);
    return res.status(200).send('<Response></Response>');
  }

  // Check last assistant message
  const lastAssistantMsg = [...convo].reverse().find(m => m.role === 'assistant');
  const lastMsgWasBookingQuestion = lastAssistantMsg &&
    lastAssistantMsg.body.toLowerCase().includes('book an appointment');
  const lastMsgWasDayQuestion = lastAssistantMsg && (
    lastAssistantMsg.body.toLowerCase().includes('what day works') ||
    lastAssistantMsg.body.toLowerCase().includes('what day would') ||
    lastAssistantMsg.body.toLowerCase().includes('what other day')
  );

  // PRIORITY 4: Customer said yes to booking
  if (lastMsgWasBookingQuestion && isYes(text)) {
    await sendAndLog(lead.id, From, `What day works best for you?`);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 5: Customer said no to booking
  if (lastMsgWasBookingQuestion && isNo(text)) {
    await sendAndLog(lead.id, From, `No problem. A team member will be in touch with you shortly.`);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 6: Last message was asking for a day — treat reply as day selection
  if (lastMsgWasDayQuestion && business) {
    const parsedDate = parseDateFromMessage(text);
    const timePreference = getTimePreferenceFromText(text);

    if (parsedDate) {
      await showSlotsForDate(lead, business, parsedDate, timePreference, From);
      return res.status(200).send('<Response></Response>');
    } else {
      // Couldn't parse a date — ask again more specifically
      await sendAndLog(lead.id, From, `Could you let us know a specific day, like Monday or Tuesday?`);
      return res.status(200).send('<Response></Response>');
    }
  }

  // PRIORITY 7: Analyze intent with Claude
  let intent;
  try {
    intent = await analyzeIntent(text, convo);
  } catch (err) {
    console.error('Intent analysis failed:', err);
    intent = {};
  }

  console.log('Intent:', JSON.stringify(intent));

  // Extract name if detected and lead is already scheduled
  if (intent.has_name && intent.name && !lead.name) {
    updateLead(lead.id, { name: intent.name });
    lead.name = intent.name;
    await sendAndLog(lead.id, From, `Thank you ${intent.name}! We look forward to seeing you.`);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 8: Booking flow from intent
  if (intent.wants_to_book || intent.wants_to_reschedule) {
    if (intent.wants_to_reschedule) {
      const appt = getAppointmentByPhone(From);
      if (appt) cancelAppointment(appt.id);
    }

    if (!business) {
      await sendAndLog(lead.id, From, `A team member will reach out shortly to get you scheduled.`);
      return res.status(200).send('<Response></Response>');
    }

    let targetDate = null;
    if (intent.preferred_date) {
      targetDate = getNextWeekday(new Date(intent.preferred_date));
    } else if (intent.preferred_day) {
      targetDate = parseDayFromText(intent.preferred_day);
    } else {
      await sendAndLog(lead.id, From, `What day works best for you?`);
      return res.status(200).send('<Response></Response>');
    }

    const timePreference = intent.time_preference;
    await showSlotsForDate(lead, business, targetDate, timePreference, From);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 9: Claude handles everything else
  const reply = await getReceptionistResponse(
    business || { name: 'the business' },
    lead,
    convo,
    text
  );

  await sendAndLog(lead.id, From, reply);

  res.status(200).send('<Response></Response>');
});

module.exports = router;