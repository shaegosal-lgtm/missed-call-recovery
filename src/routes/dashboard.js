const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/db');
const {
  deleteLead,
  recoverLead,
  permanentlyDeleteLead,
  getActiveUpcomingAppointmentForLead,
  cancelLeadAppointment,
} = require('../services/leadService');
const { sendSMS } = require('../services/twilioService');
const { planAllows } = require('../config/plans');
function requireAdmin(req, res, next) {
  if (req.session && req.session.role === 'admin') return next();
  res.redirect('/dashboard/login');
}

function requireAuth(req, res, next) {
  if (req.session && (req.session.role === 'admin' || req.session.role === 'business')) return next();
  res.redirect('/dashboard/login');
}

router.get('/login', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Login</title>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --navy: #0D1B2A;
          --blue: #1A6FDB;
          --blue-light: #EBF3FF;
          --sky: #4A9FFF;
          --gray-50: #F8FAFC;
          --gray-100: #F1F5F9;
          --gray-300: #CBD5E1;
          --gray-500: #64748B;
          --gray-700: #334155;
        }
        body { font-family: -apple-system, sans-serif; background: var(--gray-50); display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 4px 24px rgba(13,27,42,0.08); width: 100%; max-width: 400px; }
        h1 { font-size: 22px; margin-bottom: 8px; color: var(--navy); font-weight: 800; letter-spacing: -0.5px; }
        h1 span { color: var(--blue); }
        p { color: var(--gray-500); font-size: 14px; margin-bottom: 24px; }
        label { display: block; font-size: 13px; font-weight: 500; color: var(--gray-700); margin-bottom: 6px; }
        input { width: 100%; padding: 10px 14px; border: 1px solid var(--gray-300); border-radius: 8px; font-size: 15px; margin-bottom: 16px; }
        button { width: 100%; padding: 12px; background: var(--blue); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 600; cursor: pointer; }
        button:hover { background: #1560C0; }
        .error { color: #e53e3e; font-size: 13px; margin-bottom: 16px; background: #fff5f5; padding: 10px 12px; border-radius: 6px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Missed<span>Pro</span></h1>
        <p>Sign in to your dashboard</p>
        ${req.query.error ? '<p class="error">Invalid username or password. Please try again.</p>' : ''}
        <form method="POST" action="/dashboard/login">
          <label>Username</label>
          <input type="text" name="username" placeholder="Enter your username" autofocus autocomplete="username">
          <label>Password</label>
          <input type="password" name="password" placeholder="Enter your password" autocomplete="current-password">
          <button type="submit">Sign in</button>
        </form>
      </div>
    </body>
    </html>
  `);
});

router.post('/login', async (req, res) => {
  const { username, password } = req.body;

  if (username === 'admin' && password === process.env.ADMIN_KEY) {
    req.session.role = 'admin';
    req.session.authenticated = true;
    return res.redirect('/dashboard');
  }

  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (user) {
    const valid = await bcrypt.compare(password, user.password_hash);
    if (valid) {
      req.session.role = 'business';
      req.session.businessId = user.business_id;
      req.session.authenticated = true;
      return res.redirect('/dashboard');
    }
  }

  res.redirect('/dashboard/login?error=1');
});
// ===== ADMIN SETUP FORM — create a fully provisioned business in one go =====
const { v4: uuidv4 } = require('uuid');

router.get('/setup', requireAdmin, (req, res) => {
  res.send(renderSetupForm());
});

router.post('/setup', requireAdmin, async (req, res) => {
  const b = req.body;
  try {
    if (!b.name || !b.twilioNumber || !b.ownerPhone || !b.username || !b.password) {
      return res.send(renderSetupForm('Missing required fields. Business name, Twilio number, owner phone, username, and password are all required.'));
    }

    // No duplicate Twilio number
    const dupBiz = db.prepare('SELECT id FROM businesses WHERE twilio_number = ?').get(b.twilioNumber);
    if (dupBiz) return res.send(renderSetupForm('A business with that Twilio number already exists.'));

    // No duplicate username
    const dupUser = db.prepare('SELECT id FROM users WHERE username = ?').get(b.username);
    if (dupUser) return res.send(renderSetupForm('That username is already taken. Pick another.'));

    const validPlan = ['starter', 'basic', 'pro'].includes(b.plan) ? b.plan : 'basic';
    const businessId = uuidv4();
    const passwordHash = await bcrypt.hash(b.password, 10);

    // Build per-day hours from the form. Each day has openX / closeX, and a checkbox dayX.
    const dayNums = [0, 1, 2, 3, 4, 5, 6]; // Sun..Sat
    const hoursRows = [];
    for (const d of dayNums) {
      if (b[`day${d}`]) {
        hoursRows.push({
          day: d,
          open: b[`open${d}`] || '09:00',
          close: b[`close${d}`] || '17:00',
        });
      }
    }

    const provision = db.transaction(() => {
      db.prepare(`
        INSERT INTO businesses
        (id, name, owner_phone, owner_email, twilio_number, business_phone, timezone, appointment_duration_mins, business_info, avg_job_value, plan)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        businessId, b.name, b.ownerPhone, b.ownerEmail || null, b.twilioNumber,
        b.businessPhone || null, b.timezone || 'America/Toronto',
        parseInt(b.durationMins) || 60, b.businessInfo || null,
        parseFloat(b.avgJobValue) || 150, validPlan
      );

      for (const h of hoursRows) {
        db.prepare(`
          INSERT INTO business_hours (id, business_id, day_of_week, open_time, close_time, is_open)
          VALUES (?, ?, ?, ?, ?, 1)
        `).run(uuidv4(), businessId, h.day, h.open, h.close);
      }

      db.prepare(`
        INSERT INTO users (id, business_id, username, password_hash, role)
        VALUES (?, ?, ?, ?, 'business')
      `).run(uuidv4(), businessId, b.username, passwordHash);
    });

    provision();

    res.send(renderSetupSuccess(b, validPlan, businessId));
  } catch (err) {
    console.error('[setup] Failed to provision business:', err.message || err);
    res.send(renderSetupForm('Something went wrong: ' + (err.message || 'unknown error') + '. Nothing was created.'));
  }
});

