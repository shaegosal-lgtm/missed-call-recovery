const Anthropic = require('@anthropic-ai/sdk');
const {
  getAvailableSlots,
  getNextAvailableDays,
  bookAppointment,
  cancelAppointment,
  getAppointmentByPhone,
  formatDate,
} = require('./schedulingService');
const { updateLead } = require('./leadService');
const db = require('../db/db');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const TOOLS = [
  {
    name: 'check_availability',
    description: 'Check real available appointment slots for a specific date. Always use this before telling a customer about availability - never guess or make up times. Returns up to 5 available time slots, each with a slot_id you must use later to book.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'The date to check in YYYY-MM-DD format. You MUST copy this exactly from the DATE LOOKUP TABLE provided in your instructions - never calculate this yourself.'
        },
        time_of_day: {
          type: 'string',
          enum: ['morning', 'afternoon', 'evening', 'any'],
          description: 'Filter by time of day if specified, otherwise "any".'
        }
      },
      required: ['date', 'time_of_day']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a specific appointment slot using its slot_id. You must use the exact slot_id returned by a previous check_availability call for the slot the customer chose - never type out or guess a timestamp yourself.',
    input_schema: {
      type: 'object',
      properties: {
        slot_id: {
          type: 'string',
          description: 'The exact slot_id value from a previous check_availability result, corresponding to the time the customer confirmed.'
        }
      },
      required: ['slot_id']
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel the customer\'s existing appointment.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'save_customer_info',
    description: 'Save the customer service address when they provide it.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'The full service address.' }
      },
      required: ['address']
    }
  },
  {
    name: 'flag_needs_followup',
    description: 'Flag this conversation as needing human follow-up. Use only when something genuinely cannot be handled.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Brief reason for follow-up.' }
      },
      required: ['reason']
    }
  },
  {
    name: 'mark_conversation_closed',
    description: 'Mark this conversation as closed/resolved with no further action needed. Call this ONLY when the customer has clearly declined service and is not booking an appointment (e.g. "not interested", "no thanks", "I found someone else", "just wanted pricing, that\'s it"). Do not call this if they might still want to book, or if a human needs to follow up with them.',
    input_schema: { type: 'object', properties: {} }
  }
];

const slotCache = new Map();

function cacheSlot(leadId, isoString) {
  const slotId = `slot_${Math.random().toString(36).substring(2, 10)}`;
  const key = `${leadId}:${slotId}`;
  slotCache.set(key, isoString);
  return slotId;
}

function resolveSlot(leadId, slotId) {
  const key = `${leadId}:${slotId}`;
  return slotCache.get(key) || null;
}

function buildDateLookupTable() {
  const today = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const lines = [];

  for (let i = 0; i <= 20; i++) {
    const d = new Date(today);
    d.setUTCDate(today.getUTCDate() + i);
    const dateStr = d.toISOString().split('T')[0];
    const dayName = dayNames[d.getUTCDay()];

    let label = `${dayName} ${dateStr}`;
    if (i === 0) label += ' (TODAY)';
    if (i === 1) label += ' (TOMORROW)';
    lines.push(label);
  }

  return lines.join('\n');
}

