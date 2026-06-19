const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const db = require('../db/db');

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

router.get('/logout', (req, res) => {
  req.session.destroy();
  res.redirect('/dashboard/login');
});

router.post('/api/leads/:id/view', requireAuth, (req, res) => {
  db.prepare('UPDATE leads SET viewed = 1 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/', requireAuth, (req, res) => {
  if (req.session.role === 'admin') {
    const businesses = db.prepare('SELECT * FROM businesses ORDER BY created_at DESC').all();

    const businessCards = businesses.map(b => {
      const leadCount = db.prepare(`
        SELECT COUNT(*) as count FROM leads WHERE call_id IN (
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

  const leads = db.prepare(`
    SELECT * FROM leads WHERE call_id IN (
      SELECT id FROM calls WHERE to_number = ?
    ) ORDER BY created_at DESC
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
  const needsFollowUpCount = leads.filter(l => l.status === 'needs_followup').length;

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

  function statusLabel(status) {
    if (status === 'needs_followup') return 'Needs Follow-Up';
    if (status === 'scheduled') return 'Booked';
    if (status === 'new') return 'New';
    if (status === 'closed') return 'Closed';
    return status;
  }

  const leadCards = leads.map(l => {
    const isNew = !l.viewed;
    return `
    <div class="lead-row ${isNew ? 'is-new' : ''}" onclick="showLead('${l.id}')" data-lead-id="${l.id}">
      ${isNew ? '<div class="new-dot"></div>' : ''}
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
        <span class="tag-lg status-${l.status}">${statusLabel(l.status)}</span>
      </div>
    </div>
  `}).join('');

  const apptCards = appointments.map(a => {
    const startDate = new Date(a.start_time);
    return `
    <div class="appt-row">
      <div class="appt-date-block">
        <div class="appt-month">${startDate.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</div>
        <div class="appt-day">${startDate.getDate()}</div>
      </div>
      <div class="appt-main">
        <div class="appt-name-line">
          <span class="appt-name">${a.lead_name || 'Unknown'}</span>
          <span class="tag-lg status-${a.status}">${statusLabel(a.status)}</span>
        </div>
        <div class="appt-detail">${startDate.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })} · ${a.phone}</div>
        ${a.service_address
          ? `<div class="appt-address">📍 ${a.service_address}</div>`
          : `<div class="appt-address-missing">⚠️ Address not collected — needs follow-up</div>`}
      </div>
      <div class="appt-code">
        <div class="code-label">CODE</div>
        <div class="code-value">${a.confirmation_code || '-'}</div>
      </div>
    </div>
  `}).join('');

  const leadData = JSON.stringify(leads).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
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

    ${needsFollowUpCount > 0 ? `
    <div class="followup-banner">
      <span>⚠️</span>
      <span><strong>${needsFollowUpCount}</strong> lead${needsFollowUpCount > 1 ? 's need' : ' needs'} follow-up — missing information our AI could not collect.</span>
    </div>` : ''}

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('overview', this)">Overview</button>
      <button class="tab-btn" onclick="switchTab('leads', this)">Leads <span class="tab-count">${leads.length}</span></button>
      <button class="tab-btn" onclick="switchTab('appointments', this)">Appointments <span class="tab-count">${appointments.length}</span></button>
    </div>

    <div id="tab-overview" class="tab-content active">
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
    </div>

    <div id="tab-leads" class="tab-content">
      <div class="legend">
        <span class="legend-title">Legend:</span>
        <span class="legend-item"><span class="legend-dot" style="background:#1A6FDB"></span>New</span>
        <span class="legend-item"><span class="legend-dot" style="background:#16A34A"></span>Booked</span>
        <span class="legend-item"><span class="legend-dot" style="background:#D97706"></span>Needs Follow-Up</span>
        <span class="legend-item"><span class="legend-dot" style="background:#64748B"></span>Closed</span>
        <span class="legend-divider"></span>
        <span class="legend-item"><span class="legend-dot" style="background:#DC2626"></span>High Urgency</span>
        <span class="legend-item"><span class="legend-dot" style="background:#F59E0B"></span>Medium Urgency</span>
        <span class="legend-item"><span class="legend-dot" style="background:#16A34A"></span>Low Urgency</span>
      </div>
      <div class="section">
        ${leads.length === 0 ? '<div class="empty">No leads yet</div>' : `<div class="lead-list">${leadCards}</div>`}
      </div>
    </div>

    <div id="tab-appointments" class="tab-content">
      <div class="section">
        ${appointments.length === 0 ? '<div class="empty">No appointments yet</div>' : `<div class="appt-list">${apptCards}</div>`}
      </div>
    </div>

    <div class="modal" id="modal">
      <div class="modal-box">
        <span class="modal-close" onclick="closeModal()">×</span>
        <div class="modal-title" id="modal-title">Lead Details</div>
        <div id="modal-content"></div>
      </div>
    </div>

    <script>
      const leads = JSON.parse(\`${leadData}\`);

      function switchTab(tabName, btn) {
        document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
        document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
        document.getElementById('tab-' + tabName).classList.add('active');
        btn.classList.add('active');
      }

      async function showLead(id) {
        const lead = leads.find(l => l.id === id);
        if (!lead) return;

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

      function closeModal() {
        document.getElementById('modal').classList.remove('active');
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

      .followup-banner { background: #FFFBEB; border: 1px solid #FDE68A; color: #92400E; padding: 12px 16px; border-radius: 10px; font-size: 14px; margin-bottom: 20px; display: flex; align-items: center; gap: 10px; }

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

      .legend { background: white; border: 1px solid var(--gray-100); border-radius: 10px; padding: 12px 16px; margin-bottom: 16px; display: flex; flex-wrap: wrap; align-items: center; gap: 14px; font-size: 12px; color: var(--gray-700); }
      .legend-title { font-weight: 700; color: var(--navy); }
      .legend-item { display: flex; align-items: center; gap: 6px; }
      .legend-dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      .legend-divider { width: 1px; height: 16px; background: var(--gray-100); }

      .lead-list { display: flex; flex-direction: column; }
      .lead-row { display: flex; align-items: flex-start; gap: 14px; padding: 18px 20px; border-bottom: 1px solid var(--gray-100); cursor: pointer; transition: background 0.15s; position: relative; }
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

      .tag-lg { font-size: 13px; padding: 6px 14px; border-radius: 8px; font-weight: 700; text-transform: capitalize; white-space: nowrap; min-width: 90px; text-align: center; }
      .urgency-high { background: #DC2626; color: white; }
      .urgency-medium { background: #F59E0B; color: white; }
      .urgency-low { background: #16A34A; color: white; }
      .urgency-unknown { background: var(--gray-300); color: white; }
      .status-new { background: var(--blue); color: white; }
      .status-scheduled { background: #16A34A; color: white; }
      .status-needs_followup { background: #D97706; color: white; }
      .status-closed { background: var(--gray-500); color: white; }
      .status-cancelled { background: #DC2626; color: white; }

      .appt-list { display: flex; flex-direction: column; }
      .appt-row { display: flex; align-items: center; gap: 16px; padding: 18px 20px; border-bottom: 1px solid var(--gray-100); }
      .appt-row:last-child { border-bottom: none; }
      .appt-date-block { width: 56px; height: 56px; border-radius: 10px; background: var(--navy); color: white; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0; }
      .appt-month { font-size: 10px; font-weight: 700; color: var(--sky); letter-spacing: 0.5px; }
      .appt-day { font-size: 20px; font-weight: 800; line-height: 1; margin-top: 2px; }
      .appt-main { flex: 1; min-width: 0; }
      .appt-name-line { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
      .appt-name { font-size: 16px; font-weight: 700; color: var(--navy); }
      .appt-detail { font-size: 13px; color: var(--gray-500); margin-top: 4px; }
      .appt-address { font-size: 13px; color: var(--gray-700); margin-top: 6px; }
      .appt-address-missing { font-size: 13px; color: #D97706; margin-top: 6px; font-weight: 600; }
      .appt-code { text-align: center; flex-shrink: 0; }
      .code-label { font-size: 10px; color: var(--gray-300); font-weight: 700; letter-spacing: 0.5px; }
      .code-value { font-size: 14px; font-weight: 800; color: var(--blue); font-family: monospace; margin-top: 2px; }

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