function renderSetupForm(errorMsg) {
  const dayNames = [
    { n: 1, label: 'Monday' }, { n: 2, label: 'Tuesday' }, { n: 3, label: 'Wednesday' },
    { n: 4, label: 'Thursday' }, { n: 5, label: 'Friday' }, { n: 6, label: 'Saturday' }, { n: 0, label: 'Sunday' },
  ];
  const dayRows = dayNames.map(d => `
    <tr>
      <td><label><input type="checkbox" name="day${d.n}" ${[1,2,3,4,5].includes(d.n) ? 'checked' : ''}> ${d.label}</label></td>
      <td><input type="time" name="open${d.n}" value="09:00"></td>
      <td><input type="time" name="close${d.n}" value="17:00"></td>
    </tr>
  `).join('');

  return renderPage('Set Up New Business', `
    <a href="/dashboard" class="back">← Back to dashboard</a>
    <h2>Set Up New Business</h2>
    <div class="sub">Fill in the client's details and click Create. This provisions everything at once.</div>
    ${errorMsg ? `<div class="setup-error">${errorMsg}</div>` : ''}
    <form method="POST" action="/dashboard/setup" class="setup-form">
      <div class="setup-section">Business</div>
      <label>Business name *</label>
      <input name="name" required>
      <label>Twilio number * (the number you bought & pointed at the app, e.g. +16475551234)</label>
      <input name="twilioNumber" placeholder="+1..." required>
      <label>Forwarding line (the client's real business phone calls ring to first — optional)</label>
      <input name="businessPhone" placeholder="+1...">
      <label>Plan *</label>
      <select name="plan">
        <option value="starter">Starter — $47/mo</option>
        <option value="basic" selected>Basic — $97/mo</option>
        <option value="pro">Pro — $147/mo</option>
      </select>
      <label>Business info (services, pricing, policies — the AI uses this to answer questions)</label>
      <textarea name="businessInfo" rows="5" placeholder="e.g. We're a plumbing company. We do repairs, installs, and emergencies. Service call is $89..."></textarea>
      <label>Average job value (for revenue tracking)</label>
      <input name="avgJobValue" type="number" value="150">
      <label>Appointment duration (minutes)</label>
      <input name="durationMins" type="number" value="60">
      <label>Timezone</label>
      <input name="timezone" value="America/Toronto">

      <div class="setup-section">Owner alerts</div>
      <label>Owner phone * (where booking SMS alerts go — the CLIENT'S real phone, not the Twilio number)</label>
      <input name="ownerPhone" placeholder="+1..." required>
      <label>Owner email (for email alerts on Basic/Pro)</label>
      <input name="ownerEmail" type="email" placeholder="owner@business.com">

      <div class="setup-section">Business hours</div>
      <table class="hours-table">
        <tr><th>Open?</th><th>Open time</th><th>Close time</th></tr>
        ${dayRows}
      </table>

      <div class="setup-section">Client dashboard login</div>
      <label>Username *</label>
      <input name="username" required autocomplete="off">
      <label>Password *</label>
      <input name="password" required autocomplete="off">

      <button type="submit" class="setup-submit">Create Business</button>
    </form>

    <style>
      .setup-form { background: white; border: 1px solid var(--gray-100); border-radius: 12px; padding: 24px; max-width: 600px; }
      .setup-form label { display: block; font-size: 13px; font-weight: 600; color: var(--gray-700); margin: 16px 0 6px; }
      .setup-form input, .setup-form select, .setup-form textarea { width: 100%; padding: 10px 12px; border: 1px solid var(--gray-300); border-radius: 8px; font-size: 14px; font-family: inherit; }
      .setup-section { font-size: 15px; font-weight: 800; color: var(--navy); margin: 28px 0 4px; padding-bottom: 6px; border-bottom: 2px solid var(--blue-light); }
      .setup-section:first-child { margin-top: 0; }
      .hours-table { width: 100%; border-collapse: collapse; margin-top: 8px; }
      .hours-table th { text-align: left; font-size: 12px; color: var(--gray-500); padding: 6px; }
      .hours-table td { padding: 6px; }
      .hours-table input[type="time"] { width: auto; }
      .hours-table label { margin: 0; font-weight: 500; }
      .setup-submit { margin-top: 28px; width: 100%; padding: 14px; background: var(--blue); color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 700; cursor: pointer; }
      .setup-submit:hover { background: #1560C0; }
      .setup-error { background: #fff5f5; color: #c53030; border: 1px solid #feb2b2; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 14px; }
    </style>
  `, 'admin');
}

function renderSetupSuccess(b, plan, businessId) {
  return renderPage('Business Created', `
    <a href="/dashboard" class="back">← Back to dashboard</a>
    <h2>✓ Business Created</h2>
    <div class="setup-form" style="max-width:600px;">
      <p style="font-size:15px;line-height:1.7;">
        <strong>${b.name}</strong> is set up on the <strong>${plan.toUpperCase()}</strong> plan.<br><br>
        <strong>Twilio number:</strong> ${b.twilioNumber}<br>
        <strong>Owner alerts go to:</strong> ${b.ownerPhone}<br>
        <strong>Client login:</strong> ${b.username}<br><br>
        Give the client their login (username + the password you set). They sign in at this site to see their dashboard.
      </p>
      <p style="margin-top:20px;background:var(--blue-light);padding:14px 16px;border-radius:8px;font-size:14px;line-height:1.6;">
        <strong>Don't forget the Twilio setup:</strong> point ${b.twilioNumber}'s Voice and Messaging webhooks at this app, disable voicemail on the forwarding line, and tell the client to let calls ring (not decline).
      </p>
      <a href="/dashboard/setup" class="setup-submit" style="display:block;text-align:center;text-decoration:none;margin-top:20px;">Set Up Another</a>
    </div>
  `, 'admin');
}
// ===== END ADMIN SETUP FORM =====
router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/dashboard/login');
});

router.post('/api/leads/:id/view', requireAuth, (req, res) => {
  db.prepare('UPDATE leads SET viewed = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// Confirms a lead belongs to the logged-in user (admins can touch any lead).
function userCanAccessLead(req, leadId) {
  if (req.session.role === 'admin') return true;
  const row = db.prepare(`
    SELECT l.id FROM leads l
    JOIN calls c ON l.call_id = c.id
    JOIN businesses b ON c.to_number = b.twilio_number
    WHERE l.id = ? AND b.id = ?
  `).get(leadId, req.session.businessId);
  return !!row;
}

// Returns a lead's upcoming appointment (for the popup). null if none.
router.get('/api/leads/:id/appointment', requireAuth, (req, res) => {
  if (!userCanAccessLead(req, req.params.id)) return res.status(403).json({ error: 'forbidden' });
  const appt = getActiveUpcomingAppointmentForLead(req.params.id);
  res.json({ appointment: appt });
});

// Cancel a lead's upcoming appointment, close the lead, and text the customer.
router.post('/api/leads/:id/cancel-appointment', requireAuth, async (req, res) => {
  if (!userCanAccessLead(req, req.params.id)) return res.status(403).json({ error: 'forbidden' });

  const result = cancelLeadAppointment(req.params.id);
  if (!result.success) {
    return res.json({ success: false, reason: result.reason });
  }

  // Notify the customer by SMS. If the text fails, the cancellation still stands.
  try {
    const startDate = new Date(result.appointment.start_time);
    const when = startDate.toLocaleString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit', timeZone: 'UTC'
    });
    await sendSMS(result.phone, `Your appointment on ${when} has been cancelled. If this was a mistake or you'd like to rebook, just reply here and we'll help.`);
  } catch (err) {
    console.error('[cancel-appointment] Failed to text customer, cancellation still applied:', err.message || err);
  }

  res.json({ success: true });
});

// Move selected leads to the trash. Skips any blocked by an active appointment.
router.post('/api/leads/delete', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  let deleted = 0;
  const blocked = [];
  for (const id of ids) {
    if (!userCanAccessLead(req, id)) continue;
    const result = deleteLead(id);
    if (result.success) deleted++;
    else if (result.reason === 'has_active_appointment') blocked.push(id);
  }
  res.json({ success: true, deleted, blocked });
});

