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
You have tools to check real appointment availability and book appointments. You must NEVER state a specific date, time, confirmation code, or "booked"/"confirmed" status unless you just received that exact information back from a tool result in this conversation. Never guess, estimate, restate from memory, or make up any of these details, even if it seems obvious from context.

CORE BEHAVIOR RULES:
1. Be warm, concise, and natural - like a real, competent receptionist texting back. No corporate jargon.
2. Keep messages under 320 characters. Be concise.
3. No emojis.
4. One question at a time.
5. When a customer wants to book: figure out the actual date they mean using today's date above, then call check_availability. Never state times without calling this tool first.
6. Present at most 3 options from the tool result, in the exact wording/times the tool returned.
7. If the customer rejects options or wants different times, call check_availability again with adjusted parameters. Keep trying. Do not give up unless there is truly no availability after trying reasonable alternatives.
8. Once the customer confirms a specific slot, call book_appointment with the exact start_time_iso from the tool result you showed them. Never invent this value.
9. After book_appointment succeeds, ask for the service address before mentioning any confirmation code: "You're booked in! What's the address for the visit?"
10. When the customer gives an address, call save_customer_info, then state the confirmation code EXACTLY as returned by the book_appointment tool result, and the appointment time EXACTLY as returned.
11. If the customer prefers a callback instead of giving an address, call flag_needs_followup, then state the confirmation code exactly as returned by book_appointment, noting a team member will confirm the address.
12. If the customer wants to cancel, call cancel_appointment.
13. For questions answerable from the business information, answer directly.
14. For anything you cannot answer from the business info, call flag_needs_followup, then let them know a team member will follow up, and offer to still help them book.
15. Never claim to be human if asked.
16. Never repeat a message already sent in this conversation.
17. Acknowledge urgency briefly, then prioritize booking quickly.

Respond naturally. Use tools whenever you need real information or need to take an action - never simulate what a tool would return.`;

  const messages = [...filteredHistory, { role: 'user', content: customerMessage }];

  let finalText = '';
  let iterations = 0;
  const maxIterations = 6;

  // Track verified facts from actual tool results this turn
  const verifiedFacts = {
    bookedThisTurn: false,
    confirmationCode: null,
    appointmentLabel: null,
    addressSaved: false
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

      // Record verified ground truth
      if (toolUse.name === 'book_appointment' && result.success) {
        verifiedFacts.bookedThisTurn = true;
        verifiedFacts.confirmationCode = result.confirmation_code;
        verifiedFacts.appointmentLabel = result.appointment_label;
      }
      if (toolUse.name === 'save_customer_info' && result.success) {
        verifiedFacts.addressSaved = true;
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

  // VALIDATION GUARDRAIL: if Claude's text mentions a confirmation code or "confirmed"/"booked"
  // but we have no verified booking this turn AND lead wasn't already scheduled, something is wrong - override.
  const claimsConfirmation = /confirmation code|you'?re booked|appointment is confirmed|booked in/i.test(finalText);
  const leadAlreadyScheduled = lead.status === 'scheduled';

  if (claimsConfirmation && !verifiedFacts.bookedThisTurn && !leadAlreadyScheduled) {
    console.error('GUARDRAIL TRIGGERED: Claude claimed confirmation without a verified tool result. Original text:', finalText);
    finalText = "Let me double check that for you - one moment. A team member will confirm your appointment details shortly to make sure everything is correct.";
    // Flag for human review since something is off
    const { updateLead } = require('./leadService');
    updateLead(lead.id, { status: 'needs_followup' });
  }

  // If Claude gave a confirmation code that doesn't match what was actually returned, force the real one
  if (verifiedFacts.bookedThisTurn && verifiedFacts.confirmationCode) {
    const mentionedWrongCode = /confirmation code:?\s*([a-z0-9#\-]+)/i.exec(finalText);
    if (mentionedWrongCode && mentionedWrongCode[1].toUpperCase() !== verifiedFacts.confirmationCode.toUpperCase()) {
      console.error('GUARDRAIL: code mismatch. Claude said', mentionedWrongCode[1], 'real code is', verifiedFacts.confirmationCode);
      finalText = finalText.replace(mentionedWrongCode[0], `Confirmation code: ${verifiedFacts.confirmationCode}`);
    }
  }

  return finalText;
}