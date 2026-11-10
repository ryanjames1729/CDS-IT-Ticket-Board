/**
 * CDS IT Dashboard — Node.js Server
 * ──────────────────────────────────
 * Usage:
 *   npm install
 *   node server.js
 *   Open http://localhost:3000
 *
 * Endpoints:
 *   GET  /api/data          → returns current dashboard data
 *   POST /api/sync-cw       → triggers Playwright scraper, updates data
 *   POST /api/upload-hf     → accepts HappyFox CSV file, parses, updates data
 *   POST /api/update-dedup  → accepts updated dedup stats from the client
 *   POST /api/sync-teams    → pulls messages from Teams chat via Graph API
 *   POST /api/sync-hf       → pulls tickets from the HappyFox API
 *   POST /api/sync-all      → starts a background ConnectWise + HappyFox + Teams sync (for cron jobs)
 *   POST /api/login         → exchanges the dashboard password for a session cookie
 *   POST /api/logout        → ends the session
 *
 * Every /api route except login/logout requires a signed session cookie.
 *
 * Automation:
 *   Set AUTO_SYNC_HOURS to re-sync ConnectWise, HappyFox and Teams on a schedule.
 *   Every sync records a daily snapshot in data.history for the trend chart.
 */

require('dotenv').config();
const express   = require('express');
const multer    = require('multer');
const { parse } = require('csv-parse/sync');
const path      = require('path');
const https     = require('https');
const crypto    = require('crypto');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const PORT   = process.env.PORT || 3000;

// ── Supabase client ───────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.disable('x-powered-by');
app.set('trust proxy', 1);             // behind Render's proxy: lets req.secure / req.ip work
app.use(express.json({ limit: '100kb' }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'no-referrer' });
  next();
});

// ── Authentication ────────────────────────────────────────────────────────────
// The password lives only in the DASHBOARD_PASSWORD environment variable. A correct
// login sets an HttpOnly cookie signed with a key derived from that password, so
// changing the password signs everyone out.

const PASSWORD       = process.env.DASHBOARD_PASSWORD || '';
const SESSION_COOKIE = 'cds_session';
const SESSION_DAYS   = 30;
const SESSION_KEY    = crypto.createHash('sha256')
  .update(`cds-dashboard-session:${process.env.SESSION_SECRET || ''}:${PASSWORD}`).digest();

const sha256 = v => crypto.createHash('sha256').update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));
const signSession = expires =>
  `${expires}.${crypto.createHmac('sha256', SESSION_KEY).update(String(expires)).digest('base64url')}`;

function hasSession(req) {
  const match = (req.headers.cookie || '').match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
  if (!match || !PASSWORD) return false;
  const expires = parseInt(match[1], 10);
  return expires > Date.now() && safeEqual(match[1], signSession(expires));
}

function setSessionCookie(req, res, value, maxAgeSeconds) {
  res.set('Set-Cookie', `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}` +
    (req.secure ? '; Secure' : ''));
}

// Slow down password guessing: 8 wrong attempts per address, then a 15-minute wait
const LOGIN_MAX_FAILS = 8, LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFails = new Map();

app.post('/api/login', (req, res) => {
  if (!PASSWORD) {
    return res.status(503).json({ success: false, error: 'DASHBOARD_PASSWORD is not set on the server, so nobody can sign in yet.' });
  }
  const now = Date.now();
  let rec = loginFails.get(req.ip);
  if (rec && rec.resetAt < now) { loginFails.delete(req.ip); rec = null; }
  if (rec && rec.count >= LOGIN_MAX_FAILS) {
    const minutes = Math.ceil((rec.resetAt - now) / 60000);
    return res.status(429).json({ success: false, error: `Too many attempts. Try again in ${minutes} minute${minutes === 1 ? '' : 's'}.` });
  }
  if (!safeEqual((req.body && req.body.password) || '', PASSWORD)) {
    if (!rec) { rec = { count: 0, resetAt: now + LOGIN_WINDOW_MS }; loginFails.set(req.ip, rec); }
    rec.count++;
    if (loginFails.size > 5000) loginFails.clear();
    return res.status(401).json({ success: false, error: 'Incorrect password. Please try again.' });
  }
  loginFails.delete(req.ip);
  setSessionCookie(req, res, signSession(now + SESSION_DAYS * 86400000), SESSION_DAYS * 86400);
  res.json({ success: true });
});

