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
 *   POST /api/sync-all      → starts a background ConnectWise + Teams sync (for cron jobs)
 *
 * Automation:
 *   Set AUTO_SYNC_HOURS to re-sync ConnectWise and Teams on a schedule.
 *   Every sync records a daily snapshot in data.history for the trend chart.
 */

require('dotenv').config();
const express   = require('express');
const multer    = require('multer');
const { parse } = require('csv-parse/sync');
const path      = require('path');
const https     = require('https');
const { createClient } = require('@supabase/supabase-js');

const app    = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const PORT   = process.env.PORT || 3000;

// ── Supabase client ───────────────────────────────────────────────────────────

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

app.use(express.json());

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
const openHf = list => (list || []).filter(t => !HF_CLOSED_STATUSES.has((t.status || '').toLowerCase()));

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
// AUTO_SYNC_HOURS=6 re-syncs ConnectWise and Teams every 6 hours while the server runs.
// Hosts that sleep when idle (e.g. Render's free tier) pause timers too — there, point a
// scheduled job at POST /api/sync-all instead, which also wakes the server up.

const AUTO_SYNC_HOURS = Math.max(0, parseFloat(process.env.AUTO_SYNC_HOURS) || 0);
let nextAutoSync = null;

async function syncEverything(reason) {
  console.log(`[auto-sync] Starting (${reason})…`);
  if (process.env.CW_USERNAME && process.env.CW_PASSWORD) {
    await runCwSync().catch(() => {});      // errors are logged and stored by runCwSync
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
// If CRON_SECRET is set, the caller must send it as the x-cron-secret header or ?key= parameter.
app.post('/api/sync-all', (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (secret && req.get('x-cron-secret') !== secret && req.query.key !== secret) {
    return res.status(401).json({ success: false, error: 'Invalid or missing cron secret.' });
  }
  if (cwSyncRunning) return res.status(409).json({ success: false, error: 'A sync is already running.' });
  syncEverything('sync-all request');
  res.status(202).json({ success: true, message: 'Sync started in the background.' });
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🖥️  CDS IT Dashboard running at http://localhost:${PORT}`);
  console.log(`   Storage:  Supabase (${process.env.SUPABASE_URL})`);
  console.log(`   Auto-sync: ${AUTO_SYNC_HOURS ? `every ${AUTO_SYNC_HOURS} h` : 'off (set AUTO_SYNC_HOURS to enable)'}\n`);
  scheduleAutoSync();
});
