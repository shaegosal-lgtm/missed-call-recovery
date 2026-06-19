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

function isAnytimeResponse(text) {
  const t = text.toLowerCase().trim();
  return ['anytime', 'any time', 'whenever', 'any day', "doesn't matter",
    'doesnt matter', 'no preference', 'flexible', 'asap', 'as soon as possible'].includes(t);
}

function looksLikeRejectSlots(text) {
  const t = text.toLowerCase();
  return t.includes('none of those') || t.includes('none of them') ||
    t.includes("don't work") || t.includes('dont work') ||
    t.includes('not work') || t.includes('different time') ||
    t.includes('other time') || t.includes('another time') ||
    t.includes('different times') || t.includes('anything else');
}

function looksLikeDifferentDay(text) {
  const t = text.toLowerCase();
  return t.includes('different day') || t.includes('another day') ||
    t.includes('other day') || t.includes('different date');
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

async function showSlotsForDate(lead, business, targetDate, timePreference, From, excludeStarts = []) {
  let slots = getAvailableSlots(business.id, targetDate);

  if (timePreference === 'morning') slots = slots.filter(s => s.slotHour < 12);
  else if (timePreference === 'afternoon') slots = slots.filter(s => s.slotHour >= 12 && s.slotHour < 17);
  else if (timePreference === 'evening') slots = slots.filter(s => s.slotHour >= 17);

  // Exclude slots already offered
  if (excludeStarts.length > 0) {
    slots = slots.filter(s => !excludeStarts.includes(s.start.toISOString()));
  }

  if (slots.length === 0) {
    // No more slots this day — ask if they want a different day instead of auto-jumping
    appendToConversation(lead.id, 'system', JSON.stringify({
      askingDifferentDay: true,
      businessId: business.id
    }));
    await sendAndLog(lead.id, From, `That was all our availability for that day. Would you like to try a different day?`);
    return;
  }

  const offered = slots.slice(0, 3);
  const dateLabel = formatDate(targetDate);
  const options = offered.map((s, i) => `${i + 1}) ${s.label}`).join(', ');

  appendToConversation(lead.id, 'system', JSON.stringify({
    pendingSlots: offered.map(s => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() })),
    date: targetDate,
    businessId: business.id,
    timePreference: timePreference || null
  }));

  await sendAndLog(lead.id, From, `On ${dateLabel} we have: ${options}. Reply 1, 2, or 3 to confirm your spot.`);
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

  const lastAssistantMsg = [...convo].reverse().find(m => m.role === 'assistant');
  const recentSystem = [...convo].reverse().find(m => m.role === 'system');

  // PRIORITY 1: Asking if they want a different day (after slots exhausted)
  if (recentSystem) {
    let sysData;
    try { sysData = JSON.parse(recentSystem.body); } catch { sysData = {}; }

    if (sysData.askingDifferentDay) {
      if (isNo(text)) {
        updateLead(lead.id, { status: 'needs_followup' });
        await sendAndLog(lead.id, From, `No problem. A team member will reach out to help find a time that works.`);
        return res.status(200).send('<Response></Response>');
      }
      // Treat as a new day request
      const parsedDate = parseDateFromMessage(text);
      const timePreference = getTimePreferenceFromText(text);
      if (isAnytimeResponse(text)) {
        const available = getNextAvailableDays(business.id, 7);
        if (available.length > 0) {
          await showSlotsForDate(lead, business, available[0].date, null, From);
          return res.status(200).send('<Response></Response>');
        }
      }
      if (parsedDate && business) {
        await showSlotsForDate(lead, business, parsedDate, timePreference, From);
        return res.status(200).send('<Response></Response>');
      }
      await sendAndLog(lead.id, From, `What day would you like to try?`);
      return res.status(200).send('<Response></Response>');
    }
  }

  // PRIORITY 2: Pending slots + number selection OR rejection of offered slots
  if (recentSystem) {
    let pendingData;
    try { pendingData = JSON.parse(recentSystem.body); } catch { pendingData = {}; }

    if (pendingData.pendingSlots && !pendingData.pendingConfirmation) {
      // Number selection
      if (/^[123]$/.test(text.trim())) {
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
          updateLead(lead.id, { status: 'scheduled' });

          appendToConversation(lead.id, 'system', JSON.stringify({
            pendingConfirmation: true,
            confirmationCode: result.confirmationCode,
            slotLabel: chosen.label,
            businessId: businessId
          }));

          await sendAndLog(lead.id, From, `Before we confirm your appointment for ${chosen.label}, we need your service address so our technician knows where to go. Could you provide that now, or would you prefer a team member calls you to confirm?`);

          await notifyOwner({ ...lead, ai_summary: `Appointment pending for ${chosen.label}. Code: ${result.confirmationCode}` });
          await sendLeadNotification(
            business || { name: 'the business' },
            { ...lead, ai_summary: `Appointment pending for ${chosen.label}` },
            null
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

      // Rejection of offered slots — show MORE slots for same day, or different day
      if (looksLikeRejectSlots(text) && business) {
        const excludeStarts = pendingData.pendingSlots.map(s => s.start);
        await showSlotsForDate(lead, business, pendingData.date, pendingData.timePreference, From, excludeStarts);
        return res.status(200).send('<Response></Response>');
      }

      if (looksLikeDifferentDay(text)) {
        await sendAndLog(lead.id, From, `No problem, what day would you like to try instead?`);
        return res.status(200).send('<Response></Response>');
      }
    }
  }

  // PRIORITY 3: Cancel keywords
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

  // PRIORITY 4: Reschedule keywords
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

  // PRIORITY 5: Check if waiting for address
  const waitingForAddress = lastAssistantMsg && (
    lastAssistantMsg.body.toLowerCase().includes('service address') ||
    lastAssistantMsg.body.toLowerCase().includes('address so our technician') ||
    lastAssistantMsg.body.toLowerCase().includes('confirm your')
  );

  if (waitingForAddress) {
    const appt = getAppointmentByPhone(From);

    const pendingConfirmMsg = [...convo].reverse().find(m => {
      if (m.role !== 'system') return false;
      try { return JSON.parse(m.body).pendingConfirmation; } catch { return false; }
    });
    let confirmCode = null;
    let slotLabel = null;
    if (pendingConfirmMsg) {
      try {
        const data = JSON.parse(pendingConfirmMsg.body);
        confirmCode = data.confirmationCode;
        slotLabel = data.slotLabel;
      } catch {}
    }

    if (wantsToWaitForCall(text) || isNo(text)) {
      if (appt) {
        db.prepare('UPDATE appointments SET address_confirmed = 0 WHERE id = ?').run(appt.id);
      }
      updateLead(lead.id, { status: 'needs_followup' });
      const msg = confirmCode
        ? `No problem! Your appointment is confirmed for ${slotLabel}. Confirmation code: ${confirmCode}. A team member will call to confirm your address before the visit. Reply CANCEL anytime to cancel.`
        : `No problem. A team member will call to confirm your address before the visit. We look forward to seeing you!`;
      await sendAndLog(lead.id, From, msg);
      return res.status(200).send('<Response></Response>');
    }

    if (looksLikeAddress(text) || text.length > 10) {
      if (appt) {
        db.prepare('UPDATE appointments SET service_address = ?, address_confirmed = 1 WHERE id = ?')
          .run(text, appt.id);
      }
      updateLead(lead.id, { status: 'scheduled' });
      const msg = confirmCode
        ? `You are all set! Your appointment is confirmed for ${slotLabel}. Confirmation code: ${confirmCode}. We have your address on file and will see you then. Reply CANCEL anytime to cancel.`
        : `Perfect, thank you! We have your address on file. We look forward to seeing you. Reply CANCEL anytime to cancel.`;
      await sendAndLog(lead.id, From, msg);
      return res.status(200).send('<Response></Response>');
    } else {
      await sendAndLog(lead.id, From, `Could you confirm the full service address where our technician should come?`);
      return res.status(200).send('<Response></Response>');
    }
  }

  // PRIORITY 6: First message — save as reason
  if (!lead.reason) {
    const firstMsgHasBookingIntent = text.toLowerCase().includes('book') ||
      text.toLowerCase().includes('appointment') ||
      text.toLowerCase().includes('schedule') ||
      text.toLowerCase().includes('come in') ||
      text.toLowerCase().includes('visit') ||
      containsDateOrDay(text) ||
      isAnytimeResponse(text);

    if (firstMsgHasBookingIntent && business) {
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

      if (containsDateOrDay(text) || isAnytimeResponse(text)) {
        if (isAnytimeResponse(text)) {
          const available = getNextAvailableDays(business.id, 7);
          if (available.length > 0) {
            await showSlotsForDate(lead, business, available[0].date, null, From);
            return res.status(200).send('<Response></Response>');
          }
        }
        const parsedDate = parseDateFromMessage(text);
        const timePreference = getTimePreferenceFromText(text);
        if (parsedDate) {
          await showSlotsForDate(lead, business, parsedDate, timePreference, From);
          return res.status(200).send('<Response></Response>');
        }
      }

      await sendAndLog(lead.id, From, `What day works best for you?`);
      return res.status(200).send('<Response></Response>');
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
    if (isAnytimeResponse(text)) {
      const available = getNextAvailableDays(business.id, 7);
      if (available.length === 0) {
        updateLead(lead.id, { status: 'needs_followup' });
        await sendAndLog(lead.id, From, `We do not have any openings in the next week. A team member will call you to get you scheduled.`);
        return res.status(200).send('<Response></Response>');
      }
      await showSlotsForDate(lead, business, available[0].date, null, From);
      return res.status(200).send('<Response></Response>');
    }

    const parsedDate = parseDateFromMessage(text);
    const timePreference = getTimePreferenceFromText(text);

    if (parsedDate) {
      await showSlotsForDate(lead, business, parsedDate, timePreference, From);
      return res.status(200).send('<Response></Response>');
    }
  }

  // PRIORITY 10: Any message containing a day/date or anytime
  if (business && (containsDateOrDay(text) || isAnytimeResponse(text))) {
    if (isAnytimeResponse(text)) {
      const available = getNextAvailableDays(business.id, 7);
      if (available.length === 0) {
        updateLead(lead.id, { status: 'needs_followup' });
        await sendAndLog(lead.id, From, `We do not have any openings in the next week. A team member will call you to get you scheduled.`);
        return res.status(200).send('<Response></Response>');
      }
      await showSlotsForDate(lead, business, available[0].date, null, From);
      return res.status(200).send('<Response></Response>');
    }

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

  // PRIORITY 13: Claude handles everything else
  const reply = await getReceptionistResponse(
    business || { name: 'the business' },
    lead,
    convo,
    text
  );

  if (reply.toLowerCase().includes('team member') || reply.toLowerCase().includes('reach out')) {
    updateLead(lead.id, { status: 'needs_followup' });
  }

  await sendAndLog(lead.id, From, reply);

  res.status(200).send('<Response></Response>');
});

module.exports = router;