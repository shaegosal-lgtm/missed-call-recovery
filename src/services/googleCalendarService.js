const { google } = require('googleapis');
const db = require('../db/db');

// ---------------------------------------------------------------------------
// Google Calendar sync service (v2 - more robust token handling).
// Reads a business's Google Calendar busy times so the AI never books over
// an existing event.
//
// Env: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
// Per-business columns: google_access_token, google_refresh_token,
//   google_token_expiry, google_calendar_connected
// ---------------------------------------------------------------------------

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
    prompt: 'consent',           // force a fresh refresh token every time
    scope: SCOPES,
    state: businessId,
  });
}

// Exchange the code for tokens and store them. If Google returns a refresh
// token, we OVERWRITE the stored one (a fresh consent always issues a new
// refresh token; keeping a stale one causes invalid_grant).
async function handleCallback(code, businessId) {
  const oauth2 = makeOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  const accessToken = tokens.access_token || null;
  const refreshToken = tokens.refresh_token || null; // may be null if Google withholds it
  const expiry = tokens.expiry_date || null;

  if (refreshToken) {
    // Got a fresh refresh token — overwrite everything cleanly.
    db.prepare(`
      UPDATE businesses SET
        google_access_token = ?,
        google_refresh_token = ?,
        google_token_expiry = ?,
        google_calendar_connected = 1
      WHERE id = ?
    `).run(accessToken, refreshToken, expiry, businessId);
  } else {
    // No new refresh token returned — keep the existing one but update access token.
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

// Build an authorized client. Sets whatever credentials we have and lets the
// googleapis library handle refreshing automatically via the refresh token.
// Persists any newly-refreshed access token back to the DB via the 'tokens' event.
function buildClient(business) {
  if (!business || !business.google_refresh_token) return null;

  const oauth2 = makeOAuthClient();
  oauth2.setCredentials({
    access_token: business.google_access_token || undefined,
    refresh_token: business.google_refresh_token,
    expiry_date: business.google_token_expiry || undefined,
  });

  // When the library refreshes the access token, save it.
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

// Return busy time ranges from the business's Google Calendar between two Dates.
// Fail-open: returns [] on any problem so the AI still works.
async function getBusyTimes(business, fromDate, toDate) {
  try {
    if (!business || !business.google_calendar_connected || !business.google_refresh_token) return [];
    const auth = buildClient(business);
    if (!auth) return [];

    // Force a token refresh up front so we always send a valid access token.
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