const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

async function classifyLead(phone, reason) {
  const prompt = `You are helping a small appointment-based business (like a dental office, salon, or clinic) qualify missed call leads.

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

async function detectBookingIntent(message, conversationHistory) {
  const prompt = `You are an AI assistant for an appointment-based business handling SMS conversations.

Analyze this customer message and determine their intent. Be GENEROUS in interpreting booking intent — if someone mentions a day, time, or time of day (like "tomorrow", "monday", "afternoon", "morning") they almost certainly want to book.

Customer message: "${message}"
Recent conversation: ${JSON.stringify(conversationHistory.slice(-4))}

Respond ONLY with valid JSON in this exact format:
{
  "intent": "book" | "reschedule" | "cancel" | "check_availability" | "confirm" | "decline" | "other",
  "preferred_date": "YYYY-MM-DD or null",
  "preferred_time": "HH:MM in 24hr format or null",
  "time_preference": "morning" | "afternoon" | "evening" | null,
  "selected_slot_index": "0-based index if customer picked from a list, otherwise null",
  "confidence": "high" | "medium" | "low"
}

Examples:
- "tomorrow afternoon" → intent: "book", time_preference: "afternoon"
- "monday morning" → intent: "book", time_preference: "morning"  
- "I want to come in" → intent: "book"
- "can I book for next week" → intent: "book"
- "yes" or "1" or "2" or "3" → intent: "confirm"
- "cancel my appointment" → intent: "cancel"
- "reschedule" → intent: "reschedule"`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }],
  });

  try {
    return JSON.parse(response.content[0].text);
  } catch {
    return { intent: 'other', confidence: 'low' };
  }
}

module.exports = { classifyLead, detectBookingIntent };