const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

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

async function getReceptionistResponse(business, lead, conversationHistory, customerMessage) {
  const businessInfo = business.business_info || 'No specific business information provided.';

  const filteredHistory = conversationHistory
    .filter(m => !m.body.includes('"pendingSlots"'))
    .map(m => `${m.role === 'customer' ? 'Customer' : 'You'}: ${m.body}`)
    .join('\n');

  const systemPrompt = `You are a professional AI receptionist handling missed call follow-ups via SMS for ${business.name}.

BUSINESS INFORMATION:
${businessInfo}

STRICT RULES — never break these:
1. NEVER mention specific times, dates, or appointment slots. You do not have access to the schedule.
2. NEVER confirm, suggest, or imply that any specific time is available.
3. If a customer asks about availability or wants to book, say "What day works best for you?" and nothing more about times.
4. The booking system will handle all scheduling automatically after the customer states a day.
5. No emojis ever. Professional tone only.
6. Keep every message under 160 characters.
7. Never repeat something already said in this conversation.
8. Ask only one question per message.
9. For anything not in the business information, say "A team member will follow up with you on that."
10. Never make up prices, services, or details not listed in the business information.
11. If someone says wrong number, apologize briefly and stop responding.
12. Be warm but concise — this is SMS.
13. Never use bullet points or numbered lists.

CONVERSATION SO FAR:
${filteredHistory}

Customer just said: "${customerMessage}"

Reply as the receptionist. One short message. No emojis. No times or dates. Professional.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: systemPrompt }],
  });

  return response.content[0].text.trim();
}

async function analyzeIntent(message, conversationHistory) {
  const prompt = `Analyze this SMS message from a customer and return ONLY a JSON object.

Message: "${message}"
Recent conversation: ${JSON.stringify(conversationHistory.slice(-6))}

Return ONLY this JSON with no explanation:
{
  "wants_to_book": true or false,
  "wants_to_cancel": true or false,
  "wants_to_reschedule": true or false,
  "selecting_slot": true or false,
  "slot_number": 1 or 2 or 3 or null,
  "preferred_day": "monday/tuesday/wednesday/thursday/friday/tomorrow/today or null",
  "time_preference": "morning/afternoon/evening or null",
  "is_wrong_number": true or false,
  "has_name": true or false,
  "name": "extracted name or null"
}

Rules for wants_to_book: set true if customer mentions any day, time, or expresses desire to come in or schedule anything.
Rules for selecting_slot: set true if message is just a number 1, 2, or 3 and conversation shows slots were recently offered.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return {
      wants_to_book: false,
      wants_to_cancel: false,
      wants_to_reschedule: false,
      selecting_slot: false,
      slot_number: null,
      preferred_day: null,
      time_preference: null,
      is_wrong_number: false,
      has_name: false,
      name: null
    };
  }
}

module.exports = { classifyLead, getReceptionistResponse, analyzeIntent };