// Recover selected leads from the trash.
router.post('/api/leads/recover', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  let recovered = 0;
  for (const id of ids) {
    if (!userCanAccessLead(req, id)) continue;
    const result = recoverLead(id);
    if (result.success) recovered++;
  }
  res.json({ success: true, recovered });
});

// Permanently erase selected trashed leads (and their appointments).
router.post('/api/leads/permanent-delete', requireAuth, (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  let erased = 0;
  for (const id of ids) {
    if (!userCanAccessLead(req, id)) continue;
    const result = permanentlyDeleteLead(id);
    if (result.success) erased++;
  }
  res.json({ success: true, erased });
});

router.get('/', requireAuth, (req, res) => {
  if (req.session.role === 'admin') {
    const businesses = db.prepare('SELECT * FROM businesses ORDER BY created_at DESC').all();

    const businessCards = businesses.map(b => {
      const leadCount = db.prepare(`
        SELECT COUNT(*) as count FROM leads WHERE deleted_at IS NULL AND call_id IN (
          SELECT id FROM calls WHERE to_number = ?
        )
      `).get(b.twilio_number).count;

      const apptCount = db.prepare(`
        SELECT COUNT(*) as count FROM appointments WHERE business_id = ? AND status = 'scheduled'
      `).get(b.id).count;

      return `
        <a href="/dashboard/business/${b.id}" class="biz-card">
          <div class="biz-card-header">
            <div>
              <div class="biz-card-title">${b.name}</div>
              <div class="biz-card-sub">${b.twilio_number}</div>
            </div>
            <div class="pill">${leadCount} leads</div>
          </div>
          <div class="biz-card-stats">
            <div class="mini-stat"><span class="mini-stat-num">${leadCount}</span><span class="mini-stat-label">Total Leads</span></div>
            <div class="mini-stat"><span class="mini-stat-num">${apptCount}</span><span class="mini-stat-label">Upcoming Appts</span></div>
          </div>
        </a>
      `;
    }).join('');

    return res.send(renderPage('Admin Dashboard', `
      <a href="/dashboard/setup" class="setup-submit" style="display:inline-block;width:auto;padding:10px 20px;text-decoration:none;margin-bottom:20px;background:var(--blue);color:white;border-radius:8px;font-weight:700;font-size:14px;">+ Set Up New Business</a>
      <h2>Businesses</h2>
      ${businesses.length === 0 ? '<div class="empty">No businesses yet.</div>' : `<div class="biz-grid">${businessCards}</div>`}
    `, 'admin'));
  }

  res.redirect(`/dashboard/business/${req.session.businessId}`);
});

