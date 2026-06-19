const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendSMS } = require('../services/twilioService');
const { classifyLead, getReceptionistResponse, analyzeIntent } = require('../services/claudeService');
const { createLead, getLeadByPhone, updateLead, appendToConversation } = require('../services/leadService');
const { notifyOwner } = require('../services/notifyService');
const { sendLeadNotification } = require('../services/emailService');
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

function parseDayFromText(day, isNextWeek = false) {
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
    if (isNextWeek) daysAhead += 7;
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
  const isNextWeek = t.includes('next ');

  const days = {
    'sunday': 0, 'monday': 1, 'tuesday': 2, 'wednesday': 3,
    'thursday': 4, 'friday': 5, 'saturday': 6
  };

  for (const [dayName, dayNum] of Object.entries(days)) {
    if (t.includes(dayName)) {
      let daysAhead = dayNum - todayDay;
      if (daysAhead <= 0) daysAhead += 7;
      if (isNextWeek) daysAhead += 7;
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

function looksLikeAddress(text) {
  return /\d+\s+\w+/.test(text) ||
    text.toLowerCase().includes('street') ||
    text.toLowerCase().includes('avenue') ||
    text.toLowerCase().includes('ave') ||
    text.toLowerCase().includes('road') ||
    text.toLowerCase().includes('rd') ||
    text.toLowerCase().includes('drive') ||
    text.toLowerCase().includes('dr') ||
    text.toLowerCase().includes('blvd') ||
    text.toLowerCase().includes('lane') ||
    text.toLowerCase().includes('court');
}

function wantsToWaitForCall(text) {
  const t = text.toLowerCase();
  return t.includes('call') || t.includes('when you call') ||
    t.includes('prefer') || t.includes('later') ||
    t.includes('then') || t.includes('when someone') ||
    t.includes('wait') || t.includes('phone call');
}

function looksLikeCancel(text) {
  const t = text.toLowerCase();
  return t === 'cancel' ||
    t.includes('cancel my appointment') ||
    t.includes('cancel appointment') ||
    t.includes('want to cancel') ||
    t.includes('need to cancel') ||
    t.includes('like to cancel');
}

function looksLikeReschedule(text) {
  const t = text.toLowerCase();
  return t.includes('reschedule') ||
    t.includes('change my appointment') ||
    t.includes('move my appointment') ||
    t.includes('different time') ||
    t.includes('different day');
}

function containsDateOrDay(text) {
  const t = text.toLowerCase();
  const dayWords = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday',
    'saturday', 'sunday', 'tomorrow', 'today', 'next week'];
  const monthWords = ['january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december'];
  return dayWords.some(d => t.includes(d)) || monthWords.some(m => t.includes(m));
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
      // Booking confirmed - now ALWAYS collect name and address before considering complete
      updateLead(lead.id, { status: 'scheduled' });

      let nextMsg;
      if (!lead.name) {
        nextMsg = `You are all set! Appointment confirmed for ${chosen.label}. Confirmation code: ${result.confirmationCode}. To finish setting up your appointment, may I get your name?`;
      } else {
        nextMsg = `You are all set! Appointment confirmed for ${chosen.label}. Confirmation code: ${result.confirmationCode}. To send our technician, could you provide your service address?`;
      }

      await sendAndLog(lead.id, From, nextMsg);

      const apptDetails = `${chosen.label} — Confirmation Code: ${result.confirmationCode}`;
      await notifyOwner({ ...lead, ai_summary: apptDetails });
      await sendLeadNotification(
        business || { name: 'the business' },
        { ...lead, ai_summary: apptDetails },
        apptDetails
      );

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

  // PRIORITY 2: Cancel keywords
  if (looksLikeCancel(text)) {
    const appt = getAppointmentByPhone(From);
    if (!appt) {
      await sendAndLog(lead.id, From, `We do not have an active appointment on file for your number.`);
    } else {
      cancelAppointment(appt.id);
      await sendAndLog(lead.id, From, `Your appointment has been cancelled. Feel free to text us anytime to rebook.`);
    }
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 3: Reschedule keywords
  if (looksLikeReschedule(text)) {
    const appt = getAppointmentByPhone(From);
    if (!appt) {
      await sendAndLog(lead.id, From, `We do not have an active appointment on file for your number. Would you like to book one?`);
    } else {
      cancelAppointment(appt.id);
      await sendAndLog(lead.id, From, `No problem. Your current appointment has been cancelled. What day works best for the new appointment?`);
    }
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 4: Check if waiting for NAME (right after booking, before address)
  const lastAssistantMsg = [...convo].reverse().find(m => m.role === 'assistant');
  const waitingForNameAfterBooking = lastAssistantMsg &&
    lastAssistantMsg.body.toLowerCase().includes('may i get your name');

  if (waitingForNameAfterBooking && text.length > 1 && text.length < 40) {
    updateLead(lead.id, { name: text });
    await sendAndLog(lead.id, From, `Thank you ${text}! To send our technician, could you provide your service address?`);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 5: Check if waiting for address response
  const waitingForAddress = lastAssistantMsg &&
    lastAssistantMsg.body.toLowerCase().includes('service address');

  if (waitingForAddress) {
    const appt = getAppointmentByPhone(From);

    if (wantsToWaitForCall(text) || isNo(text)) {
      if (appt) {
        db.prepare('UPDATE appointments SET address_confirmed = 0 WHERE id = ?').run(appt.id);
      }
      updateLead(lead.id, { status: 'needs_followup' });
      await sendAndLog(lead.id, From, `No problem at all. A team member will call you to confirm the address before your appointment. We look forward to seeing you!`);
      return res.status(200).send('<Response></Response>');
    }

    if (looksLikeAddress(text) || text.length > 10) {
      if (appt) {
        db.prepare('UPDATE appointments SET service_address = ?, address_confirmed = 1 WHERE id = ?')
          .run(text, appt.id);
      }
      updateLead(lead.id, { status: 'scheduled' });
      await sendAndLog(lead.id, From, `Perfect, thank you! We have your address on file. We look forward to seeing you. Reply CANCEL anytime if you need to cancel.`);
      return res.status(200).send('<Response></Response>');
    } else {
      // Didn't look like a valid address - ask again, don't silently move on
      await sendAndLog(lead.id, From, `Sorry, could you confirm the full address where our technician should come?`);
      return res.status(200).send('<Response></Response>');
    }
  }

  // PRIORITY 6: First message — save as reason
  if (!lead.reason) {
    if (containsDateOrDay(text) && business) {
      const parsedDate = parseDateFromMessage(text);
      const timePreference = getTimePreferenceFromText(text);

      updateLead(lead.id, { reason: text });
      classifyLead(From, text)
        .then(result => {
          updateLead(lead.id, {
            urgency: result.urgency,
            lead_type: result.lead_type,
            ai_summary: result.summary,
          });
          notifyOwner({ ...lead, reason: text, ...result });
          sendLeadNotification(business || { name: 'the business' }, { ...lead, reason: text, ...result });
        })
        .catch(err => console.error('Classification failed:', err));

      if (parsedDate) {
        await showSlotsForDate(lead, business, parsedDate, timePreference, From);
        return res.status(200).send('<Response></Response>');
      }
    }

    if (text.length > 3) {
      updateLead(lead.id, { reason: text });

      classifyLead(From, text)
        .then(result => {
          updateLead(lead.id, {
            urgency: result.urgency,
            lead_type: result.lead_type,
            ai_summary: result.summary,
          });
          notifyOwner({ ...lead, reason: text, ...result });
          sendLeadNotification(business || { name: 'the business' }, { ...lead, reason: text, ...result });
        })
        .catch(err => console.error('Classification failed:', err));

      await sendAndLog(lead.id, From, `Got it, thank you for letting us know. Would you like to book an appointment?`);
      return res.status(200).send('<Response></Response>');
    }
  }

  // Check last assistant message context
  const lastMsgWasBookingQuestion = lastAssistantMsg &&
    lastAssistantMsg.body.toLowerCase().includes('book an appointment');
  const lastMsgWasDayQuestion = lastAssistantMsg && (
    lastAssistantMsg.body.toLowerCase().includes('what day works') ||
    lastAssistantMsg.body.toLowerCase().includes('what day would') ||
    lastAssistantMsg.body.toLowerCase().includes('what other day') ||
    lastAssistantMsg.body.toLowerCase().includes('specific day')
  );

  // PRIORITY 7: Customer said yes to booking
  if (lastMsgWasBookingQuestion && isYes(text)) {
    await sendAndLog(lead.id, From, `What day works best for you?`);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 8: Customer said no to booking
  if (lastMsgWasBookingQuestion && isNo(text)) {
    updateLead(lead.id, { status: 'needs_followup' });
    await sendAndLog(lead.id, From, `No problem. A team member will be in touch with you shortly.`);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 9: Last message was asking for a day
  if (lastMsgWasDayQuestion && business) {
    const parsedDate = parseDateFromMessage(text);
    const timePreference = getTimePreferenceFromText(text);

    if (parsedDate) {
      await showSlotsForDate(lead, business, parsedDate, timePreference, From);
      return res.status(200).send('<Response></Response>');
    }
  }

  // PRIORITY 10: Any message containing a day/date
  if (business && containsDateOrDay(text)) {
    const parsedDate = parseDateFromMessage(text);
    const timePreference = getTimePreferenceFromText(text);

    if (parsedDate) {
      await showSlotsForDate(lead, business, parsedDate, timePreference, From);
      return res.status(200).send('<Response></Response>');
    }
  }

  // PRIORITY 11: Analyze intent with Claude
  let intent;
  try {
    intent = await analyzeIntent(text, convo);
  } catch (err) {
    console.error('Intent analysis failed:', err);
    intent = {};
  }

  console.log('Intent:', JSON.stringify(intent));

  // Extract name if detected and lead is scheduled but name missing
  if (intent.has_name && intent.name && !lead.name && lead.status === 'scheduled') {
    updateLead(lead.id, { name: intent.name });
    lead.name = intent.name;
    await sendAndLog(lead.id, From, `Thank you ${intent.name}! To send our technician, could you provide your service address?`);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 12: Booking flow from intent
  if (intent.wants_to_book || intent.wants_to_reschedule) {
    if (intent.wants_to_reschedule) {
      const appt = getAppointmentByPhone(From);
      if (appt) cancelAppointment(appt.id);
    }

    if (!business) {
      updateLead(lead.id, { status: 'needs_followup' });
      await sendAndLog(lead.id, From, `A team member will reach out shortly to get you scheduled.`);
      return res.status(200).send('<Response></Response>');
    }

    let targetDate = null;

    if (intent.preferred_day) {
      const isNextWeek = intent.is_next_week || text.toLowerCase().includes('next ' + intent.preferred_day);
      targetDate = parseDayFromText(intent.preferred_day, isNextWeek);
    } else {
      await sendAndLog(lead.id, From, `What day works best for you?`);
      return res.status(200).send('<Response></Response>');
    }

    const timePreference = intent.time_preference || getTimePreferenceFromText(text);
    await showSlotsForDate(lead, business, targetDate, timePreference, From);
    return res.status(200).send('<Response></Response>');
  }

  // PRIORITY 13: Claude handles everything else — if it can't help, flag for follow up
  const reply = await getReceptionistResponse(
    business || { name: 'the business' },
    lead,
    convo,
    text
  );

  // If Claude is deferring to a team member, mark lead as needing follow up
  if (reply.toLowerCase().includes('team member') || reply.toLowerCase().includes('reach out')) {
    updateLead(lead.id, { status: 'needs_followup' });
  }

  await sendAndLog(lead.id, From, reply);

  res.status(200).send('<Response></Response>');
});

module.exports = router;