// Now takes the FULL conversation instead of a single message, for more meaningful urgency classification
async function classifyLead(phone, conversationHistory) {
  const convoText = conversationHistory
    .filter(m => m.role === 'customer' || m.role === 'assistant')
    .map(m => `${m.role === 'customer' ? 'Customer' : 'Receptionist'}: ${m.body}`)
    .join('\n');

  const prompt = `You are helping a small appointment-based business qualify a missed call lead based on their FULL conversation so far.

Phone: ${phone}

CONVERSATION:
${convoText}

Respond ONLY with a valid JSON object (no markdown, no explanation) in this exact format:
{
  "urgency": "low" | "medium" | "high",
  "lead_type": "new_patient" | "existing" | "appointment" | "billing" | "other",
  "summary": "one or two sentences for the front desk summarizing the full situation, not just the opening message"
}

URGENCY GUIDE - base this on the ENTIRE conversation, not just the first message:
- HIGH: genuine emergency, active damage/danger, customer expresses significant distress or time pressure, repeated urgency cues, safety issue
- MEDIUM: wants service relatively soon, mild inconvenience, no emergency language, standard scheduling request
- LOW: general inquiry, pricing question only, no clear timeline, browsing/considering, or customer seems to have lost interest

Consider tone, repeated frustration, explicit urgency language ("ASAP", "right now", "emergency", "flooding", "can't wait"), and how the conversation evolved - not just the first sentence.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 250,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { urgency: 'medium', lead_type: 'other', summary: convoText.slice(0, 150) };
  }
}

function logToolCall(leadId, toolName, input, result) {
  console.log(`[TOOL_CALL] lead=${leadId} tool=${toolName} input=${JSON.stringify(input)} result=${JSON.stringify(result)}`);
}

function findMostRecentAddressForPhone(phone) {
  const row = db.prepare(`
    SELECT a.service_address FROM appointments a
    JOIN leads l ON a.lead_id = l.id
    WHERE l.phone = ? AND a.service_address IS NOT NULL AND a.address_confirmed = 1
    ORDER BY a.created_at DESC LIMIT 1
  `).get(phone);
  return row ? row.service_address : null;
}

function executeToolCall(toolName, toolInput, context) {
  const { business, lead, From } = context;
  let result;

  if (toolName === 'check_availability') {
    const { date, time_of_day } = toolInput;
    let slots = getAvailableSlots(business.id, date);

    if (time_of_day === 'morning') slots = slots.filter(s => s.slotHour < 12);
    else if (time_of_day === 'afternoon') slots = slots.filter(s => s.slotHour >= 12 && s.slotHour < 17);
    else if (time_of_day === 'evening') slots = slots.filter(s => s.slotHour >= 17);

    if (slots.length === 0) {
      const available = getNextAvailableDays(business.id, 14);
      if (available.length === 0) {
        result = { available: false, message: 'No availability in the next two weeks.' };
      } else {
        const next = available[0];
        const offeredSlots = next.slots.slice(0, 5);
        result = {
          available: true,
          requested_date_had_availability: false,
          next_available_date: next.date,
          next_available_date_formatted: formatDate(next.date),
          slots: offeredSlots.map(s => ({
            slot_id: cacheSlot(lead.id, s.start.toISOString()),
            label: s.label
          }))
        };
      }
    } else {
      const offeredSlots = slots.slice(0, 5);
      result = {
        available: true,
        requested_date_had_availability: true,
        date_formatted: formatDate(date),
        slots: offeredSlots.map(s => ({
          slot_id: cacheSlot(lead.id, s.start.toISOString()),
          label: s.label
        }))
      };
    }
  } else if (toolName === 'book_appointment') {
    const realIso = resolveSlot(lead.id, toolInput.slot_id);
    if (!realIso) {
      result = { success: false, message: 'That slot reference is no longer valid. Please check availability again.' };
    } else {
      const bookResult = bookAppointment(business.id, lead.id, realIso);
      if (!bookResult.success) {
        result = { success: false, message: 'That slot was just taken by someone else.' };
      } else {
        updateLead(lead.id, { status: 'scheduled' });
        const startDate = new Date(realIso);
        const label = startDate.toLocaleString('en-US', {
          weekday: 'long', month: 'long', day: 'numeric',
          hour: 'numeric', minute: '2-digit',
          timeZone: 'UTC'
        });

        const carriedAddress = findMostRecentAddressForPhone(From);
        let addressCarriedOver = false;
        if (carriedAddress) {
          db.prepare('UPDATE appointments SET service_address = ?, address_confirmed = 1 WHERE id = ?')
            .run(carriedAddress, bookResult.appointmentId);
          addressCarriedOver = true;
        }

        result = {
          success: true,
          confirmation_code: bookResult.confirmationCode,
          appointment_label: label,
          address_carried_over: addressCarriedOver,
          carried_over_address: addressCarriedOver ? carriedAddress : null
        };
      }
    }
  } else if (toolName === 'cancel_appointment') {
    const appt = getAppointmentByPhone(From);
    if (!appt) {
      result = { success: false, message: 'No active appointment found for this customer.' };
    } else {
      cancelAppointment(appt.id);
      result = { success: true };
    }
  } else if (toolName === 'save_customer_info') {
    const appt = getAppointmentByPhone(From);
    if (appt) {
      db.prepare('UPDATE appointments SET service_address = ?, address_confirmed = 1 WHERE id = ?')
        .run(toolInput.address, appt.id);
      result = { success: true };
    } else {
      result = { success: false, message: 'No active appointment found to attach address to.' };
    }
  } else if (toolName === 'flag_needs_followup') {
    updateLead(lead.id, { status: 'needs_followup' });
    result = { success: true, flagged: true };
  } else if (toolName === 'mark_conversation_closed') {
    updateLead(lead.id, { status: 'closed' });
    result = { success: true, closed: true };
  } else {
    result = { error: 'Unknown tool' };
  }

  logToolCall(lead.id, toolName, toolInput, result);
  return result;
}

async function runReceptionistConversation(business, lead, conversationHistory, customerMessage, From) {
  const businessInfo = business.business_info || 'No specific business information provided.';
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const dayName = today.toLocaleDateString('en-US', { weekday: 'long' });
  const dateLookupTable = buildDateLookupTable();

  const filteredHistory = conversationHistory
    .filter(m => m.role === 'customer' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'customer' ? 'user' : 'assistant',
      content: m.body
    }));

  const leadWasAlreadyScheduled = lead.status === 'scheduled';

  const systemPrompt = `You are an automated AI receptionist for ${business.name}, a service business. You communicate with customers via SMS after they had a missed call.

TODAY'S DATE: ${dayName}, ${todayStr}

DATE LOOKUP TABLE - YOU MUST USE THIS, NEVER CALCULATE DATES YOURSELF:
${dateLookupTable}

When a customer mentions a day, find the matching line in the table above and use that EXACT date string. If the customer says "next [day]", use the SECOND occurrence of that day name. If they just say a day name with no "next", use the FIRST occurrence.

BUSINESS INFORMATION:
${businessInfo}

WHAT YOU KNOW ABOUT THIS CUSTOMER:
- Phone: ${lead.phone} (never ask for this)
- Reason for calling: ${lead.reason || 'not yet known'}
${leadWasAlreadyScheduled ? '- This customer ALREADY HAS A CONFIRMED APPOINTMENT booked from earlier in this conversation. Do not re-book, do not act unsure about whether it is confirmed, and do not call check_availability or book_appointment again unless they explicitly ask to reschedule or book an additional appointment. If they ask general questions, just answer them normally - their appointment remains confirmed regardless.' : ''}

CRITICAL GROUNDING RULE:
You must NEVER state a specific date, time, confirmation code, "booked", "confirmed", "cancelled", or "saved" status unless you JUST received that EXACT information back from a tool result earlier in THIS SAME response chain, OR it was already established as fact earlier in the conversation. Never guess, estimate, restate from memory incorrectly, infer, or fabricate any of these details.

SLOT BOOKING RULE:
When you call book_appointment, you MUST use the exact slot_id value from a previous check_availability result.

ADDRESS HANDLING:
When you call book_appointment, the result may include "address_carried_over": true and "carried_over_address". If so, do NOT ask for the address again. If false, ask for the address before giving the confirmation code.

CLOSING A CONVERSATION:
If the customer clearly declines service (says "not interested", "no thanks", "I'll go elsewhere", or similar, and is NOT booking an appointment), call mark_conversation_closed after responding warmly. Do not call this if they might still come back to book, or if you've flagged them for human follow-up - those stay open for the team.

CORE BEHAVIOR RULES:
1. Be warm, concise, and natural - like a real, competent receptionist texting back. No corporate jargon.
2. Keep messages under 320 characters. Be concise.
3. No emojis.
4. One question at a time.
5. When a customer wants to book: find the correct date using the DATE LOOKUP TABLE, then call check_availability.
6. Present at most 3 options using the EXACT wording/times the tool returned.
7. If the customer rejects options or wants different times, call check_availability again with adjusted parameters.
8. Once confirmed, call book_appointment with the matching slot_id.
9. After book_appointment succeeds, check address_carried_over - ask for address if false, otherwise proceed straight to confirmation code.
10. When the customer gives a NEW address, call save_customer_info, then state the confirmation code and time exactly as returned.
11. If the customer prefers a callback instead of an address, call flag_needs_followup, then state the confirmation code.
12. If the customer wants to cancel, call cancel_appointment, then only confirm if success:true.
13. For questions answerable from business information, answer directly.
14. For anything you cannot answer, call flag_needs_followup, then let them know a team member will follow up.
15. Never claim to be human if asked.
16. Never repeat a message already sent in this conversation.
17. Acknowledge urgency briefly, then prioritize booking quickly.
18. If a customer already has a confirmed appointment and asks something unrelated, just answer naturally.
19. If a customer's message contains multiple pieces of information at once, parse each piece separately, especially the requested day, using the DATE LOOKUP TABLE.

Respond naturally. Use tools whenever you need real information or need to take an action - never simulate what a tool would return.`;

  const messages = [...filteredHistory, { role: 'user', content: customerMessage }];

  let finalText = '';
  let iterations = 0;
  const maxIterations = 6;

  const verifiedFacts = {
    bookedThisTurn: false,
    confirmationCode: null,
    appointmentLabel: null,
    addressSavedThisTurn: false,
    addressSaveFailed: false,
    addressCarriedOverThisTurn: false,
    cancelledThisTurn: false,
    cancelFailed: false,
    lastCheckAvailabilityDate: null,
    lastCheckAvailabilityDateFormatted: null,
    closedThisTurn: false,
  };

  while (iterations < maxIterations) {
    iterations++;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 1024,
      system: systemPrompt,
      tools: TOOLS,
      messages,
    });

    const toolUseBlocks = response.content.filter(b => b.type === 'tool_use');
    const textBlocks = response.content.filter(b => b.type === 'text');

    if (toolUseBlocks.length === 0) {
      finalText = textBlocks.map(b => b.text).join(' ').trim();
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    const toolResults = [];
    for (const toolUse of toolUseBlocks) {
      const result = executeToolCall(toolUse.name, toolUse.input, { business, lead, From });

      if (toolUse.name === 'check_availability') {
        verifiedFacts.lastCheckAvailabilityDate = toolUse.input.date;
        verifiedFacts.lastCheckAvailabilityDateFormatted = result.date_formatted || result.next_available_date_formatted || null;
      }
      if (toolUse.name === 'book_appointment') {
        if (result.success) {
          verifiedFacts.bookedThisTurn = true;
          verifiedFacts.confirmationCode = result.confirmation_code;
          verifiedFacts.appointmentLabel = result.appointment_label;
          verifiedFacts.addressCarriedOverThisTurn = !!result.address_carried_over;
        }
      }
      if (toolUse.name === 'save_customer_info') {
        if (result.success) verifiedFacts.addressSavedThisTurn = true;
        else verifiedFacts.addressSaveFailed = true;
      }
      if (toolUse.name === 'cancel_appointment') {
        if (result.success) verifiedFacts.cancelledThisTurn = true;
        else verifiedFacts.cancelFailed = true;
      }
      if (toolUse.name === 'mark_conversation_closed') {
        verifiedFacts.closedThisTurn = true;
      }

      toolResults.push({
        type: 'tool_result',
        tool_use_id: toolUse.id,
        content: JSON.stringify(result)
      });
    }

    messages.push({ role: 'user', content: toolResults });

    if (response.stop_reason !== 'tool_use') {
      finalText = textBlocks.map(b => b.text).join(' ').trim();
      break;
    }
  }

  if (!finalText) {
    finalText = "Thanks for your patience! A team member will follow up with you shortly.";
  }

  // ===== GUARDRAIL VALIDATION LAYER =====
  let guardrailTriggered = false;
  const leadAlreadyScheduled = lead.status === 'scheduled';

  if (!guardrailTriggered && verifiedFacts.lastCheckAvailabilityDateFormatted && !verifiedFacts.bookedThisTurn) {
    const realDayMatch = verifiedFacts.lastCheckAvailabilityDateFormatted.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
    if (realDayMatch) {
      const realDay = realDayMatch[1];
      const dayPattern = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi;
      const daysInText = finalText.match(dayPattern) || [];
      const hasDayMismatch = daysInText.length > 0 && daysInText.some(d => d.toLowerCase() !== realDay.toLowerCase());
      if (hasDayMismatch) {
        console.error(`[GUARDRAIL] lead=${lead.id} Availability day mismatch BEFORE booking. Tool checked: ${realDay}, text says: ${daysInText.join(', ')}`);
        updateLead(lead.id, { status: 'needs_followup' });
        finalText = `Let me double check that for you - one moment. A team member will confirm available times shortly.`;
        guardrailTriggered = true;
      }
    }
  }

  const claimsNewConfirmation = /your appointment is confirmed|you'?re booked in for|confirmation code\s*(?:is|:)/i.test(finalText);

  if (!guardrailTriggered && claimsNewConfirmation && !verifiedFacts.bookedThisTurn && !leadAlreadyScheduled) {
    console.error(`[GUARDRAIL] lead=${lead.id} Claude claimed NEW booking confirmation with no verified tool result. Text was: "${finalText}"`);
    finalText = "Let me get that booked for you properly - one moment please.";
    updateLead(lead.id, { status: 'needs_followup' });
    guardrailTriggered = true;
  }

  if (!guardrailTriggered && verifiedFacts.bookedThisTurn && verifiedFacts.confirmationCode) {
    const codeMatch = /confirmation code\s*(?:is|:)?\s*#?([a-z0-9\-]+)/i.exec(finalText);
    if (codeMatch && codeMatch[1].toUpperCase().replace(/-/g, '') !== verifiedFacts.confirmationCode.toUpperCase().replace(/-/g, '')) {
      console.error(`[GUARDRAIL] lead=${lead.id} code mismatch. Claude said "${codeMatch[1]}", real code is "${verifiedFacts.confirmationCode}"`);
      finalText = finalText.replace(codeMatch[0], `confirmation code is ${verifiedFacts.confirmationCode}`);
      guardrailTriggered = true;
    } else if (!codeMatch) {
      console.error(`[GUARDRAIL] lead=${lead.id} Booking succeeded but no confirmation code was mentioned. Appending it.`);
      finalText = `${finalText} Your confirmation code is ${verifiedFacts.confirmationCode}.`;
      guardrailTriggered = true;
    }
  }

  if (!guardrailTriggered && verifiedFacts.bookedThisTurn && verifiedFacts.appointmentLabel) {
    const timeWordsInLabel = verifiedFacts.appointmentLabel.match(/\d{1,2}:\d{2}\s*[AP]M/i);
    if (timeWordsInLabel) {
      const realTime = timeWordsInLabel[0].toUpperCase().replace(/\s/g, '');
      const allTimesInText = finalText.match(/\d{1,2}:\d{2}\s*[AP]M/gi) || [];
      const hasTimeMismatch = allTimesInText.some(t => t.toUpperCase().replace(/\s/g, '') !== realTime);
      if (hasTimeMismatch) {
        console.error(`[GUARDRAIL] lead=${lead.id} Time mismatch detected.`);
        updateLead(lead.id, { status: 'needs_followup' });
        guardrailTriggered = true;
      }
    }

    if (!guardrailTriggered) {
      const realDayMatch = verifiedFacts.appointmentLabel.match(/^(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)/i);
      if (realDayMatch) {
        const realDay = realDayMatch[1];
        const dayPattern = /\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\b/gi;
        const daysInText = finalText.match(dayPattern) || [];
        const hasDayMismatch = daysInText.some(d => d.toLowerCase() !== realDay.toLowerCase());
        if (hasDayMismatch) {
          console.error(`[GUARDRAIL] lead=${lead.id} Day mismatch detected.`);
          updateLead(lead.id, { status: 'needs_followup' });
          guardrailTriggered = true;
        }
      }
    }
  }

  const claimsCancellation = /has been cancelled|cancelled your appointment|appointment is cancelled/i.test(finalText);
  if (!guardrailTriggered && claimsCancellation && !verifiedFacts.cancelledThisTurn) {
    console.error(`[GUARDRAIL] lead=${lead.id} Claude claimed cancellation with no verified tool result.`);
    finalText = verifiedFacts.cancelFailed
      ? "I couldn't find an active appointment to cancel under this number. A team member will follow up to confirm."
      : "Let me process that cancellation - a team member will confirm shortly.";
    updateLead(lead.id, { status: 'needs_followup' });
    guardrailTriggered = true;
  }

  const claimsAddressSaved = /address on file|we have your address|address is saved/i.test(finalText);
  if (!guardrailTriggered && claimsAddressSaved && !verifiedFacts.addressSavedThisTurn && !verifiedFacts.addressCarriedOverThisTurn && !leadAlreadyScheduled) {
    console.error(`[GUARDRAIL] lead=${lead.id} Claude claimed address saved with no verified tool result.`);
    updateLead(lead.id, { status: 'needs_followup' });
    guardrailTriggered = true;
  }

  if (guardrailTriggered) {
    console.error(`[GUARDRAIL_SUMMARY] lead=${lead.id} A guardrail was triggered this turn - flagged for manual review.`);
  }

  return finalText;
}

module.exports = { classifyLead, runReceptionistConversation };