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
        body { font-family: -apple-system, sans-serif; background: #f5f5f5; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
        .card { background: white; padding: 40px; border-radius: 12px; box-shadow: 0 2px 12px rgba(0,0,0,0.1); width: 100%; max-width: 400px; }
        h1 { font-size: 22px; margin-bottom: 8px; color: #111; }
        p { color: #666; font-size: 14px; margin-bottom: 24px; }
        label { display: block; font-size: 13px; font-weight: 500; color: #333; margin-bottom: 6px; }
        input { width: 100%; padding: 10px 14px; border: 1px solid #ddd; border-radius: 8px; font-size: 15px; margin-bottom: 16px; }
        button { width: 100%; padding: 12px; background: #111; color: white; border: none; border-radius: 8px; font-size: 15px; font-weight: 500; cursor: pointer; }
        button:hover { background: #333; }
        .error { color: #e53e3e; font-size: 13px; margin-bottom: 16px; background: #fff5f5; padding: 10px 12px; border-radius: 6px; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Missed Call Recovery</h1>
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
        <a href="/dashboard/business/${b.id}" class="card">
          <div class="card-header">
            <div>
              <div class="card-title">${b.name}</div>
              <div class="card-sub">${b.twilio_number}</div>
            </div>
            <div class="badge">${leadCount} leads</div>
          </div>
          <div class="card-stats">
            <div class="stat"><span class="stat-num">${leadCount}</span><span class="stat-label">Total Leads</span></div>
            <div class="stat"><span class="stat-num">${apptCount}</span><span class="stat-label">Upcoming Appts</span></div>
          </div>
        </a>
      `;
    }).join('');

    return res.send(renderPage('Admin Dashboard', `
      <h2>Businesses</h2>
      ${businesses.length === 0 ? '<div class="empty">No businesses yet.</div>' : businessCards}
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

  // ANALYTICS CALCULATIONS
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

  // Last 7 days lead count for simple trend
  const last7Days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const dayStr = d.toISOString().split('T')[0];
    const count = leads.filter(l => l.created_at.startsWith(dayStr)).length;
    last7Days.push({ label: d.toLocaleDateString('en-US', { weekday: 'short' }), count });
  }
  const maxDayCount = Math.max(...last7Days.map(d => d.count), 1);

  const urgencyColor = { high: '#e53e3e', medium: '#d69e2e', low: '#38a169', unknown: '#999' };

  const leadRows = leads.map(l => `
    <tr onclick="showLead('${l.id}')" style="cursor:pointer">
      <td>${l.name || '<span style="color:#999">Unknown</span>'}</td>
      <td>${l.phone}</td>
      <td><span class="badge" style="background:${urgencyColor[l.urgency] || '#999'}20;color:${urgencyColor[l.urgency] || '#999'}">${l.urgency}</span></td>
      <td>${l.lead_type}</td>
      <td>${l.status}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${l.ai_summary || '-'}</td>
      <td>${new Date(l.created_at).toLocaleDateString()}</td>
    </tr>
  `).join('');

  const apptRows = appointments.map(a => `
    <tr>
      <td>${a.lead_name || '-'}</td>
      <td>${a.phone}</td>
      <td>${new Date(a.start_time).toLocaleDateString()}</td>
      <td>${new Date(a.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}</td>
      <td><span class="badge">${a.status}</span></td>
      <td>${a.confirmation_code || '-'}</td>
      <td>${a.service_address || '<span style="color:#999">Pending</span>'}</td>
    </tr>
  `).join('');

  const leadData = JSON.stringify(leads).replace(/\\/g, '\\\\').replace(/`/g, '\\`');
  const backLink = req.session.role === 'admin' ? '<a href="/dashboard" class="back">← All businesses</a>' : '';

  const trendBars = last7Days.map(d => `
    <div style="display:flex;flex-direction:column;align-items:center;gap:6px;flex:1;">
      <div style="width:100%;max-width:32px;height:80px;display:flex;align-items:flex-end;">
        <div style="width:100%;background:#1A6FDB;border-radius:4px 4px 0 0;height:${(d.count / maxDayCount) * 100}%;min-height:${d.count > 0 ? '4px' : '0'};"></div>
      </div>
      <div style="font-size:11px;color:#999;">${d.label}</div>
      <div style="font-size:11px;color:#333;font-weight:600;">${d.count}</div>
    </div>
  `).join('');

  return res.send(renderPage(business.name, `
    ${backLink}
    <h2>${business.name}</h2>
    <div class="sub">${business.twilio_number} · ${business.timezone}</div>

    <div class="tabs">
      <button class="tab-btn active" onclick="switchTab('overview', this)">Overview</button>
      <button class="tab-btn" onclick="switchTab('leads', this)">Leads</button>
      <button class="tab-btn" onclick="switchTab('appointments', this)">Appointments</button>
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

      <div class="section" style="margin-top:24px;">
        <div class="section-header">Leads — Last 7 Days</div>
        <div style="padding:24px;display:flex;gap:12px;align-items:flex-end;">
          ${trendBars}
        </div>
      </div>

      <div class="section" style="margin-top:24px;">
        <div class="section-header">All-Time Summary</div>
        <div style="padding:20px;display:grid;grid-template-columns:repeat(2,1fr);gap:16px;">
          <div>
            <div style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Total Leads</div>
            <div style="font-size:24px;font-weight:700;color:#111;margin-top:4px;">${totalLeadsAllTime}</div>
          </div>
          <div>
            <div style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Total Appointments</div>
            <div style="font-size:24px;font-weight:700;color:#111;margin-top:4px;">${totalApptsAllTime}</div>
          </div>
          <div>
            <div style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Total Revenue Recovered</div>
            <div style="font-size:24px;font-weight:700;color:#16a34a;margin-top:4px;">$${revenueRecoveredAllTime.toLocaleString()}</div>
          </div>
          <div>
            <div style="font-size:12px;color:#999;text-transform:uppercase;letter-spacing:0.5px;">Avg Job Value</div>
            <div style="font-size:24px;font-weight:700;color:#111;margin-top:4px;">$${avgJobValue}</div>
          </div>
        </div>
      </div>

      <div class="section" style="margin-top:24px;">
        <div class="section-header">Lead Urgency Breakdown</div>
        <div style="padding:20px;display:flex;gap:24px;">
          <div style="text-align:center;">
            <div style="width:48px;height:48px;border-radius:50%;background:#fee2e2;color:#e53e3e;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;margin:0 auto;">${urgencyBreakdown.high}</div>
            <div style="font-size:12px;color:#999;margin-top:6px;">High</div>
          </div>
          <div style="text-align:center;">
            <div style="width:48px;height:48px;border-radius:50%;background:#fef3c7;color:#d69e2e;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;margin:0 auto;">${urgencyBreakdown.medium}</div>
            <div style="font-size:12px;color:#999;margin-top:6px;">Medium</div>
          </div>
          <div style="text-align:center;">
            <div style="width:48px;height:48px;border-radius:50%;background:#dcfce7;color:#16a34a;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;margin:0 auto;">${urgencyBreakdown.low}</div>
            <div style="font-size:12px;color:#999;margin-top:6px;">Low</div>
          </div>
        </div>
      </div>
    </div>

    <div id="tab-leads" class="tab-content">
      <div class="section">
        <div class="section-header">Leads (${leads.length})</div>
        ${leads.length === 0 ? '<div class="empty">No leads yet</div>' : `
        <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Phone</th><th>Urgency</th><th>Type</th><th>Status</th><th>Summary</th><th>Date</th>
            </tr>
          </thead>
          <tbody>${leadRows}</tbody>
        </table>
        </div>`}
      </div>
    </div>

    <div id="tab-appointments" class="tab-content">
      <div class="section">
        <div class="section-header">Appointments (${appointments.length})</div>
        ${appointments.length === 0 ? '<div class="empty">No appointments yet</div>' : `
        <div style="overflow-x:auto">
        <table>
          <thead>
            <tr>
              <th>Name</th><th>Phone</th><th>Date</th><th>Time</th><th>Status</th><th>Code</th><th>Address</th>
            </tr>
          </thead>
          <tbody>${apptRows}</tbody>
        </table>
        </div>`}
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

      function showLead(id) {
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
      body { font-family: -apple-system, sans-serif; background: #f5f5f5; color: #111; }
      .nav { background: white; padding: 16px 24px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between; align-items: center; }
      .nav-title { font-size: 18px; font-weight: 600; }
      .nav a { color: #666; font-size: 14px; text-decoration: none; }
      .container { max-width: 1100px; margin: 0 auto; padding: 32px 24px; }
      .back { color: #666; font-size: 14px; text-decoration: none; display: inline-block; margin-bottom: 20px; }
      h2 { font-size: 22px; margin-bottom: 4px; }
      .sub { color: #666; font-size: 14px; margin-bottom: 24px; }
      .card { background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; text-decoration: none; color: inherit; display: block; border: 1px solid #eee; transition: box-shadow 0.2s; }
      .card:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.08); }
      .card-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
      .card-title { font-size: 16px; font-weight: 600; }
      .card-sub { font-size: 13px; color: #666; margin-top: 2px; }
      .card-stats { display: flex; gap: 24px; }
      .stat { display: flex; flex-direction: column; }
      .stat-num { font-size: 22px; font-weight: 600; }
      .stat-label { font-size: 12px; color: #666; margin-top: 2px; }
      .badge { font-size: 12px; padding: 3px 8px; border-radius: 20px; background: #f0f0f0; color: #333; }
      .section { background: white; border-radius: 12px; border: 1px solid #eee; margin-bottom: 24px; overflow: hidden; }
      .section-header { padding: 16px 20px; border-bottom: 1px solid #eee; font-weight: 600; font-size: 15px; }
      table { width: 100%; border-collapse: collapse; }
      th { padding: 10px 16px; text-align: left; font-size: 12px; color: #666; font-weight: 500; border-bottom: 1px solid #eee; background: #fafafa; white-space: nowrap; }
      td { padding: 12px 16px; font-size: 14px; border-bottom: 1px solid #f5f5f5; }
      tr:last-child td { border-bottom: none; }
      tr:hover td { background: #fafafa; }
      .empty { padding: 40px; text-align: center; color: #999; font-size: 14px; }
      .modal { display: none; position: fixed; top: 0; left: 0; right: 0; bottom: 0; background: rgba(0,0,0,0.5); z-index: 100; align-items: center; justify-content: center; }
      .modal.active { display: flex; }
      .modal-box { background: white; border-radius: 12px; padding: 24px; max-width: 500px; width: 90%; max-height: 80vh; overflow-y: auto; }
      .modal-title { font-size: 18px; font-weight: 600; margin-bottom: 16px; display: flex; justify-content: space-between; align-items: center; }
      .modal-close { cursor: pointer; color: #999; font-size: 24px; line-height: 1; }
      .convo { background: #f5f5f5; border-radius: 8px; padding: 12px; font-size: 13px; line-height: 1.6; max-height: 300px; overflow-y: auto; }
      .msg { margin-bottom: 8px; display: flex; }
      .msg.customer { justify-content: flex-end; }
      .msg.assistant { justify-content: flex-start; }
      .bubble { display: inline-block; padding: 8px 12px; border-radius: 12px; max-width: 80%; word-break: break-word; }
      .customer .bubble { background: #111; color: white; border-radius: 12px 12px 2px 12px; }
      .assistant .bubble { background: #e5e5ea; color: #111; border-radius: 12px 12px 12px 2px; }
      .field { margin-bottom: 12px; }
      .field-label { font-size: 11px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; }
      .field-value { font-size: 14px; }
      .tabs { display: flex; gap: 4px; margin-bottom: 20px; border-bottom: 1px solid #eee; }
      .tab-btn { background: none; border: none; padding: 10px 16px; font-size: 14px; font-weight: 500; color: #666; cursor: pointer; border-bottom: 2px solid transparent; margin-bottom: -1px; font-family: inherit; }
      .tab-btn.active { color: #111; border-bottom-color: #1A6FDB; }
      .tab-content { display: none; }
      .tab-content.active { display: block; }
      .analytics-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; }
      .analytics-card { background: white; border-radius: 12px; border: 1px solid #eee; padding: 20px; }
      .analytics-card.highlight { background: #0D1B2A; border-color: #0D1B2A; }
      .analytics-card.highlight .analytics-label { color: rgba(255,255,255,0.6); }
      .analytics-card.highlight .analytics-value { color: #4A9FFF; }
      .analytics-label { font-size: 12px; color: #999; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
      .analytics-value { font-size: 28px; font-weight: 700; color: #111; }
      @media (max-width: 768px) {
        .analytics-grid { grid-template-columns: repeat(2, 1fr); }
      }
    </style>
  </head>
  <body>
    <div class="nav">
      <div class="nav-title">Missed Call Recovery</div>
      <a href="/dashboard/logout">Sign out</a>
    </div>
    <div class="container">
      ${content}
    </div>
  </body>
  </html>`;
}

module.exports = router;