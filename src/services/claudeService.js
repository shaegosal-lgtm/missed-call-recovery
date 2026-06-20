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
    description: 'Check real available appointment slots for a specific date. Always use this before telling a customer about availability - never guess or make up times. Returns up to 5 available time slots for that date, or the next available date if none are open.',
    input_schema: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'The date to check in YYYY-MM-DD format. Calculate this based on what the customer said (e.g. if they say "tuesday" figure out the actual upcoming Tuesday date, if "next tuesday" skip to the following week).'
        },
        time_of_day: {
          type: 'string',
          enum: ['morning', 'afternoon', 'evening', 'any'],
          description: 'Filter by time of day if the customer specified a preference, otherwise use "any".'
        }
      },
      required: ['date', 'time_of_day']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book a specific appointment slot for the customer. Only call this after the customer has explicitly confirmed a specific date and time that was returned from check_availability. Never call this with a time that was not confirmed available.',
    input_schema: {
      type: 'object',
      properties: {
        start_time_iso: {
          type: 'string',
          description: 'The exact ISO timestamp of the slot to book, taken directly from a previous check_availability result.'
        }
      },
      required: ['start_time_iso']
    }
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel the customer\'s existing appointment. Call this when the customer wants to cancel.',
    input_schema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'save_customer_info',
    description: 'Save the customer service address when they provide it. Call this as soon as the customer gives their address for the appointment.',
    input_schema: {
      type: 'object',
      properties: {
        address: {
          type: 'string',
          description: 'The full service address the customer provided.'
        }
      },
      required: ['address']
    }
  },
  {
    name: 'flag_needs_followup',
    description: 'Flag this conversation as needing human follow-up. Call this ONLY when the customer is asking something that genuinely cannot be answered with the business information provided, or explicitly wants to speak to a human, or the request is too complex for you to handle (e.g. complex pricing negotiations, complaints, multi-service requests). Do not call this for normal booking flow.',
    input_schema: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Brief reason why human follow-up is needed.'
        }
      },
      required: ['reason']
    }
  }
];

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

function executeToolCall(toolName, toolInput, context) {
  const { business, lead, From } = context;

  if (toolName === 'check_availability') {
    const { date, time_of_day } = toolInput;
    let slots = getAvailableSlots(business.id, date);

    if (time_of_day === 'morning') slots = slots.filter(s => s.slotHour < 12);
    else if (time_of_day === 'afternoon') slots = slots.filter(s => s.slotHour >= 12 && s.slotHour < 17);
    else if (time_of_day === 'evening') slots = slots.filter(s => s.slotHour >= 17);

    if (slots.length === 0) {
      const available = getNextAvailableDays(business.id, 14);
      if (available.length === 0) {
        return { available: false, message: 'No availability in the next two weeks.' };
      }
      const next = available[0];
      return {
        available: true,
        requested_date_had_availability: false,
        next_available_date: next.date,
        next_available_date_formatted: formatDate(next.date),
        slots: next.slots.slice(0, 5).map(s => ({
          start_time_iso: s.start.toISOString(),
          label: s.label
        }))
      };
    }

    return {
      available: true,
      requested_date_had_availability: true,
      date_formatted: formatDate(date),
      slots: slots.slice(0, 5).map(s => ({
        start_time_iso: s.start.toISOString(),
        label: s.label
      }))
    };
  }

  if (toolName === 'book_appointment') {
    const result = bookAppointment(business.id, lead.id, toolInput.start_time_iso);
    if (!result.success) {
      return { success: false, message: 'That slot was just taken by someone else.' };
    }
    updateLead(lead.id, { status: 'scheduled' });
    const startDate = new Date(toolInput.start_time_iso);
    const label = startDate.toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit'
    });
    return {
      success: true,
      confirmation_code: result.confirmationCode,
      appointment_label: label
    };
  }

  if (toolName === 'cancel_appointment') {
    const appt = getAppointmentByPhone(From);
    if (!appt) {
      return { success: false, message: 'No active appointment found for this customer.' };
    }
    cancelAppointment(appt.id);
    return { success: true };
  }

  if (toolName === 'save_customer_info') {
    const appt = getAppointmentByPhone(From);
    if (appt) {
      db.prepare('UPDATE appointments SET service_address = ?, address_confirmed = 1 WHERE id = ?')
        .run(toolInput.address, appt.id);
    }
    updateLead(lead.id, { status: 'scheduled' });
    return { success: true };
  }

  if (toolName === 'flag_needs_followup') {
    updateLead(lead.id, { status: 'needs_followup' });
    return { success: true, flagged: true };
  }

  return { error: 'Unknown tool' };
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

  const systemPrompt = `You are an automated AI receptionist for ${business.name}, a service business. You communicate with customers via SMS after they had a missed call.

TODAY'S DATE: ${dayName}, ${todayStr}

BUSINESS INFORMATION:
${businessInfo}

WHAT YOU KNOW ABOUT THIS CUSTOMER:
- Phone: ${lead.phone} (never ask for this)
- Reason for calling: ${lead.reason || 'not yet known'}

YOUR CAPABILITIES:
You have tools to check real appointment availability and book appointments. You must NEVER state a specific date or time unless you just received it from the check_availability tool. Never guess, estimate, or make up availability.

CORE BEHAVIOR RULES:
1. Be warm, concise, and natural - like a real, competent receptionist texting back. No corporate jargon.
2. Keep messages under 320 characters (about 2 SMS segments). Be concise.
3. No emojis.
4. One question at a time - never ask multiple things in one message.
5. When a customer wants to book: figure out what date they mean (convert relative dates like "tuesday", "next tuesday", "tomorrow", "asap" into an actual YYYY-MM-DD date using today's date above), then call check_availability.
6. Present at most 3 options clearly, e.g. "I have Tuesday at 9am, 11am, or 2pm - which works?"
7. If the customer rejects all options or asks for different times (later, earlier, different day, etc) - call check_availability again with adjusted parameters. Keep trying to find something that works. Do NOT give up and say "a team member will follow up" unless you have tried multiple reasonable options and the customer still cannot find anything that works, or there is truly no availability.
8. Once the customer agrees to a specific slot, call book_appointment immediately with that exact start_time_iso.
9. After successfully booking, before confirming, ask for the service address: "Great, you're booked in! What's the address for the visit?" Do NOT give the confirmation code yet.
10. When the customer gives an address, call save_customer_info, then give them the confirmation code and a warm confirmation message.
11. If the customer wants to skip giving an address and prefers a callback, that's fine - call flag_needs_followup with that reason, and let them know a team member will confirm the address before the visit, still giving them the confirmation code.
12. If the customer wants to cancel, call cancel_appointment.
13. For questions you can answer from the business information above, answer directly and naturally.
14. For questions you genuinely cannot answer from the business info (pricing not listed, complex multi-service requests, complaints, explicit requests for a human) - call flag_needs_followup and let the customer know a team member will be in touch, then offer to still help them book an appointment in the meantime if relevant.
15. Never claim to be a human if asked - be honest that you're an automated assistant, while remaining warm and helpful.
16. Never repeat a message you've already sent in this conversation.
17. If a customer seems to be in an urgent/emergency situation, acknowledge it briefly and prioritize getting them booked quickly.

Respond naturally as the receptionist. Use tools whenever you need real information or need to take an action - never simulate or guess what a tool would return.`;

  const messages = [...filteredHistory, { role: 'user', content: customerMessage }];

  let finalText = '';
  let iterations = 0;
  const maxIterations = 5;

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

  return finalText;
}

module.exports = { classifyLead, runReceptionistConversation };