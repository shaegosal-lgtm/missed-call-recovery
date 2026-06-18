const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendLeadNotification(business, lead, appointmentDetails = null) {
  if (!business.owner_email) return;

  const urgencyEmoji = {
    high: '🔴',
    medium: '🟡',
    low: '🟢',
    unknown: '⚪'
  };

  const subject = appointmentDetails
    ? `New Appointment Booked — ${lead.name || lead.phone}`
    : `New Lead — ${lead.name || lead.phone}`;

  const appointmentSection = appointmentDetails ? `
    <div style="background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;margin:16px 0;">
      <strong style="color:#16a34a;">✅ Appointment Booked</strong>
      <p style="margin:8px 0 0;color:#333;">${appointmentDetails}</p>
    </div>
  ` : '';

  const html = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
    </head>
    <body style="font-family:-apple-system,sans-serif;background:#f5f5f5;margin:0;padding:24px;">
      <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
        
        <div style="background:#0D1B2A;padding:24px 32px;">
          <div style="font-size:20px;font-weight:800;color:#fff;letter-spacing:-0.5px;">
            Missed<span style="color:#4A9FFF;">Pro</span>
          </div>
          <div style="font-size:13px;color:rgba(255,255,255,0.5);margin-top:4px;">
            ${business.name}
          </div>
        </div>

        <div style="padding:32px;">
          <h2 style="margin:0 0 4px;font-size:20px;color:#0D1B2A;font-weight:700;">
            New Lead Notification
          </h2>
          <p style="margin:0 0 24px;color:#64748b;font-size:14px;">
            A customer called and was assisted by your AI receptionist.
          </p>

          <div style="background:#f8fafc;border-radius:8px;padding:20px;margin-bottom:16px;">
            <table style="width:100%;border-collapse:collapse;">
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;width:120px;">Phone</td>
                <td style="padding:8px 0;font-size:14px;color:#0D1B2A;font-weight:600;">${lead.phone}</td>
              </tr>
              ${lead.name ? `
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Name</td>
                <td style="padding:8px 0;font-size:14px;color:#0D1B2A;font-weight:600;">${lead.name}</td>
              </tr>` : ''}
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Reason</td>
                <td style="padding:8px 0;font-size:14px;color:#0D1B2A;">${lead.reason || 'Not provided'}</td>
              </tr>
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;">Urgency</td>
                <td style="padding:8px 0;font-size:14px;color:#0D1B2A;">
                  ${urgencyEmoji[lead.urgency] || '⚪'} ${lead.urgency || 'Unknown'}
                </td>
              </tr>
              ${lead.ai_summary ? `
              <tr>
                <td style="padding:8px 0;font-size:13px;color:#64748b;vertical-align:top;">Summary</td>
                <td style="padding:8px 0;font-size:14px;color:#0D1B2A;">${lead.ai_summary}</td>
              </tr>` : ''}
            </table>
          </div>

          ${appointmentSection}

          <a href="https://missed-call-recovery-production-0d0b.up.railway.app/dashboard" 
             style="display:block;background:#1A6FDB;color:#fff;text-decoration:none;text-align:center;padding:14px;border-radius:8px;font-weight:600;font-size:15px;margin-top:8px;">
            View Full Conversation →
          </a>
        </div>

        <div style="padding:16px 32px;border-top:1px solid #f1f5f9;text-align:center;">
          <p style="margin:0;font-size:12px;color:#94a3b8;">
            Powered by MissedPro · <a href="mailto:support.missedpro@gmail.com" style="color:#94a3b8;">support.missedpro@gmail.com</a>
          </p>
        </div>

      </div>
    </body>
    </html>
  `;

  try {
    await resend.emails.send({
      from: 'MissedPro <notifications@missedpro.com>',
      to: business.owner_email,
      subject,
      html,
    });
    console.log(`Email notification sent to ${business.owner_email}`);
  } catch (err) {
    console.error('Email notification failed:', err);
  }
}

module.exports = { sendLeadNotification };