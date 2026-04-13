/**
 * CDS IT Dashboard — Node.js Server
 * ──────────────────────────────────
 * Usage:
 *   npm install
 *   node server.js
 *   Open http://localhost:3000
 *
 * Endpoints:
 *   GET  /           → serves index.html
 *   GET  /api/data   → returns current data.json
 *   POST /api/sync-cw       → triggers Playwright scraper, updates data.json
 *   POST /api/upload-hf     → accepts HappyFox CSV file, parses, updates data.json
 *   POST /api/update-dedup  → accepts updated dedup stats from the client
 */

require('dotenv').config();
const express  = require('express');
const multer   = require('multer');
const { parse } = require('csv-parse/sync');
const fs       = require('fs');
const path     = require('path');
const https    = require('https');

const app       = express();
const upload    = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
const DATA_FILE = path.join(__dirname, 'data.json');
const PORT      = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(__dirname));

// ── Helpers ──────────────────────────────────────────────────────────────────

function readData() {
  if (fs.existsSync(DATA_FILE)) {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  }
  return { cw: [], hf: [], linked: [], dedupStats: null, lastUpdated: null };
}

function writeData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Return current ticket data
app.get('/api/data', (req, res) => {
  res.json(readData());
});

// Trigger ConnectWise Playwright scrape
app.post('/api/sync-cw', async (req, res) => {
  try {
    const { scrapeConnectWise } = require('./scraper');
    console.log('[server] Starting ConnectWise scrape…');
    const tickets = await scrapeConnectWise();

    const data = readData();
    data.cw = tickets;
    data.lastUpdated = new Date().toISOString();
    writeData(data);

    console.log(`[server] CW sync complete — ${tickets.length} tickets saved.`);
    res.json({ success: true, count: tickets.length });
  } catch (err) {
    console.error('[server] CW sync error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Accept HappyFox CSV export
app.post('/api/upload-hf', upload.single('csv'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: false, error: 'No file uploaded.' });
  }

  try {
    const records = parse(req.file.buffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true,
    });

    // HappyFox CSV column names vary — try common field names
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

    const data = readData();
    data.hf = tickets;
    data.lastUpdated = new Date().toISOString();
    writeData(data);

    console.log(`[server] HF upload complete — ${tickets.length} tickets saved.`);
    res.json({ success: true, count: tickets.length });
  } catch (err) {
    console.error('[server] HF parse error:', err.message);
    res.status(500).json({ success: false, error: `CSV parse error: ${err.message}` });
  }
});

// Save updated dedup stats (called after client-side dedup runs)
app.post('/api/update-dedup', (req, res) => {
  try {
    const data = readData();
    data.dedupStats = req.body;
    writeData(data);
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

app.post('/api/sync-teams', async (req, res) => {
  const tenantId    = process.env.AZURE_TENANT_ID;
  const clientId    = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const chatId      = process.env.TEAMS_CHAT_ID;

  if (!tenantId || !clientId || !clientSecret || !chatId) {
    return res.status(400).json({ success: false, error: 'Teams not configured — add AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, TEAMS_CHAT_ID to .env' });
  }

  try {
    // Get OAuth token
    console.log('[teams] Fetching OAuth token…');
    const tokenRes = await httpPost(
      'login.microsoftonline.com',
      `/${tenantId}/oauth2/v2.0/token`,
      { grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret, scope: 'https://graph.microsoft.com/.default' }
    );
    if (!tokenRes.access_token) throw new Error(tokenRes.error_description || 'Token fetch failed');

    // Fetch recent chat messages (top 50)
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

    // Persist
    const data = readData();
    data.teams = messages;
    data.lastUpdated = new Date().toISOString();
    writeData(data);

    console.log(`[teams] Saved ${messages.length} messages.`);
    res.json({ success: true, count: messages.length, messages });
  } catch (err) {
    console.error('[teams] Error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🖥️  CDS IT Dashboard running at http://localhost:${PORT}`);
  console.log(`   Password: ${process.env.DASHBOARD_PASSWORD || 'see index.html'}`);
  console.log(`   Data file: ${DATA_FILE}\n`);
});
