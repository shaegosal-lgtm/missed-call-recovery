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

module.exports = { classifyLead };