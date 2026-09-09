const { google } = require('googleapis');
const db = require('../db/db');

const SCOPES = ['https://www.googleapis.com/auth/calendar.readonly'];

function isConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_REDIRECT_URI);
}

function makeOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

function getAuthUrl(businessId) {
  const oauth2 = makeOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: SCOPES,
    state: businessId,
  });
}

async function handleCallback(code, businessId) {
  const oauth2 = makeOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  const accessToken = tokens.access_token || null;
  const refreshToken = tokens.refresh_token || null;
  const expiry = tokens.expiry_date || null;

  if (refreshToken) {
    db.prepare(`
      UPDATE businesses SET
        google_access_token = ?,
        google_refresh_token = ?,
        google_token_expiry = ?,
        google_calendar_connected = 1
      WHERE id = ?
    `).run(accessToken, refreshToken, expiry, businessId);
  } else {
    db.prepare(`
      UPDATE businesses SET
        google_access_token = ?,
        google_token_expiry = ?,
        google_calendar_connected = 1
      WHERE id = ?
    `).run(accessToken, expiry, businessId);
  }

  return { success: true, gotRefreshToken: !!refreshToken };
}

function disconnect(businessId) {
  db.prepare(`
    UPDATE businesses SET
      google_access_token = NULL,
      google_refresh_token = NULL,
      google_token_expiry = NULL,
      google_calendar_connected = 0
    WHERE id = ?
  `).run(businessId);
  return { success: true };
}

function buildClient(business) {
  if (!business || !business.google_refresh_token) return null;

  const oauth2 = makeOAuthClient();
  oauth2.setCredentials({
    access_token: business.google_access_token || undefined,
    refresh_token: business.google_refresh_token,
    expiry_date: business.google_token_expiry || undefined,
  });

  oauth2.on('tokens', (tokens) => {
    try {
      if (tokens.access_token) {
        db.prepare(`
          UPDATE businesses SET
            google_access_token = ?,
            google_token_expiry = COALESCE(?, google_token_expiry),
            google_refresh_token = COALESCE(?, google_refresh_token)
          WHERE id = ?
        `).run(
          tokens.access_token,
          tokens.expiry_date || null,
          tokens.refresh_token || null,
          business.id
        );
      }
    } catch (e) {
      console.error('[googleCalendar] Failed to persist refreshed token:', e.message || e);
    }
  });

  return oauth2;
}

async function getBusyTimes(business, fromDate, toDate) {
  try {
    if (!business || !business.google_calendar_connected || !business.google_refresh_token) return [];
    const auth = buildClient(business);
    if (!auth) return [];

    try {
      await auth.getAccessToken();
    } catch (refreshErr) {
      console.error(`[googleCalendar] getAccessToken failed for business ${business.id}:`, refreshErr.message || refreshErr);
      return [];
    }

    const calendar = google.calendar({ version: 'v3', auth });
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin: fromDate.toISOString(),
        timeMax: toDate.toISOString(),
        items: [{ id: 'primary' }],
      },
    });

    const cal = res.data.calendars && res.data.calendars.primary;
    const busy = (cal && cal.busy) || [];
    return busy.map(b => ({ start: new Date(b.start), end: new Date(b.end) }));
  } catch (err) {
    console.error(`[googleCalendar] getBusyTimes failed for business ${business && business.id}:`, err.message || err);
    return [];
  }
}

module.exports = {
  isConfigured,
  getAuthUrl,
  handleCallback,
  disconnect,
  getBusyTimes,
};