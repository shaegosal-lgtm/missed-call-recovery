const { google } = require('googleapis');
const db = require('../db/db');

// ---------------------------------------------------------------------------
// Google Calendar sync service.
// Lets a business connect their Google Calendar so the AI reads their real
// busy times and never books over an existing event.
//
// Requires env vars: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI
// Tokens are stored per-business in the businesses table (added via migration):
//   google_access_token, google_refresh_token, google_token_expiry, google_calendar_connected
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

// Build the URL we send a business owner to, so they grant calendar access.
// We pack the businessId into "state" so the callback knows who connected.
function getAuthUrl(businessId) {
  const oauth2 = makeOAuthClient();
  return oauth2.generateAuthUrl({
    access_type: 'offline',      // gets us a refresh token
    prompt: 'consent',           // ensures a refresh token is returned every time
    scope: SCOPES,
    state: businessId,
  });
}

// After the owner grants access, Google redirects back with a code.
// Exchange it for tokens and store them on the business.
async function handleCallback(code, businessId) {
  const oauth2 = makeOAuthClient();
  const { tokens } = await oauth2.getToken(code);

  const accessToken = tokens.access_token || null;
  const refreshToken = tokens.refresh_token || null;
  const expiry = tokens.expiry_date || null; // ms timestamp

  db.prepare(`
    UPDATE businesses SET
      google_access_token = ?,
      google_refresh_token = COALESCE(?, google_refresh_token),
      google_token_expiry = ?,
      google_calendar_connected = 1
    WHERE id = ?
  `).run(accessToken, refreshToken, expiry, businessId);

  return { success: true };
}

// Disconnect a business's Google Calendar.
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

// Get an authorized client for a business, refreshing the access token if needed.
// Returns null if the business hasn't connected or refresh fails.
async function getAuthorizedClient(business) {
  if (!business || !business.google_refresh_token) return null;

  const oauth2 = makeOAuthClient();
  oauth2.setCredentials({
    access_token: business.google_access_token || undefined,
    refresh_token: business.google_refresh_token,
    expiry_date: business.google_token_expiry || undefined,
  });

  // If the token is expired or close to it, refresh proactively.
  const now = Date.now();
  const expiry = business.google_token_expiry || 0;
  if (!business.google_access_token || now >= expiry - 60000) {
    try {
      const { credentials } = await oauth2.refreshAccessToken();
      oauth2.setCredentials(credentials);
      // Persist the refreshed token.
      db.prepare(`
        UPDATE businesses SET
          google_access_token = ?,
          google_token_expiry = ?,
          google_refresh_token = COALESCE(?, google_refresh_token)
        WHERE id = ?
      `).run(
        credentials.access_token || null,
        credentials.expiry_date || null,
        credentials.refresh_token || null,
        business.id
      );
    } catch (err) {
      console.error(`[googleCalendar] Token refresh failed for business ${business.id}:`, err.message || err);
      return null;
    }
  }

  return oauth2;
}

// Return the busy time ranges from the business's Google Calendar between
// two Date objects. Each item is { start: Date, end: Date }.
// Returns [] if not connected or on any error (fail-open: better to allow
// booking than to break the AI entirely).
async function getBusyTimes(business, fromDate, toDate) {
  try {
    if (!business || !business.google_calendar_connected) return [];
    const auth = await getAuthorizedClient(business);
    if (!auth) return [];

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
  getAuthorizedClient,
  getBusyTimes,
};