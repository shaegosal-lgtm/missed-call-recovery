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
          description: 'The date to check in YYYY-MM-DD format. Calculate this based on what the customer said.'
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
  }
];

// Server-side cache mapping slot_id -> real ISO timestamp, scoped per conversation turn
// This guarantees Claude can never type out or corrupt a timestamp itself
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

async function classifyLead(phone, reason) {
  const prompt = `You are helping a small appointment-based business qualify missed call leads.

A customer called and didn't get through. They texted back with this reason: "${reason}"
Their phone number is: ${phone}

Respond ONLY with a valid JSON object (no markdown, no explanation) in this exact format:
{
  "urgency": "low" | "medium" | "high",
  "lead_type": "new_patient" | "existing" | "appointment" | "billing" | "other",
  "summary": "one sentence for the front desk describing this lead"
}

Urgency guide: high = pain/emergency/urgent, medium = wants appointment soon, low = general inquiry.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { urgency: 'medium', lead_type: 'other', summary: reason };
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

  const filteredHistory = conversationHistory
    .filter(m => m.role === 'customer' || m.role === 'assistant')
    .map(m => ({
      role: m.role === 'customer' ? 'user' : 'assistant',
      content: m.body
    }));

  const leadWasAlreadyScheduled = lead.status === 'scheduled';

  const systemPrompt = `You are an automated AI receptionist for ${business.name}, a service business. You communicate with customers via SMS after they had a missed call.

TODAY'S DATE: ${dayName}, ${todayStr}

BUSINESS INFORMATION:
${businessInfo}

WHAT YOU KNOW ABOUT THIS CUSTOMER:
- Phone: ${lead.phone} (never ask for this)
- Reason for calling: ${lead.reason || 'not yet known'}
${leadWasAlreadyScheduled ? '- This customer ALREADY HAS A CONFIRMED APPOINTMENT booked from earlier in this conversation. Do not re-book, do not act unsure about whether it is confirmed, and do not call check_availability or book_appointment again unless they explicitly ask to reschedule or book an additional appointment. If they ask general questions, just answer them normally - their appointment remains confirmed regardless.' : ''}

CRITICAL GROUNDING RULE:
You must NEVER state a specific date, time, confirmation code, "booked", "confirmed", "cancelled", or "saved" status unless you JUST received that EXACT information back from a tool result earlier in THIS SAME response chain, OR it was already established as fact earlier in the conversation. Never guess, estimate, restate from memory incorrectly, infer, or fabricate any of these details. When stating a confirmation code, copy it EXACTLY character-for-character from the tool result.

SLOT BOOKING RULE - VERY IMPORTANT:
When you call book_appointment, you MUST use the exact slot_id value from a previous check_availability result - never type out a date/time yourself as the identifier. Each available time slot has a slot_id like "slot_a8x92k1m" - use that exact value, matched to the label/time the customer confirmed. Never construct, guess, or modify a slot_id.

ADDRESS HANDLING:
When you call book_appointment, the result may include "address_carried_over": true and "carried_over_address" if this customer had a previous address on file. If so, do NOT ask for the address again - just confirm it naturally. If address_carried_over is false, you must ask for the address before giving the confirmation code.

CORE BEHAVIOR RULES:
1. Be warm, concise, and natural - like a real, competent receptionist texting back. No corporate jargon.
2. Keep messages under 320 characters. Be concise.
3. No emojis.
4. One question at a time.
5. When a customer wants to book: figure out the actual date using today's date above, then call check_availability. Never state times without calling this tool first.
6. Present at most 3 options using the EXACT wording/times the tool returned.
7. If the customer rejects options or wants different times, call check_availability again with adjusted parameters. Keep trying reasonable alternatives before giving up.
8. Once the customer confirms a specific slot, call book_appointment with the matching slot_id from the check_availability result you showed them.
9. After book_appointment succeeds, check if address_carried_over is true. If false, ask for the service address BEFORE mentioning any confirmation code. If true, mention the carried-over address naturally and proceed straight to the confirmation code.
10. When the customer gives a NEW address, call save_customer_info, then state the confirmation code EXACTLY as returned, and the appointment time EXACTLY as returned in appointment_label.
11. If the customer prefers a callback instead of an address, call flag_needs_followup, then state the confirmation code exactly as returned.
12. If the customer wants to cancel, call cancel_appointment, then only confirm cancellation if the tool result shows success:true.
13. For questions answerable from business information, answer directly.
14. For anything you cannot answer, call flag_needs_followup, then let them know a team member will follow up.
15. Never claim to be human if asked.
16. Never repeat a message already sent in this conversation.
17. Acknowledge urgency briefly, then prioritize booking quickly.
18. If a customer already has a confirmed appointment and asks something unrelated, just answer naturally - never imply their existing appointment might not be confirmed.

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

  const claimsNewConfirmation = /your appointment is confirmed|you'?re booked in for|confirmation code\s*(?:is|:)/i.test(finalText);

  if (claimsNewConfirmation && !verifiedFacts.bookedThisTurn && !leadAlreadyScheduled) {
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

  // Verify the stated appointment time matches the real verified label - catches any remaining drift
  if (!guardrailTriggered && verifiedFacts.bookedThisTurn && verifiedFacts.appointmentLabel) {
    const timeWordsInLabel = verifiedFacts.appointmentLabel.match(/\d{1,2}:\d{2}\s*[AP]M/i);
    if (timeWordsInLabel) {
      const realTime = timeWordsInLabel[0].toUpperCase().replace(/\s/g, '');
      const allTimesInText = finalText.match(/\d{1,2}:\d{2}\s*[AP]M/gi) || [];
      const hasMismatch = allTimesInText.some(t => t.toUpperCase().replace(/\s/g, '') !== realTime);
      if (hasMismatch) {
        console.error(`[GUARDRAIL] lead=${lead.id} Time mismatch detected. Real time: ${realTime}, text contains: ${allTimesInText.join(', ')}`);
        updateLead(lead.id, { status: 'needs_followup' });
        guardrailTriggered = true;
      }
    }
  }

  const claimsCancellation = /has been cancelled|cancelled your appointment|appointment is cancelled/i.test(finalText);
  if (!guardrailTriggered && claimsCancellation && !verifiedFacts.cancelledThisTurn) {
    console.error(`[GUARDRAIL] lead=${lead.id} Claude claimed cancellation with no verified tool result. Text was: "${finalText}"`);
    finalText = verifiedFacts.cancelFailed
      ? "I couldn't find an active appointment to cancel under this number. A team member will follow up to confirm."
      : "Let me process that cancellation - a team member will confirm shortly.";
    updateLead(lead.id, { status: 'needs_followup' });
    guardrailTriggered = true;
  }

  const claimsAddressSaved = /address on file|we have your address|address is saved/i.test(finalText);
  if (!guardrailTriggered && claimsAddressSaved && !verifiedFacts.addressSavedThisTurn && !verifiedFacts.addressCarriedOverThisTurn && !leadAlreadyScheduled) {
    console.error(`[GUARDRAIL] lead=${lead.id} Claude claimed address saved with no verified tool result. Text was: "${finalText}"`);
    updateLead(lead.id, { status: 'needs_followup' });
    guardrailTriggered = true;
  }

  if (guardrailTriggered) {
    console.error(`[GUARDRAIL_SUMMARY] lead=${lead.id} A guardrail was triggered this turn - flagged for manual review.`);
  }

  return finalText;
}

module.exports = { classifyLead, runReceptionistConversation };