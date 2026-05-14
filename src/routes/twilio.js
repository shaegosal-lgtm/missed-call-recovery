const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const db = require('../db/db');
const { sendSMS } = require('../services/twilioService');
const { classifyLead, detectBookingIntent } = require('../services/claudeService');
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

function looksLikeBooking(text) {
  const t = text.toLowerCase();
  const timeWords = [
    'monday','tuesday','wednesday','thursday','friday','saturday','sunday',
    'tomorrow','today','next week','morning','afternoon','evening','night',
    'am','pm','book','schedule','appointment','come in','visit','available',
    'monday','tuesday','anytime','soon','asap','weekend'
  ];
  return timeWords.some(w => t.includes(w));
}

router.post('/missed-call', twilioAuth, async (req, res) => {
  const { From, To, CallSid, CallStatus } = req.body;
  console.log(`Call event - From: ${From}, Status: ${CallStatus}, SID: ${CallSid}`);

  if (!CallStatus || CallStatus === 'ringing' || CallStatus === 'in-progress') {
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

      await sendSMS(From,
        `Hi! You just called us and we missed you. We're sorry about that! ` +
        `Can you tell us your name so we can follow up properly?`
      );

      console.log(`SMS sent to ${From}`);
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
      `Got it, thank you! Would you like to book an appointment? ` +
      `Just let us know what day works best for you.`
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
    const convo = JSON.parse(lead.conversation || '[]');
    const upperText = text.toUpperCase();

    // Handle CANCEL keyword directly
    if (upperText === 'CANCEL') {
      const appt = getAppointmentByPhone(From);
      if (!appt) {
        await sendSMS(From, `We don't have an active appointment on file for your number.`);
      } else {
        cancelAppointment(appt.id);
        await sendSMS(From, `Your appointment has been cancelled. Text us anytime to rebook.`);
      }
      return res.status(200).send('<Response></Response>');
    }

    // Handle slot selection (1, 2, or 3)
    if (/^[123]$/.test(text.trim())) {
      const recentSystem = [...convo].reverse().find(m => m.role === 'system');

      if (!recentSystem) {
        await sendSMS(From, `Would you like to book an appointment? Let us know what day works for you.`);
        return res.status(200).send('<Response></Response>');
      }

      let pendingData;
      try {
        pendingData = JSON.parse(recentSystem.body);
      } catch {
        await sendSMS(From, `Something went wrong. Please tell us what day you'd like to come in.`);
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
          `You're booked! Appointment confirmed for ${chosen.label}. ` +
          `Your confirmation code is ${result.confirmationCode}. ` +
          `Reply CANCEL anytime to cancel.`
        );
        await notifyOwner({
          ...lead,
          ai_summary: `Appointment booked for ${chosen.label}. Code: ${result.confirmationCode}`
        });
      }
      return res.status(200).send('<Response></Response>');
    }

    // Check if message looks like a booking/time request
    if (looksLikeBooking(text)) {console.log('Looking for business with number:', process.env.TWILIO_PHONE_NUMBER);
      const business = db.prepare('SELECT * FROM businesses WHERE twilio_number = ?')
        .get(process.env.TWILIO_PHONE_NUMBER);

      if (!business) {
        await sendSMS(From, `A team member will reach out shortly to schedule your appointment.`);
        return res.status(200).send('<Response></Response>');
      }

      // Use Claude to extract date/time preference
      let intent = { intent: 'book', time_preference: null, preferred_date: null };
      try {
        intent = await detectBookingIntent(text, convo);
      } catch (err) {
        console.error('Intent detection failed:', err);
      }

      const today = new Date();
      let targetDate = intent.preferred_date ||
        new Date(today.setDate(today.getDate() + 1)).toISOString().split('T')[0];

      let slots = getAvailableSlots(business.id, targetDate);

      if (intent.time_preference === 'morning') {
        slots = slots.filter(s => s.start.getHours() < 12);
      } else if (intent.time_preference === 'afternoon') {
        slots = slots.filter(s => s.start.getHours() >= 12 && s.start.getHours() < 17);
      } else if (intent.time_preference === 'evening') {
        slots = slots.filter(s => s.start.getHours() >= 17);
      }

      if (slots.length === 0) {
        const available = getNextAvailableDays(business.id, 7);
        if (available.length === 0) {
          await sendSMS(From, `We don't have any openings in the next week. A team member will call you to schedule.`);
        } else {
          const next = available[0];
          const offered = next.slots.slice(0, 3);
          const dateLabel = formatDate(next.date);
          const options = offered.map((s, i) => `${i + 1}) ${s.label}`).join(', ');

          appendToConversation(lead.id, 'system', JSON.stringify({
            pendingSlots: offered.map(s => ({ ...s, start: s.start.toISOString(), end: s.end.toISOString() })),
            date: next.date,
            businessId: business.id
          }));

          await sendSMS(From, `We're next available on ${dateLabel}: ${options}. Reply 1, 2, or 3 to confirm.`);
        }
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

    } else if (text.toLowerCase().includes('reschedule')) {
      const appt = getAppointmentByPhone(From);
      if (!appt) {
        await sendSMS(From, `We don't see an active appointment. Would you like to book one?`);
      } else {
        cancelAppointment(appt.id);
        await sendSMS(From, `Got it — let's find you a new time. What day works best?`);
      }

    } else {
      await sendSMS(From, `Would you like to book an appointment? Just let us know what day works for you.`);
    }
  }

  res.status(200).send('<Response></Response>');
});

module.exports = router;