app.post('/api/logout', (req, res) => {
  setSessionCookie(req, res, '', 0);
  res.json({ success: true });
});

// Everything else under /api needs a session. A scheduler may call /api/sync-all
// with the CRON_SECRET instead (x-cron-secret header).
app.use('/api', (req, res, next) => {
  const cron = process.env.CRON_SECRET;
  if (req.path === '/sync-all' && cron && safeEqual(req.get('x-cron-secret') || '', cron)) return next();
  if (!PASSWORD) {
    return res.status(503).json({ success: false, code: 'not_configured', error: 'DASHBOARD_PASSWORD is not set on the server, so the dashboard is locked. Add it to the environment and restart.' });
  }
  if (hasSession(req)) return next();
  res.status(401).json({ success: false, code: 'login_required', error: 'Please sign in.' });
});

// Serve only the dashboard page and its logo — not the server source or config files
const sendPage = (req, res) => res.sendFile(path.join(__dirname, 'index.html'));
app.get('/', sendPage);
app.get('/index.html', sendPage);
app.get('/cds-logo.png', (req, res) => res.sendFile(path.join(__dirname, 'cds-logo.png')));

// ── Helpers ───────────────────────────────────────────────────────────────────

async function readData() {
  const { data, error } = await supabase
    .from('dashboard_data')
    .select('data')
    .eq('id', 1)
    .single();

  // PGRST116 = no row yet (first run). Any other error must not look like "empty",
  // or the next save would overwrite everything that is stored.
  if (error && error.code !== 'PGRST116') throw new Error(`Supabase read error: ${error.message}`);
  if (!data || !data.data) {
    return { cw: [], hf: [], linked: [], dedupStats: null, lastUpdated: null, teams: [], history: [] };
  }
  return data.data;
}

async function writeData(payload) {
  const { error } = await supabase
    .from('dashboard_data')
    .upsert({ id: 1, data: payload, updated_at: new Date().toISOString() });

  if (error) throw new Error(`Supabase write error: ${error.message}`);
}

// ── History snapshots (feeds the Backlog Trend chart) ─────────────────────────

const HF_CLOSED_STATUSES = new Set(['closed', 'resolved', 'completed', 'archived', 'solved']);
const HISTORY_DAYS = 400;

const openCw = list => (list || []).filter(t => !t.closed);
const openHf = list => (list || []).filter(t => !t.closed && !HF_CLOSED_STATUSES.has((t.status || '').toLowerCase()));

// Today's date in the school's time zone, as YYYY-MM-DD
function localDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: process.env.DASHBOARD_TZ || 'America/New_York' }).format(new Date());
}

// Record one snapshot per day. `prev` holds the ticket lists being replaced, so we can
// count how many tickets were opened and closed since the previous sync.
function recordSnapshot(data, prev = {}) {
  const cw = openCw(data.cw), hf = openHf(data.hf);
  let opened = 0, closed = 0;
  const diff = (before, after, idOf) => {
    if (!before || !before.length) return;
    const was = new Set(before.map(idOf)), is = new Set(after.map(idOf));
    is.forEach(id => { if (!was.has(id)) opened++; });
    was.forEach(id => { if (!is.has(id)) closed++; });
  };
  if (prev.cw) diff(openCw(prev.cw), cw, t => t.num);
  if (prev.hf) diff(openHf(prev.hf), hf, t => t.id);

  const history = Array.isArray(data.history) ? data.history : [];
  const today = localDate();
  let entry = history.find(h => h.date === today);
  if (!entry) { entry = { date: today, opened: 0, closed: 0 }; history.push(entry); }
  Object.assign(entry, {
    cwOpen: cw.length,
    hfOpen: hf.length,
    critical: cw.filter(t => t.priority === 'P1' || t.priority === 'P2').length +
              hf.filter(t => t.priority === 'Critical' || t.priority === 'Urgent').length,
    unassigned: cw.filter(t => /(^|,)\s*unassigned\s*(,|$)/i.test(t.resources || 'Unassigned')).length,
  });
  entry.opened += opened;
  entry.closed += closed;
  data.history = history.slice(-HISTORY_DAYS);
}

