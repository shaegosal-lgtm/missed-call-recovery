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

  const alreadySaidFollowUp = filteredHistory.toLowerCase().includes('team member') ||
    filteredHistory.toLowerCase().includes('follow up') ||
    filteredHistory.toLowerCase().includes('get back to you') ||
    filteredHistory.toLowerCase().includes('be in touch');

  const systemPrompt = `You are an automated SMS assistant for ${business.name} following up on a missed call.

BUSINESS INFORMATION:
${businessInfo}

WHAT YOU KNOW ABOUT THIS CUSTOMER:
- Phone: ${lead.phone} (never ask for this)
- Name: ${lead.name || 'not yet collected'}
- Reason for calling: ${lead.reason || 'not yet collected'}

RULES:
1. No emojis. Professional and warm tone.
2. Under 160 characters per message.
3. One question per message only.
4. Never mention specific times or available slots — the booking system handles that.
5. Never ask for their phone number — you have it.
6. Never repeat yourself.
7. Never use bullet points or lists.
8. Speak naturally and warmly.
9. For anything not in the business information above, say "I will have someone from our team reach out to you about that" — but only say this ONCE. ${alreadySaidFollowUp ? 'You have already said this. Do NOT say it again. Instead ask if they would like to book an appointment.' : ''}
10. Never ask for a name unless the customer has already confirmed a booking.
11. After telling the customer a team member will follow up on something, always follow up with "Would you like to book an appointment in the meantime?"
12. If the customer declines to book, end warmly: "No problem, a team member will be in touch shortly."
13. If the business information answers their question — answer it directly, then ask if they would like to book.
14. If the customer wants to book — ask "What day works best for you?" and nothing else about times.
15. CRITICAL: If a customer asks to speak to a human or a real person, never claim to be human. Say "This is an automated assistant. A team member will call you back shortly. Would you like to book an appointment in the meantime?"
16. Never lie or mislead the customer about being an AI or automated system.

CONVERSATION SO FAR:
${filteredHistory}

Customer: "${customerMessage}"

Your reply (one short natural message, no emojis):`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: systemPrompt }],
  });

  return response.content[0].text.trim();
}

async function analyzeIntent(message, conversationHistory) {
  const today = new Date();
  const todayStr = today.toISOString().split('T')[0];
  const dayName = today.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase();

  const prompt = `Analyze this SMS message from a customer contacting a business after a missed call.

Today is ${dayName}, ${todayStr}.

Message: "${message}"
Recent conversation: ${JSON.stringify(conversationHistory.slice(-6))}

Return ONLY this JSON with no explanation or markdown:
{
  "wants_to_book": true or false,
  "wants_to_cancel": true or false,
  "wants_to_reschedule": true or false,
  "selecting_slot": true or false,
  "slot_number": 1 or 2 or 3 or null,
  "preferred_day": "monday/tuesday/wednesday/thursday/friday/saturday/sunday/tomorrow/today or null",
  "preferred_date": "YYYY-MM-DD or null",
  "time_preference": "morning/afternoon/evening or null",
  "is_wrong_number": true or false,
  "has_name": true or false,
  "name": "extracted name or null",
  "is_next_week": true or false
}

IMPORTANT DATE RULES:
- If message says "next [day]" (e.g. "next tuesday"), set is_next_week: true and preferred_day to the day name. Do NOT calculate the date yourself.
- If message says just "[day]" without "next" (e.g. "tuesday"), set is_next_week: false and preferred_day to the day name.
- Only set preferred_date for specific calendar dates like "June 23rd", "the 23rd", not for day names.
- wants_to_book = true if customer mentions any day, date, time, or wanting to schedule.
- selecting_slot = true if message is 1, 2, or 3 AND slots were recently offered in conversation.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 250,
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
      preferred_date: null,
      time_preference: null,
      is_wrong_number: false,
      has_name: false,
      name: null,
      is_next_week: false
    };
  }
}

module.exports = { classifyLead, getReceptionistResponse, analyzeIntent };