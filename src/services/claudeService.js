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

async function getReceptionistResponse(business, lead, conversationHistory, customerMessage, availableSlots) {
  const businessInfo = business.business_info || 'No specific business information provided.';

  const slotsText = availableSlots && availableSlots.length > 0
    ? `Available appointment slots: ${availableSlots.map((s, i) => `${i + 1}) ${s.label}`).join(', ')}`
    : null;

  const filteredHistory = conversationHistory
    .filter(m => !m.body.includes('"pendingSlots"'))
    .map(m => `${m.role === 'customer' ? 'Customer' : 'You'}: ${m.body}`)
    .join('\n');

  const systemPrompt = `You are a professional AI receptionist handling missed call follow-ups via SMS for ${business.name}.

BUSINESS INFORMATION:
${businessInfo}

YOUR RULES — follow these exactly:
1. No emojis ever. This is a professional business.
2. Keep every message under 160 characters when possible.
3. Never repeat information you already said in this conversation.
4. When booking, always ask for the DAY first, then the time preference after they answer.
5. Never ask two questions in one message — one question at a time only.
6. For anything not in the business information, say "A team member will follow up with you on that."
7. Never make up prices, services, or details not listed above.
8. If someone says wrong number, apologize briefly and end the conversation.
9. Be warm but concise — this is SMS, not email.
10. Never use bullet points or numbered lists in your responses.

${slotsText ? `AVAILABLE SLOTS TO OFFER: ${slotsText}. If offering slots, ask the customer to reply with 1, 2, or 3.` : ''}

CONVERSATION SO FAR:
${filteredHistory}

Customer just said: "${customerMessage}"

Reply as the receptionist. One short message only. No emojis. Professional tone.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 300,
    messages: [{ role: 'user', content: systemPrompt }],
  });

  return response.content[0].text.trim();
}

async function analyzeIntent(message, conversationHistory) {
  const prompt = `Analyze this SMS message from a customer and return ONLY a JSON object.

Message: "${message}"
Recent conversation: ${JSON.stringify(conversationHistory.slice(-4))}

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
}`;

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