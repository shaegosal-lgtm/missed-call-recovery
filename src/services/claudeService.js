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
    filteredHistory.toLowerCase().includes('get back to you');

  const hasName = !!lead.name;
  const hasReason = !!lead.reason;

  const systemPrompt = `You are a professional receptionist for ${business.name} following up on a missed call via SMS.

BUSINESS INFORMATION:
${businessInfo}

WHAT YOU KNOW ABOUT THIS CUSTOMER:
- Phone: ${lead.phone} (never ask for this)
- Name: ${hasName ? lead.name : 'not yet collected'}
- Reason for calling: ${hasReason ? lead.reason : 'not yet collected'}

YOUR GOAL: Collect their name and reason if missing, then move them toward booking an appointment.

CONVERSATION FLOW:
1. If you don't have their name — ask for it
2. If you have their name but not their reason — ask what you can help them with
3. If you have both — ask what day works best for them to come in
4. Never ask multiple questions at once

HOW TO HANDLE QUESTIONS YOU CANNOT ANSWER:
- If the business info above answers it — answer it
- If it does NOT answer it — say "I'll have someone from our team reach out to you about that" ONCE and move on
- ${alreadySaidFollowUp ? 'You have ALREADY told them someone will reach out. Do NOT say it again. Instead move forward and ask what day works for an appointment.' : 'You may say this once if needed.'}

RULES:
1. No emojis. Professional and warm tone.
2. Under 160 characters per message.
3. One question per message only.
4. Never mention specific times or available slots — the booking system handles that.
5. If they want to book, ask "What day works best for you?"
6. Never ask for their phone number — you have it.
7. Never repeat yourself.
8. Never use bullet points or lists.
9. Speak naturally — like a real receptionist, not a robot.

CONVERSATION SO FAR:
${filteredHistory}

Customer: "${customerMessage}"

Your reply (one short natural message):`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: systemPrompt }],
  });

  return response.content[0].text.trim();
}

async function analyzeIntent(message, conversationHistory) {
  const prompt = `Analyze this SMS message from a customer contacting a business after a missed call.

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
  "preferred_date": "YYYY-MM-DD or null if no specific date mentioned",
  "time_preference": "morning/afternoon/evening or null",
  "is_wrong_number": true or false,
  "has_name": true or false,
  "name": "extracted name or null"
}

Notes:
- wants_to_book = true if customer mentions any day, date, time preference, or wanting to come in/schedule/book
- selecting_slot = true if message is 1, 2, or 3 AND slots were recently offered in conversation
- For preferred_date: convert specific dates like "June 1st", "the 15th", "next Monday" to YYYY-MM-DD format using current year 2026
- preferred_day is for general day names only (monday, tuesday etc), preferred_date is for specific calendar dates`;

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
      name: null
    };
  }
}

module.exports = { classifyLead, getReceptionistResponse, analyzeIntent };