router.get('/business/:id', requireAuth, (req, res) => {
  if (req.session.role === 'business' && req.session.businessId !== req.params.id) {
    return res.redirect('/dashboard');
  }

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!business) return res.redirect('/dashboard');

  // Pro-only: analytics & revenue tracking. Lower plans see a simpler Overview.
  const showAnalytics = planAllows(business.plan, 'analytics');

  // LIVE leads (not trashed)
  const leads = db.prepare(`
    SELECT * FROM leads WHERE deleted_at IS NULL AND call_id IN (
      SELECT id FROM calls WHERE to_number = ?
    ) ORDER BY created_at DESC
  `).all(business.twilio_number);

  // TRASHED leads
  const deletedLeads = db.prepare(`
    SELECT * FROM leads WHERE deleted_at IS NOT NULL AND call_id IN (
      SELECT id FROM calls WHERE to_number = ?
    ) ORDER BY deleted_at DESC
  `).all(business.twilio_number);

  const appointments = db.prepare(`
    SELECT a.*, l.name as lead_name, l.phone FROM appointments a
    JOIN leads l ON a.lead_id = l.id
    WHERE a.business_id = ?
    ORDER BY a.start_time ASC
  `).all(business.id);

  const now = new Date();
  const firstOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const leadsThisMonth = leads.filter(l => l.created_at >= firstOfMonth.replace('T', ' ').substring(0, 19));
  const apptsThisMonth = appointments.filter(a => a.created_at >= firstOfMonth.replace('T', ' ').substring(0, 19) && a.status !== 'cancelled');

  const totalLeadsAllTime = leads.length;
  const totalApptsAllTime = appointments.filter(a => a.status !== 'cancelled').length;
  const conversionRate = totalLeadsAllTime > 0 ? Math.round((totalApptsAllTime / totalLeadsAllTime) * 100) : 0;
  const avgJobValue = business.avg_job_value || 150;
  const revenueRecoveredMonth = apptsThisMonth.length * avgJobValue;
  const revenueRecoveredAllTime = totalApptsAllTime * avgJobValue;

  const urgencyBreakdown = {
    high: leads.filter(l => l.urgency === 'high').length,
    medium: leads.filter(l => l.urgency === 'medium').length,
    low: leads.filter(l => l.urgency === 'low').length,
  };

  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().split('T')[0];
    const count = leads.filter(l => l.created_at.startsWith(dayStr)).length;
    last7Days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' }), count });
  }
  const maxDayCount = Math.max(...last7Days.map(d => d.count), 1);

  function initials(name, phone) {
    if (name) {
      const parts = name.trim().split(' ');
      return (parts[0][0] + (parts[1] ? parts[1][0] : '')).toUpperCase();
    }
    return phone.slice(-2);
  }

  const leadCards = leads.map(l => {
    const isNew = !l.viewed;
    return `
    <div class="lead-row ${isNew ? 'is-new' : ''}" data-lead-id="${l.id}">
      <input type="checkbox" class="row-check leads-check" value="${l.id}" onclick="event.stopPropagation()">
      ${isNew ? '<div class="new-dot"></div>' : ''}
      <div class="lead-body" onclick="showLead('${l.id}')">
        <div class="lead-avatar">${initials(l.name, l.phone)}</div>
        <div class="lead-main">
          <div class="lead-name-line">
            <span class="lead-name">${l.name || 'Unknown Caller'}</span>
            <span class="lead-date">${new Date(l.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          </div>
          <div class="lead-phone">${l.phone}</div>
          <div class="lead-summary">${l.ai_summary || l.reason || 'No summary yet'}</div>
        </div>
        <div class="lead-tags">
          <span class="tag-lg urgency-${l.urgency}">${l.urgency}</span>
          <span class="tag-lg status-${l.status}">${l.status}</span>
        </div>
      </div>
    </div>
  `}).join('');

  const deletedCards = deletedLeads.map(l => {
    const deletedDate = new Date(l.deleted_at);
    const purgeDate = new Date(deletedDate.getTime() + 30 * 24 * 60 * 60 * 1000);
    const daysLeft = Math.max(0, Math.ceil((purgeDate - now) / (1000 * 60 * 60 * 24)));
    return `
    <div class="lead-row" data-lead-id="${l.id}">
      <input type="checkbox" class="row-check deleted-check" value="${l.id}" onclick="event.stopPropagation()">
      <div class="lead-body" onclick="showLead('${l.id}')">
        <div class="lead-avatar" style="background:var(--gray-500)">${initials(l.name, l.phone)}</div>
        <div class="lead-main">
          <div class="lead-name-line">
            <span class="lead-name">${l.name || 'Unknown Caller'}</span>
            <span class="lead-date">Deleted ${deletedDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          </div>
          <div class="lead-phone">${l.phone}</div>
          <div class="lead-summary">Auto-erases in ${daysLeft} day${daysLeft === 1 ? '' : 's'}</div>
        </div>
      </div>
    </div>
  `}).join('');

  // ===== APPOINTMENTS TAB ENHANCEMENT =====
  const nowMs = Date.now();
  const todayStr = new Date().toISOString().split('T')[0];
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowStr = tomorrowDate.toISOString().split('T')[0];

  const activeAppts = appointments.filter(a => a.status !== 'cancelled');
  const upcomingAppts = activeAppts
    .filter(a => new Date(a.start_time).getTime() >= nowMs)
    .sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
  const pastAppts = activeAppts
    .filter(a => new Date(a.start_time).getTime() < nowMs)
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));
  const cancelledAppts = appointments
    .filter(a => a.status === 'cancelled')
    .sort((a, b) => new Date(b.start_time) - new Date(a.start_time));

  const upcomingThisWeek = upcomingAppts.filter(a => {
    const diffDays = (new Date(a.start_time) - now) / (1000 * 60 * 60 * 24);
    return diffDays <= 7;
  }).length;

  const missingAddressCount = upcomingAppts.filter(a => !a.service_address).length;

  function renderApptCard(a, options = {}) {
    const startDate = new Date(a.start_time);
    const dateStr = startDate.toISOString().split('T')[0];
    let badge = '';
    if (a.status === 'cancelled') {
      badge = '';
    } else if (dateStr === todayStr) {
      badge = '<span class="day-badge today">TODAY</span>';
    } else if (dateStr === tomorrowStr) {
      badge = '<span class="day-badge tomorrow">TOMORROW</span>';
    }

    return `
    <div class="appt-row ${options.dimmed ? 'dimmed' : ''}">
      <div class="appt-date-block ${a.status === 'cancelled' ? 'cancelled-block' : ''}">
        <div class="appt-month">${startDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</div>
        <div class="appt-day">${startDate.getDate()}</div>
      </div>
      <div class="appt-main">
        <div class="appt-name-line">
          <span class="appt-name">${a.lead_name || 'Unknown'}</span>
          <div style="display:flex;gap:6px;align-items:center;">
            ${badge}
            <span class="tag-lg status-${a.status}">${a.status === 'cancelled' ? 'Cancelled' : a.status}</span>
          </div>
        </div>
        <div class="appt-detail">${startDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} at ${startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${a.phone}</div>
        ${a.service_address
          ? `<div class="appt-address">📍 ${a.service_address}</div>`
          : a.status !== 'cancelled' ? '<div class="appt-address-missing">⚠️ Address not collected</div>' : ''}
      </div>
      <div class="appt-code">
        <div class="code-label">CODE</div>
        <div class="code-value">${a.confirmation_code || '-'}</div>
      </div>
    </div>
  `;
  }

  const upcomingCards = upcomingAppts.map(a => renderApptCard(a)).join('');
  const pastCards = pastAppts.map(a => renderApptCard(a, { dimmed: true })).join('');
  const cancelledCards = cancelledAppts.map(a => renderApptCard(a, { dimmed: true })).join('');

  const allLeadsForJs = [...leads, ...deletedLeads];
  const leadData = JSON.stringify(allLeadsForJs).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  const backLink = req.session.role === 'admin' ? '<a href="/dashboard" class="back">← All businesses</a>' : '';

  const trendBars = last7Days.map(d => `
    <div class="trend-col">
      <div class="trend-bar-wrap">
        <div class="trend-bar" style="height:${(d.count / maxDayCount) * 100}%;${d.count === 0 ? 'min-height:0' : 'min-height:4px'}"></div>
      </div>
      <div class="trend-label">${d.label}</div>
      <div class="trend-count">${d.count}</div>
    </div>
  `).join('');

  return res.send(renderPage(business.name, `
    ${backLink}
    <h2>${business.name}</h2>
    <div class="sub">${business.twilio_number} · ${business.timezone}</div>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('overview', this)">Overview</button>
      <button class="tab-btn" onclick="switchTab('leads', this)">Leads <span class="tab-count">${leads.length}</span></button>
      <button class="tab-btn" onclick="switchTab('appointments', this)">Appointments <span class="tab-count">${upcomingAppts.length}</span></button>
      <button class="tab-btn" onclick="switchTab('deleted', this)">Deleted <span class="tab-count">${deletedLeads.length}</span></button>
    </div>

    <div id="tab-overview" class="tab-content active">
      ${showAnalytics ? `
      <div class="analytics-grid">
        <div class="analytics-card">
          <div class="analytics-label">Leads This Month</div>
          <div class="analytics-value">${leadsThisMonth.length}</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-label">Appointments Booked</div>
          <div class="analytics-value">${apptsThisMonth.length}</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-label">Conversion Rate</div>
          <div class="analytics-value">${conversionRate}%</div>
        </div>
        <div class="analytics-card highlight">
          <div class="analytics-label">Revenue Recovered (Month)</div>
          <div class="analytics-value">$${revenueRecoveredMonth.toLocaleString()}</div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">Leads — Last 7 Days</div>
        <div class="trend-chart">
          ${trendBars}
        </div>
      </div>

      <div class="section">
        <div class="section-header">All-Time Summary</div>
        <div class="summary-grid">
          <div class="summary-item">
            <div class="summary-label">Total Leads</div>
            <div class="summary-value">${totalLeadsAllTime}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Total Appointments</div>
            <div class="summary-value">${totalApptsAllTime}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Total Revenue Recovered</div>
            <div class="summary-value" style="color:#16A34A">$${revenueRecoveredAllTime.toLocaleString()}</div>
          </div>
          <div class="summary-item">
            <div class="summary-label">Avg Job Value</div>
            <div class="summary-value">$${avgJobValue}</div>
          </div>
        </div>
      </div>

      <div class="section">
        <div class="section-header">Lead Urgency Breakdown</div>
        <div class="urgency-row">
          <div class="urgency-item">
            <div class="urgency-circle" style="background:#FEE2E2;color:#DC2626">${urgencyBreakdown.high}</div>
            <div class="urgency-label">High</div>
          </div>
          <div class="urgency-item">
            <div class="urgency-circle" style="background:#FEF3C7;color:#D97706">${urgencyBreakdown.medium}</div>
            <div class="urgency-label">Medium</div>
          </div>
          <div class="urgency-item">
            <div class="urgency-circle" style="background:#DCFCE7;color:#16A34A">${urgencyBreakdown.low}</div>
            <div class="urgency-label">Low</div>
          </div>
        </div>
      </div>
      ` : `
      <div class="analytics-grid">
        <div class="analytics-card">
          <div class="analytics-label">Leads This Month</div>
          <div class="analytics-value">${leadsThisMonth.length}</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-label">Appointments Booked</div>
          <div class="analytics-value">${apptsThisMonth.length}</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-label">Total Leads</div>
          <div class="analytics-value">${totalLeadsAllTime}</div>
        </div>
        <div class="analytics-card">
          <div class="analytics-label">Total Appointments</div>
          <div class="analytics-value">${totalApptsAllTime}</div>
        </div>
      </div>
      <div class="section">
        <div class="section-header" style="border-bottom:none;color:var(--gray-500);font-weight:600;">
          Revenue tracking & detailed analytics are available on the Pro plan.
        </div>
      </div>
      `}
    </div>
    <div id="tab-leads" class="tab-content">
      <div class="legend">
        <span class="legend-title">Legend:</span>
        <span class="legend-group-label">Status</span>
        <span class="legend-item"><span class="legend-dot" style="background:#1A6FDB"></span>New</span>
        <span class="legend-item"><span class="legend-dot" style="background:#16A34A"></span>Scheduled</span>
        <span class="legend-item"><span class="legend-dot" style="background:#D97706"></span>Needs Follow-Up</span>
        <span class="legend-item"><span class="legend-dot" style="background:#64748B"></span>Closed</span>
        <span class="legend-divider"></span>
        <span class="legend-group-label">Urgency</span>
        <span class="legend-item"><span class="legend-dot" style="background:#DC2626"></span>High</span>
        <span class="legend-item"><span class="legend-dot" style="background:#F59E0B"></span>Medium</span>
        <span class="legend-item"><span class="legend-dot" style="background:#16A34A"></span>Low</span>
      </div>

      <div class="select-bar">
        <button class="select-toggle" id="leads-select-toggle" onclick="toggleSelectMode('leads')">Select</button>
        <div class="select-actions" id="leads-select-actions">
          <span class="select-count" id="leads-select-count">0 selected</span>
          <button class="btn-danger" onclick="deleteSelected()">Delete selected</button>
          <button class="btn-plain" onclick="toggleSelectMode('leads')">Cancel</button>
        </div>
      </div>

      <div class="section">
        <div class="lead-list" id="leads-list">
          ${leads.length === 0 ? '<div class="empty">No leads yet</div>' : leadCards}
        </div>
      </div>
    </div>

    <div id="tab-appointments" class="tab-content">
      <div class="appt-stats-strip">
        <div class="appt-stat">
          <div class="appt-stat-num">${upcomingAppts.length}</div>
          <div class="appt-stat-label">Upcoming</div>
        </div>
        <div class="appt-stat">
          <div class="appt-stat-num">${upcomingThisWeek}</div>
          <div class="appt-stat-label">This Week</div>
        </div>
        <div class="appt-stat ${missingAddressCount > 0 ? 'warn' : ''}">
          <div class="appt-stat-num">${missingAddressCount}</div>
          <div class="appt-stat-label">Missing Address</div>
        </div>
        <div class="appt-stat">
          <div class="appt-stat-num">$${(upcomingAppts.length * avgJobValue).toLocaleString()}</div>
          <div class="appt-stat-label">Pipeline Value</div>
        </div>
      </div>

      <div class="appt-subtabs">
        <button class="appt-subtab-btn active" onclick="switchApptSubtab('upcoming', this)">Upcoming (${upcomingAppts.length})</button>
        <button class="appt-subtab-btn" onclick="switchApptSubtab('past', this)">Past (${pastAppts.length})</button>
        <button class="appt-subtab-btn" onclick="switchApptSubtab('cancelled', this)">Cancelled (${cancelledAppts.length})</button>
      </div>

      <div id="appt-sub-upcoming" class="appt-subtab-content active">
        <div class="section">
          ${upcomingAppts.length === 0 ? '<div class="empty">No upcoming appointments</div>' : `<div class="appt-list">${upcomingCards}</div>`}
        </div>
      </div>
      <div id="appt-sub-past" class="appt-subtab-content">
        <div class="section">
          ${pastAppts.length === 0 ? '<div class="empty">No past appointments</div>' : `<div class="appt-list">${pastCards}</div>`}
        </div>
      </div>
      <div id="appt-sub-cancelled" class="appt-subtab-content">
        <div class="section">
          ${cancelledAppts.length === 0 ? '<div class="empty">No cancelled appointments</div>' : `<div class="appt-list">${cancelledCards}</div>`}
        </div>
      </div>
    </div>

    <div id="tab-deleted" class="tab-content">
      <div class="deleted-note">Deleted leads are kept for 30 days, then permanently erased. You can recover them anytime before then.</div>

      <div class="select-bar">
        <button class="select-toggle" id="deleted-select-toggle" onclick="toggleSelectMode('deleted')">Select</button>
        <div class="select-actions" id="deleted-select-actions">
          <span class="select-count" id="deleted-select-count">0 selected</span>
          <button class="btn-recover" onclick="recoverSelected()">Recover selected</button>
          <button class="btn-danger" onclick="permanentDeleteSelected()">Delete permanently</button>
          <button class="btn-plain" onclick="toggleSelectMode('deleted')">Cancel</button>
        </div>
      </div>

      <div class="section">
        <div class="lead-list" id="deleted-list">
          ${deletedLeads.length === 0 ? '<div class="empty">Nothing in the trash</div>' : deletedCards}
        </div>
      </div>
    </div>

    <div class="modal" id="modal">
      <div class="modal-box">
        <span class="modal-close" onclick="closeModal()">×</span>
        <div class="modal-title" id="modal-title">Lead Details</div>
        <div id="modal-content"></div>
        <div id="modal-appointment"></div>
      </div>
    </div>

    <script>
      const leads = JSON.parse(\`${leadData}\`);
      const selectMode = { leads: false, deleted: false };
      let currentLeadId = null;

      function switchTab(tabName, btn) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById('tab-' + tabName).classList.add('active');
        btn.classList.add('active');
      }

      function switchApptSubtab(name, btn) {
        document.querySelectorAll('.appt-subtab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.appt-subtab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById('appt-sub-' + name).classList.add('active');
        btn.classList.add('active');
      }

      function toggleSelectMode(which) {
        selectMode[which] = !selectMode[which];
        const on = selectMode[which];
        const listId = which === 'leads' ? 'leads-list' : 'deleted-list';
        const list = document.getElementById(listId);
        list.classList.toggle('select-mode', on);
        document.getElementById(which + '-select-toggle').style.display = on ? 'none' : 'inline-block';
        document.getElementById(which + '-select-actions').style.display = on ? 'flex' : 'none';
        if (!on) {
          list.querySelectorAll('.row-check').forEach(c => { c.checked = false; });
        }
        updateCount(which);
      }

      function updateCount(which) {
        const cls = which === 'leads' ? 'leads-check' : 'deleted-check';
        const n = document.querySelectorAll('.' + cls + ':checked').length;
        document.getElementById(which + '-select-count').textContent = n + ' selected';
      }

      function getChecked(cls) {
        return Array.from(document.querySelectorAll('.' + cls + ':checked')).map(c => c.value);
      }

      document.addEventListener('change', function(e) {
        if (e.target.classList.contains('leads-check')) updateCount('leads');
        if (e.target.classList.contains('deleted-check')) updateCount('deleted');
      });

      async function deleteSelected() {
        const ids = getChecked('leads-check');
        if (ids.length === 0) { alert('Select at least one lead first.'); return; }
        const r = await fetch('/dashboard/api/leads/delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        const data = await r.json();
        if (data.blocked && data.blocked.length > 0) {
          alert(data.deleted + ' moved to trash. ' + data.blocked.length + ' could not be deleted because they have an upcoming appointment. Cancel the appointment first (open the lead to cancel it).');
        }
        location.reload();
      }

      async function recoverSelected() {
        const ids = getChecked('deleted-check');
        if (ids.length === 0) { alert('Select at least one lead first.'); return; }
        await fetch('/dashboard/api/leads/recover', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        location.reload();
      }

      async function permanentDeleteSelected() {
        const ids = getChecked('deleted-check');
        if (ids.length === 0) { alert('Select at least one lead first.'); return; }
        const ok = confirm('Permanently erase ' + ids.length + ' lead' + (ids.length === 1 ? '' : 's') + '? This cannot be undone.');
        if (!ok) return;
        await fetch('/dashboard/api/leads/permanent-delete', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids })
        });
        location.reload();
      }

      async function showLead(id) {
        const lead = leads.find(l => l.id === id);
        if (!lead) return;
        currentLeadId = id;

        let convoHtml = '';
        try {
          const convo = JSON.parse(lead.conversation || '[]')
            .filter(m => m.role !== 'system');
          convoHtml = convo.map(m => {
            const cls = m.role === 'customer' ? 'customer' : 'assistant';
            return '<div class="msg ' + cls + '"><div class="bubble">' + m.body + '</div></div>';
          }).join('');
        } catch(e) {}

        document.getElementById('modal-title').textContent = lead.name || lead.phone;
        document.getElementById('modal-content').innerHTML =
          '<div class="field"><div class="field-label">Phone</div><div class="field-value">' + lead.phone + '</div></div>' +
          '<div class="field"><div class="field-label">Urgency</div><div class="field-value">' + lead.urgency + '</div></div>' +
          '<div class="field"><div class="field-label">Type</div><div class="field-value">' + lead.lead_type + '</div></div>' +
          '<div class="field"><div class="field-label">AI Summary</div><div class="field-value">' + (lead.ai_summary || 'Not classified yet') + '</div></div>' +
          '<div class="field"><div class="field-label">Conversation</div><div class="convo">' + (convoHtml || 'No messages yet') + '</div></div>';

        // Load the appointment (if any) and show a Cancel button.
        const apptBox = document.getElementById('modal-appointment');
        apptBox.innerHTML = '<div class="appt-loading">Checking for appointments…</div>';
        try {
          const r = await fetch('/dashboard/api/leads/' + id + '/appointment');
          const data = await r.json();
          if (data.appointment) {
            const a = data.appointment;
            const start = new Date(a.start_time);
            const when = start.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
            apptBox.innerHTML =
              '<div class="appt-callout">' +
                '<div class="appt-callout-label">Upcoming appointment</div>' +
                '<div class="appt-callout-when">' + when + '</div>' +
                (a.confirmation_code ? '<div class="appt-callout-code">Code: ' + a.confirmation_code + '</div>' : '') +
                '<button class="btn-danger" style="margin-top:12px" onclick="cancelAppointment()">Cancel appointment</button>' +
              '</div>';
          } else {
            apptBox.innerHTML = '';
          }
        } catch (e) {
          apptBox.innerHTML = '';
        }

        document.getElementById('modal').classList.add('active');

        const row = document.querySelector('[data-lead-id="' + id + '"]');
        if (row && row.classList.contains('is-new')) {
          row.classList.remove('is-new');
          const dot = row.querySelector('.new-dot');
          if (dot) dot.remove();
          try {
            await fetch('/dashboard/api/leads/' + id + '/view', { method: 'POST' });
          } catch(e) {}
        }
      }

      async function cancelAppointment() {
        if (!currentLeadId) return;
        const ok = confirm('Cancel this appointment? The customer will be texted to let them know.');
        if (!ok) return;
        const r = await fetch('/dashboard/api/leads/' + currentLeadId + '/cancel-appointment', { method: 'POST' });
        const data = await r.json();
        if (data.success) {
          alert('Appointment cancelled and the customer was notified.');
          location.reload();
        } else {
          alert('Could not cancel: ' + (data.reason || 'unknown error'));
        }
      }

      function closeModal() {
        document.getElementById('modal').classList.remove('active');
        currentLeadId = null;
      }

      document.getElementById('modal').addEventListener('click', function(e) {
        if (e.target === this) closeModal();
      });
    </script>
  `, req.session.role));
});

