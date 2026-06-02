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
  const hoursInfo = business.hours_description || 'Monday to Friday, 9am to 5pm';

  const slotsText = availableSlots && availableSlots.length > 0
    ? `Available appointment slots: ${availableSlots.map((s, i) => `${i + 1}) ${s.label}`).join(', ')}`
    : null;

  const systemPrompt = `You are an AI receptionist for ${business.name}. You handle missed call follow-ups via SMS.

BUSINESS INFORMATION:
${businessInfo}

Business hours: ${hoursInfo}

YOUR ROLE:
- You are friendly, professional, and helpful
- You respond via SMS so keep messages concise (under 160 characters when possible)
- Your goal is to help the customer and book appointments when appropriate
- You represent the business professionally at all times

WHAT YOU CAN DO:
- Answer questions about the business using the business information above
- Help customers book appointments
- Collect customer name and reason for calling naturally in conversation
- Handle cancellations and rescheduling
- For anything you don't know (specific pricing not listed, specific staff, etc.) say "A team member will follow up with you on that"

APPOINTMENT BOOKING:
${slotsText ? `When a customer wants to book, offer these slots: ${slotsText}. Ask them to reply with 1, 2, or 3.` : 'If a customer wants to book, ask what day and time works for them.'}

IMPORTANT RULES:
- Never make up information not in the business information section
- Never promise specific prices unless listed in business information
- Always be warm and empathetic — the customer missed getting through
- If someone says wrong number, apologize and end the conversation politely
- Keep SMS responses short and conversational
- Never use bullet points or long lists in SMS

CONVERSATION HISTORY:
${conversationHistory.map(m => `${m.role === 'customer' ? 'Customer' : 'You'}: ${m.body}`).filter(m => !m.includes('"pendingSlots"')).join('\n')}

Customer's latest message: "${customerMessage}"

Respond naturally as the AI receptionist. Be concise for SMS.`;

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