// Remember why a sync failed so the Sync page can show it
async function noteSyncError(key, err) {
  try {
    const data = await readData();
    data[key] = { message: err.message, at: new Date().toISOString() };
    await writeData(data);
  } catch (e) {
    console.error('[server] Could not record sync error:', e.message);
  }
}

// ── ConnectWise sync ──────────────────────────────────────────────────────────

let cwSyncRunning = false;

async function runCwSync() {
  if (cwSyncRunning) {
    const err = new Error('A ConnectWise sync is already running — give it a couple of minutes.');
    err.status = 409;
    throw err;
  }
  cwSyncRunning = true;
  try {
    const { scrapeConnectWise } = require('./scraper');
    console.log('[server] Starting ConnectWise scrape…');
    const tickets = await scrapeConnectWise();

    // An empty result means the login or the portal layout failed, not that every
    // ticket vanished. Keep the stored tickets instead of wiping them.
    if (!tickets.length) {
      throw new Error('ConnectWise returned 0 tickets — the login may have failed or the portal layout changed. The existing tickets were kept.');
    }

    const data = await readData();
    const prev = { cw: data.cw };
    data.cw = tickets;
    data.cwLastSync = new Date().toISOString();
    data.lastUpdated = new Date().toISOString();
    delete data.cwLastError;
    recordSnapshot(data, prev);
    await writeData(data);

    console.log(`[server] CW sync complete — ${tickets.length} tickets saved.`);
    return tickets.length;
  } catch (err) {
    console.error('[server] CW sync error:', err.message);
    await noteSyncError('cwLastError', err);
    throw err;
  } finally {
    cwSyncRunning = false;
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Return current ticket data, plus the server's sync state
app.get('/api/data', async (req, res) => {
  try {
    const data = await readData();
    res.json({
      ...data,
      _server: {
        cwSyncing: cwSyncRunning,
        hfSyncing: hfSyncRunning,
        hfApiConfigured: hfApiConfigured(),
        autoSyncHours: AUTO_SYNC_HOURS,
        nextAutoSync: nextAutoSync ? nextAutoSync.toISOString() : null,
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Trigger ConnectWise Playwright scrape
app.post('/api/sync-cw', async (req, res) => {
  try {
    res.json({ success: true, count: await runCwSync() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Accept HappyFox CSV export
app.post('/api/upload-hf', upload.single('csv'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  try {
    const records = parse(req.file.buffer, {
      relax_column_count: true,
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });

    const tickets = records.map(r => ({
      id:       (r['Ticket ID'] || r['Id'] || r['ID'] || '').replace(/^#/, ''),
      title:    r['Ticket Subject'] || r['Subject'] || r['Title'] || r['title'] || '',
      priority: r['Ticket Priority'] || r['Priority'] || r['priority'] || 'Low',
      status:   r['Ticket Status']   || r['Status']   || r['status']   || 'New',
      assignee: r['Assigned Agent Email'] || r['Assignee'] || r['Agent'] || '',
      contact:  r['Contact Name'] || r['Contact'] || r['Requester'] || '',
      created:  r['Created At']   || r['Created'] || r['Date'] || '',
      category: r['Ticket Category'] || r['Category'] || '',
    })).filter(t => t.id && t.title);

    if (!tickets.length) {
      return res.status(400).json({
        success: false,
        error: 'No tickets found in that file — it needs "Ticket ID" and "Subject" columns. The existing tickets were kept.',
      });
    }

    const data = await readData();
    const prev = { hf: data.hf };
    data.hf = tickets;
    data.hfLastSync = new Date().toISOString();
    data.hfSource = 'csv';
    data.lastUpdated = new Date().toISOString();
    recordSnapshot(data, prev);
    await writeData(data);

    console.log(`[server] HF upload complete — ${tickets.length} tickets saved.`);
    res.json({ success: true, count: tickets.length });
  } catch (err) {
    console.error('[server] HF parse error:', err.message);
    res.status(500).json({ success: false, error: `CSV parse error: ${err.message}` });
  }
});

// ── HappyFox API sync ─────────────────────────────────────────────────────────
// Needs HF_ACCOUNT (the "yourschool" in yourschool.happyfox.com, or a full URL),
// plus an API key and auth code from HappyFox → Manage → Integrations → API.

const hfApiConfigured = () => !!(process.env.HF_ACCOUNT && process.env.HF_API_KEY && process.env.HF_AUTH_CODE);
const HF_PAGE_SIZE = 50, HF_MAX_PAGES = 200, HF_KEEP_CLOSED = 3000;
let hfSyncRunning = false;

function hfBaseUrl() {
  const account = process.env.HF_ACCOUNT.trim().replace(/\/+$/, '');
  if (/^https?:\/\//i.test(account)) return account;
  return `https://${account.includes('.') ? account : account + '.happyfox.com'}`;
}

async function hfGet(pathAndQuery, attempt = 1) {
  const auth = Buffer.from(`${process.env.HF_API_KEY}:${process.env.HF_AUTH_CODE}`).toString('base64');
  const res = await fetch(hfBaseUrl() + pathAndQuery, {
    headers: { Authorization: `Basic ${auth}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(30000),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    const wait = (parseInt(res.headers.get('retry-after'), 10) || 2 ** attempt) * 1000;
    await new Promise(r => setTimeout(r, Math.min(wait, 30000)));
    return hfGet(pathAndQuery, attempt + 1);
  }
  if (res.status === 401 || res.status === 403) throw new Error('HappyFox rejected the API key / auth code (HTTP ' + res.status + ').');
  if (res.status === 404) throw new Error('HappyFox API not found at ' + hfBaseUrl() + ' — check HF_ACCOUNT.');
  if (!res.ok) throw new Error(`HappyFox API error (HTTP ${res.status}).`);
  return res.json();
}

// HappyFox returns nested objects ({ name: "High" }) for most fields; accept plain strings too
const hfName = v => (v == null ? '' : typeof v === 'object' ? String(v.name || v.email || '') : String(v));

// API timestamps have no zone and are UTC — make that explicit for the browser
function hfTime(v) {
  if (!v) return '';
  const m = String(v).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)(?:\.\d+)?$/);
  return m ? `${m[1]}T${m[2]}Z` : String(v);
}

function mapHfTicket(t) {
  const behavior = t.status && typeof t.status === 'object' ? String(t.status.behavior || '') : '';
  const status = hfName(t.status) || 'New';
  return {
    id:       String(t.display_id || t.id || '').replace(/^#/, ''),
    title:    t.subject || '',
    priority: hfName(t.priority) || 'Low',
    status,
    assignee: hfName(t.assigned_to),
    contact:  hfName(t.user),
    created:  hfTime(t.created_at),
    updated:  hfTime(t.last_updated_at || t.last_modified),
    category: hfName(t.category),
    closed:   behavior === 'completed' || HF_CLOSED_STATUSES.has(status.toLowerCase()),
    unresponded: t.unresponded === true,
    slaBreaches: Number(t.sla_breaches) || 0,
  };
}

async function fetchHappyFoxTickets() {
  const tickets = [];
  let fields = [];
  for (let page = 1; page <= HF_MAX_PAGES; page++) {
    const body = await hfGet(`/api/1.1/json/tickets/?size=${HF_PAGE_SIZE}&page=${page}`);
    const rows = Array.isArray(body) ? body : (body.data || []);
    if (page === 1 && rows[0]) fields = Object.keys(rows[0]);
    tickets.push(...rows.map(mapHfTicket).filter(t => t.id && t.title));
    const pageCount = body.page_info && body.page_info.page_count;
    if (!rows.length || (pageCount ? page >= pageCount : rows.length < HF_PAGE_SIZE)) break;
  }
  return { tickets, fields };
}

async function runHfSync() {
  const fail = (message, status) => Object.assign(new Error(message), { status });
  if (!hfApiConfigured()) throw fail('HappyFox API not configured — add HF_ACCOUNT, HF_API_KEY and HF_AUTH_CODE to the environment, or upload a CSV instead.', 400);
  if (hfSyncRunning) throw fail('A HappyFox sync is already running.', 409);
  hfSyncRunning = true;
  try {
    console.log('[happyfox] Fetching tickets…');
    const { tickets, fields } = await fetchHappyFoxTickets();
    if (!tickets.length) throw new Error('HappyFox returned 0 tickets — the existing tickets were kept.');
    console.log(`[happyfox] Ticket fields returned by the API: ${fields.join(', ')}`);

    const data = await readData();
    const prev = { hf: data.hf };

    // The API lists pending tickets. Anything we had before that is no longer listed has
    // been closed, so keep it (marked closed) for the recurring-issue analysis.
    const fetched = new Set(tickets.map(t => t.id));
    const gone = (data.hf || []).filter(t => !fetched.has(t.id))
      .map(t => (t.closed ? t : { ...t, closed: true, status: 'Closed', closedSeen: new Date().toISOString() }));
    data.hf = [...tickets, ...gone.slice(0, HF_KEEP_CLOSED)];
    data.hfLastSync = new Date().toISOString();
    data.hfSource = 'api';
    data.lastUpdated = new Date().toISOString();
    delete data.hfLastError;
    recordSnapshot(data, prev);
    await writeData(data);

    console.log(`[happyfox] Saved ${tickets.length} tickets (${gone.length} closed kept for history).`);
    return tickets.length;
  } catch (err) {
    console.error('[happyfox] Error:', err.message);
    await noteSyncError('hfLastError', err);
    throw err;
  } finally {
    hfSyncRunning = false;
  }
}

app.post('/api/sync-hf', async (req, res) => {
  try {
    res.json({ success: true, count: await runHfSync() });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// Save updated dedup stats (called after client-side dedup runs)
app.post('/api/update-dedup', async (req, res) => {
  try {
    const data = await readData();
    data.dedupStats = req.body;
    await writeData(data);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Microsoft Teams via Graph API ─────────────────────────────────────────────

async function httpPost(hostname, path, body) {
  return new Promise((resolve, reject) => {
    const payload = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const req = https.request({
      hostname, path, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(payload) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function httpGet(hostname, path, token) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname, path, method: 'GET',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(JSON.parse(data)));
    });
    req.on('error', reject);
    req.end();
  });
}

function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

const teamsConfigured = () =>
  !!(process.env.AZURE_TENANT_ID && process.env.AZURE_CLIENT_ID && process.env.AZURE_CLIENT_SECRET && process.env.TEAMS_CHAT_ID);

async function runTeamsSync() {
  const tenantId     = process.env.AZURE_TENANT_ID;
  const clientId     = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const chatId       = process.env.TEAMS_CHAT_ID;

  if (!teamsConfigured()) {
    const err = new Error('Teams not configured — add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, TEAMS_CHAT_ID to .env');
    err.status = 400;
    throw err;
  }

  try {
    console.log('[teams] Fetching OAuth token…');
    const tokenRes = await httpPost(
      'login.microsoftonline.com',
      `/${tenantId}/oauth2/v2.0/token`,
      { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }
    );
    if (!tokenRes.access_token) throw new Error(tokenRes.error_description || 'Token fetch failed');

    console.log('[teams] Fetching chat messages…');
    const msgRes = await httpGet(
      'graph.microsoft.com',
      `/v1.0/chats/${chatId}/messages?$top=50`,
      tokenRes.access_token
    );
    if (!msgRes.value) throw new Error(msgRes.error?.message || 'Message fetch failed');

    const messages = msgRes.value
      .filter(m => m.body?.content && m.messageType === 'message')
      .map(m => ({
        text:   stripHtml(m.body.content),
        sender: m.from?.user?.displayName || 'Unknown',
        date:   m.createdDateTime,
      }))
      .filter(m => m.text.length > 5);

    const data = await readData();
    data.teams = messages;
    data.teamsLastSync = new Date().toISOString();
    delete data.teamsLastError;
    await writeData(data);

    console.log(`[teams] Saved ${messages.length} messages.`);
    return messages;
  } catch (err) {
    console.error('[teams] Error:', err.message);
    await noteSyncError('teamsLastError', err);
    throw err;
  }
}

app.post('/api/sync-teams', async (req, res) => {
  try {
    const messages = await runTeamsSync();
    res.json({ success: true, count: messages.length, messages });
  } catch (err) {
    res.status(err.status || 500).json({ success: false, error: err.message });
  }
});

// ── Automatic sync ────────────────────────────────────────────────────────────
// AUTO_SYNC_HOURS=6 re-syncs ConnectWise, HappyFox and Teams every 6 hours while the server runs.
// Hosts that sleep when idle (e.g. Render's free tier) pause timers too — there, point a
// scheduled job at POST /api/sync-all instead, which also wakes the server up.

const AUTO_SYNC_HOURS = Math.max(0, parseFloat(process.env.AUTO_SYNC_HOURS) || 0);
let nextAutoSync = null;

async function syncEverything(reason) {
  console.log(`[auto-sync] Starting (${reason})…`);
  if (process.env.CW_USERNAME && process.env.CW_PASSWORD) {
    await runCwSync().catch(() => {});      // errors are logged and stored by runCwSync
  }
  if (hfApiConfigured()) {
    await runHfSync().catch(() => {});
  }
  if (teamsConfigured()) {
    await runTeamsSync().catch(() => {});
  }
  console.log('[auto-sync] Finished.');
}

function scheduleAutoSync() {
  if (!AUTO_SYNC_HOURS) return;
  const delay = Math.max(0.25, AUTO_SYNC_HOURS) * 60 * 60 * 1000;
  nextAutoSync = new Date(Date.now() + delay);
  setTimeout(async () => {
    await syncEverything('schedule');
    scheduleAutoSync();
  }, delay).unref();
}

// Kick off a background sync and return straight away (safe for cron services with short timeouts).
// Callers need a signed-in session, or the CRON_SECRET in an x-cron-secret header.
app.post('/api/sync-all', (req, res) => {
  if (cwSyncRunning || hfSyncRunning) return res.status(409).json({ success: false, error: 'A sync is already running.' });
  syncEverything('sync-all request');
  res.status(202).json({ success: true, message: 'Sync started in the background.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🖥️  CDS IT Dashboard running at http://localhost:${PORT}`);
  if (!PASSWORD) console.warn('   ⚠️  DASHBOARD_PASSWORD is not set — the dashboard is locked until it is.');
  console.log(`   Storage:  Supabase (${process.env.SUPABASE_URL})`);
  console.log(`   Auto-sync: ${AUTO_SYNC_HOURS ? `every ${AUTO_SYNC_HOURS} h` : 'off (set AUTO_SYNC_HOURS to enable)'}\n`);
  scheduleAutoSync();
});