function renderPage(title, content, role) {
  return `<!DOCTYPE html>
  <html>
  <head>
    <title>${title}</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>
      * { box-sizing: border-box; margin: 0; padding: 0; }
      :root {
        --navy: #0D1B2A;
        --blue: #1A6FDB;
        --blue-light: #EBF3FF;
        --sky: #4A9FFF;
        --gray-50: #F8FAFC;
        --gray-100: #F1F5F9;
        --gray-300: #CBD5E1;
        --gray-500: #64748B;
        --gray-700: #334155;
      }
      body { font-family: -apple-system, sans-serif; background: var(--gray-50); color: var(--navy); }
      .nav { background: var(--navy); padding: 16px 24px; display: flex; justify-content: space-between; align-items: center; }
      .nav-title { font-size: 18px; font-weight: 800; color: white; letter-spacing: -0.5px; }
      .nav-title span { color: var(--sky); }
      .nav a { color: rgba(255,255,255,0.6); font-size: 14px; text-decoration: none; }
      .nav a:hover { color: white; }
      .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
      .back { color: var(--gray-500); font-size: 14px; text-decoration: none; display: inline-block; margin-bottom: 20px; }
      .back:hover { color: var(--blue); }
      h2 { font-size: 22px; margin-bottom: 4px; font-weight: 800; letter-spacing: -0.5px; }
      .sub { color: var(--gray-500); font-size: 14px; margin-bottom: 24px; }

      .biz-grid { display: grid; gap: 16px; }
      .biz-card { background: white; border-radius: 12px; padding: 20px; text-decoration: none; color: inherit; display: block; border: 1px solid var(--gray-100); transition: box-shadow 0.2s, transform 0.2s; }
      .biz-card:hover { box-shadow: 0 4px 24px rgba(13,27,42,0.08); transform: translateY(-2px); }
      .biz-card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
      .biz-card-title { font-size: 16px; font-weight: 700; }
      .biz-card-sub { font-size: 13px; color: var(--gray-500); margin-top: 2px; }
      .pill { font-size: 12px; padding: 4px 12px; border-radius: 100px; background: var(--blue-light); color: var(--blue); font-weight: 600; }
      .biz-card-stats { display: flex; gap: 24px; }
      .mini-stat { display: flex; flex-direction: column; }
      .mini-stat-num { font-size: 22px; font-weight: 700; }
      .mini-stat-label { font-size: 12px; color: var(--gray-500); margin-top: 2px; }

      .empty { padding: 40px; text-align: center; color: var(--gray-500); font-size: 14px; }

      .tabs { display: flex; gap: 4px; margin-bottom: 24px; border-bottom: 1px solid var(--gray-100); }
      .tab-btn { background: none; border: none; padding: 12px 18px; font-size: 14px; font-weight: 600; color: var(--gray-500); cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit; display: flex; align-items: center; gap: 6px; }
      .tab-btn:hover { color: var(--navy); }
      .tab-btn.active { color: var(--blue); border-bottom-color: var(--blue); }
      .tab-count { background: var(--gray-100); color: var(--gray-500); font-size: 11px; padding: 1px 7px; border-radius: 100px; font-weight: 700; }
      .tab-btn.active .tab-count { background: var(--blue-light); color: var(--blue); }
      .tab-content { display: none; }
      .tab-content.active { display: block; }

      .analytics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 24px; }
      .analytics-card { background: white; border-radius: 12px; border: 1px solid var(--gray-100); padding: 20px; }
      .analytics-card.highlight { background: var(--navy); border-color: var(--navy); }
      .analytics-card.highlight .analytics-label { color: rgba(255,255,255,0.6); }
      .analytics-card.highlight .analytics-value { color: var(--sky); }
      .analytics-label { font-size: 12px; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; font-weight: 600; }
      .analytics-value { font-size: 28px; font-weight: 800; color: var(--navy); letter-spacing: -0.5px; }

      .section { background: white; border-radius: 12px; border: 1px solid var(--gray-100); margin-bottom: 24px; overflow: hidden; }
      .section-header { padding: 16px 20px; border-bottom: 1px solid var(--gray-100); font-weight: 700; font-size: 15px; }

      .trend-chart { padding: 24px; display: flex; gap: 8px; align-items: flex-end; }
      .trend-col { display: flex; flex-direction: column; align-items: center; gap: 8px; flex: 1; }
      .trend-bar-wrap { width: 100%; max-width: 32px; height: 100px; display: flex; align-items: flex-end; }
      .trend-bar { width: 100%; background: linear-gradient(180deg, var(--sky), var(--blue)); border-radius: 6px 6px 0 0; transition: height 0.3s; }
      .trend-label { font-size: 11px; color: var(--gray-500); }
      .trend-count { font-size: 12px; color: var(--navy); font-weight: 700; }

      .summary-grid { padding: 20px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 20px; }
      .summary-label { font-size: 12px; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600; }
      .summary-value { font-size: 24px; font-weight: 800; color: var(--navy); margin-top: 4px; letter-spacing: -0.5px; }

      .urgency-row { padding: 20px; display: flex; gap: 24px; }
      .urgency-item { text-align: center; }
      .urgency-circle { width: 52px; height: 52px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 18px; margin: 0 auto; }
      .urgency-label { font-size: 12px; color: var(--gray-500); margin-top: 8px; font-weight: 600; }

      .legend { background: white; border: 1px solid var(--gray-100); border-radius: 10px; padding: 14px 18px; margin-bottom: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 12px; color: var(--gray-700); }
      .legend-title { font-weight: 700; color: var(--navy); }
      .legend-group-label { font-weight: 700; color: var(--gray-500); font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
      .legend-item { display: flex; align-items: center; gap: 6px; }
      .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      .legend-divider { width: 1px; height: 16px; background: var(--gray-100); margin: 0 4px; }

      /* SELECT MODE */
      .select-bar { display: flex; align-items: center; margin-bottom: 16px; min-height: 40px; }
      .select-toggle { background: white; border: 1px solid var(--gray-300); color: var(--gray-700); padding: 8px 18px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
      .select-toggle:hover { border-color: var(--blue); color: var(--blue); }
      .select-actions { display: none; align-items: center; gap: 10px; flex-wrap: wrap; }
      .select-count { font-size: 13px; color: var(--gray-500); font-weight: 600; }
      .btn-danger { background: #DC2626; color: white; border: none; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
      .btn-danger:hover { background: #B91C1C; }
      .btn-recover { background: #16A34A; color: white; border: none; padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
      .btn-recover:hover { background: #15803D; }
      .btn-plain { background: none; border: none; color: var(--gray-500); padding: 8px 12px; font-size: 13px; font-weight: 600; cursor: pointer; font-family: inherit; }
      .btn-plain:hover { color: var(--navy); }
      .row-check { display: none; width: 18px; height: 18px; margin: 16px 0 0 4px; flex-shrink: 0; cursor: pointer; }
      .lead-list.select-mode .row-check { display: block; }
      .lead-body { display: flex; align-items: flex-start; gap: 14px; flex: 1; min-width: 0; cursor: pointer; }

      .deleted-note { background: var(--blue-light); border: 1px solid #CFE2FB; color: var(--gray-700); border-radius: 10px; padding: 12px 16px; font-size: 13px; margin-bottom: 16px; }

      .appt-callout { background: var(--gray-50); border: 1px solid var(--gray-100); border-radius: 10px; padding: 16px; margin-top: 16px; }
      .appt-callout-label { font-size: 11px; color: var(--gray-500); text-transform: uppercase; letter-spacing: 0.5px; font-weight: 700; margin-bottom: 6px; }
      .appt-callout-when { font-size: 15px; font-weight: 700; color: var(--navy); }
      .appt-callout-code { font-size: 13px; color: var(--gray-500); margin-top: 4px; font-family: monospace; }
      .appt-loading { font-size: 13px; color: var(--gray-500); margin-top: 16px; }

      .lead-list { display: flex; flex-direction: column; }
      .lead-row { display: flex; align-items: flex-start; gap: 8px; padding: 18px 20px; border-bottom: 1px solid var(--gray-100); transition: background 0.15s; position: relative; }
      .lead-row:last-child { border-bottom: none; }
      .lead-row:hover { background: var(--gray-50); }
      .lead-row.is-new { background: var(--blue-light); }
      .lead-row.is-new:hover { background: #DCE9FC; }
      .new-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--blue); flex-shrink: 0; margin-top: 16px; }
      .lead-avatar { width: 44px; height: 44px; border-radius: 50%; background: var(--navy); color: white; font-weight: 700; font-size: 14px; display: flex; align-items: center; justify-content: center; flex-shrink: 0; }
      .lead-main { flex: 1; min-width: 0; }
      .lead-name-line { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; }
      .lead-name { font-size: 16px; font-weight: 700; color: var(--navy); }
      .lead-date { font-size: 12px; color: var(--gray-500); white-space: nowrap; }
      .lead-phone { font-size: 13px; color: var(--gray-500); margin-top: 2px; }
      .lead-summary { font-size: 14px; color: var(--gray-700); margin-top: 8px; line-height: 1.4; }
      .lead-tags { display: flex; flex-direction: column; gap: 8px; align-items: flex-end; flex-shrink: 0; }

      .tag-lg { font-size: 13px; padding: 6px 14px; border-radius: 8px; font-weight: 700; text-transform: capitalize; white-space: nowrap; min-width: 80px; text-align: center; }
      .urgency-high { background: #DC2626; color: white; }
      .urgency-medium { background: #F59E0B; color: white; }
      .urgency-low { background: #16A34A; color: white; }
      .urgency-unknown { background: var(--gray-300); color: white; }
      .status-new { background: var(--blue); color: white; }
      .status-scheduled { background: #16A34A; color: white; }
      .status-needs_followup { background: #D97706; color: white; }
      .status-closed { background: var(--gray-500); color: white; }
      .status-cancelled { background: #DC2626; color: white; }

      /* APPT STATS STRIP */
      .appt-stats-strip { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 20px; }
      .appt-stat { background: white; border: 1px solid var(--gray-100); border-radius: 10px; padding: 14px; text-align: center; }
      .appt-stat.warn { border-color: #FDE68A; background: #FFFBEB; }
      .appt-stat.warn .appt-stat-num { color: #D97706; }
      .appt-stat-num { font-size: 22px; font-weight: 800; color: var(--navy); }
      .appt-stat-label { font-size: 11px; color: var(--gray-500); margin-top: 2px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px; }

      /* APPT SUBTABS */
      .appt-subtabs { display: flex; gap: 8px; margin-bottom: 16px; }
      .appt-subtab-btn { background: white; border: 1px solid var(--gray-100); padding: 8px 16px; border-radius: 8px; font-size: 13px; font-weight: 600; color: var(--gray-500); cursor: pointer; font-family: inherit; }
      .appt-subtab-btn.active { background: var(--navy); color: white; border-color: var(--navy); }
      .appt-subtab-content { display: none; }
      .appt-subtab-content.active { display: block; }

      .appt-list { display: flex; flex-direction: column; }
      .appt-row { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--gray-100); }
      .appt-row:last-child { border-bottom: none; }
      .appt-row.dimmed { opacity: 0.6; }
      .appt-date-block { width: 56px; height: 56px; border-radius: 10px; background: var(--navy); color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; }
      .appt-date-block.cancelled-block { background: var(--gray-300); }
      .appt-month { font-size: 10px; font-weight: 700; color: var(--sky); letter-spacing: 0.5px; }
      .appt-date-block.cancelled-block .appt-month { color: white; }
      .appt-day { font-size: 20px; font-weight: 800; line-height: 1; margin-top: 2px; }
      .appt-main { flex: 1; min-width: 0; }
      .appt-name-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; flex-wrap: wrap; }
      .appt-name { font-size: 16px; font-weight: 700; color: var(--navy); }
      .appt-detail { font-size: 13px; color: var(--gray-500); margin-top: 4px; }
      .appt-address { font-size: 13px; color: var(--gray-700); margin-top: 6px; }
      .appt-address-missing { font-size: 13px; color: #D97706; margin-top: 6px; font-weight: 600; }
      .appt-code { text-align: center; flex-shrink: 0; }
      .code-label { font-size: 10px; color: var(--gray-300); font-weight: 700; letter-spacing: 0.5px; }
      .code-value { font-size: 14px; font-weight: 800; color: var(--blue); font-family: monospace; margin-top: 2px; }
      .day-badge { font-size: 10px; font-weight: 800; padding: 3px 8px; border-radius: 100px; letter-spacing: 0.5px; }
      .day-badge.today { background: #DC2626; color: white; }
      .day-badge.tomorrow { background: #F59E0B; color: white; }

      .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(13,27,42,0.6); z-index: 100; align-items: center; justify-content: center; padding: 20px; }
      .modal.active { display: flex; }
      .modal-box { background: white; border-radius: 12px; padding: 24px; max-width: 500px; width: 100%; max-height: 80vh; overflow-y: auto; }
      .modal-title { font-size: 18px; font-weight: 700; margin-bottom: 16px; color: var(--navy); }
      .modal-close { cursor: pointer; color: var(--gray-300); font-size: 24px; line-height: 1; float: right; }
      .convo { background: var(--gray-50); border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.6; max-height: 300px; overflow-y: auto; }
      .msg { margin-bottom: 8px; display: flex; }
      .msg.customer { justify-content: flex-end; }
      .msg.assistant { justify-content: flex-start; }
      .bubble { display: inline-block; padding: 8px 12px; border-radius: 12px; max-width: 80%; word-break: break-word; }
      .customer .bubble { background: var(--navy); color: white; border-radius: 12px 12px 2px 12px; }
      .assistant .bubble { background: var(--gray-100); color: var(--navy); border-radius: 12px 12px 12px 2px; }
      .field { margin-bottom: 12px; }
      .field-label { font-size: 11px; color: var(--gray-300); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; font-weight: 700; }
      .field-value { font-size: 14px; color: var(--navy); }

      @media (max-width: 768px) {
        .analytics-grid { grid-template-columns: repeat(2, 1fr); }
        .summary-grid { grid-template-columns: 1fr; }
        .lead-name-line { flex-direction: column; align-items: flex-start; gap: 2px; }
        .lead-tags { flex-direction: row; }
        .appt-stats-strip { grid-template-columns: repeat(2, 1fr); }
        .appt-subtabs { flex-wrap: wrap; }
      }
    </style>
  </head>
  <body>
    <div class="nav">
      <div class="nav-title">Missed<span>Pro</span></div>
      <a href="/dashboard/logout">Sign out</a>
    </div>
    <div class="container">
      ${content}
    </div>
  </body>
  </html>`;
}

module.exports = router;