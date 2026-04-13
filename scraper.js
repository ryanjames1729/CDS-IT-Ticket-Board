/**
 * ConnectWise Playwright Scraper
 * ─────────────────────────────
 * Logs into ConnectWise, navigates to open service tickets, and returns
 * structured ticket data. Called by server.js when "Sync ConnectWise" is triggered.
 *
 * Setup:
 *   1. Copy .env.example to .env and fill in CW_URL, CW_USERNAME, CW_PASSWORD
 *   2. Run `npm install` to install playwright
 *   3. Run `npx playwright install chromium` to download the browser
 *   4. Test standalone: `node scraper.js`
 */

require('dotenv').config();

// Tell Playwright where to find browsers (local ./browsers dir for Render compatibility)
const path = require('path');
process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, 'browsers');
const { chromium } = require('playwright');

const CW_LOGIN_URL = 'https://cw.electronicoffice.net/v4_6_release/services/system_io/customerportal/portal.html?company=electronicoffice&locale=en#LoginPagePlace:LOGOUT';
const CW_USERNAME  = process.env.CW_USERNAME || '';
const CW_PASSWORD  = process.env.CW_PASSWORD || '';

// Map "Priority 4 (within 4 days)" → "P4" etc.
function normalizePriority(raw) {
  const m = raw.match(/priority\s*(\d)/i);
  if (m) return 'P' + m[1];
  return 'No SLA';
}

// Scrape all detail rows visible on the current page
async function scrapePageRows(page) {
  return page.evaluate(() => {
    return Array.from(document.querySelectorAll('tr')).filter(row => {
      const cells = row.querySelectorAll('td');
      if (cells.length < 15) return false;
      // Detail rows have a 7-digit ticket number in cell index 2
      return /^\d{6,8}$/.test((cells[2]?.textContent || '').trim());
    }).map(row => {
      const c = Array.from(row.querySelectorAll('td')).map(td => td.textContent.trim());
      return {
        summary:   c[1]  || '',
        num:       c[2]  || '',
        type:      c[3]  || 'Incident',
        status:    c[5]  || 'New',
        priorityRaw: c[6] || '',
        entered:   c[7]  || '',
        contact:   c[10] || '',
        resources: c[11] || 'Unassigned',
      };
    });
  });
}

// Read "X-Y of Z" pagination info from the current page
async function getPaginationInfo(page) {
  return page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('tr'));
    for (const row of rows) {
      const m = row.textContent.match(/(\d+)-(\d+)\s+of\s+(\d+)/);
      if (m) return { start: parseInt(m[1]), end: parseInt(m[2]), total: parseInt(m[3]) };
    }
    return null;
  });
}

// Click the next-page arrow using Playwright's native click (required for GWT events).
// Returns true if a next-page td was found and clicked.
async function clickNextPage(page) {
  // Find all tds in whatever row contains the "X-Y of Z" pagination text
  const allTds = await page.$$('tr td');
  let countIdx = -1;
  const tdTexts = [];
  for (const td of allTds) {
    const txt = (await td.textContent()).trim();
    tdTexts.push(txt);
    if (/^\d+-\d+\s+of\s+\d+$/.test(txt)) countIdx = tdTexts.length - 1;
  }
  if (countIdx === -1 || countIdx + 1 >= allTds.length) return false;
  // The td immediately after the "X-Y of Z" cell is the "next page" arrow
  await allTds[countIdx + 1].click();
  return true;
}

// Page through all results for the current filter and return raw rows
async function scrapeAllPages(page, label) {
  const results = [];
  let pageNum = 1, lastFirstTicket = null;
  const isClosed = label === 'closed';

  while (true) {
    const rows = await scrapePageRows(page);
    const pag  = await getPaginationInfo(page);
    console.log(`[scraper]   ${label} page ${pageNum}: ${rows.length}${pag ? ` (${pag.start}-${pag.end} of ${pag.total})` : ''}`);

    if (rows.length === 0) break;
    const firstTicket = rows[0]?.num;
    if (firstTicket && firstTicket === lastFirstTicket) { console.log('[scraper] No page change — stopping.'); break; }
    lastFirstTicket = firstTicket;

    results.push(...rows.map(r => ({ ...r, closed: isClosed })));

    if (pag && pag.end >= pag.total) break;
    const clicked = await clickNextPage(page);
    if (!clicked) break;
    pageNum++;
    await page.waitForTimeout(3000);
    if (pageNum > 100) break;
  }
  return results;
}

async function scrapeConnectWise() {
  if (!CW_USERNAME || !CW_PASSWORD) {
    throw new Error('CW_USERNAME and CW_PASSWORD must be set in .env');
  }

  const browser = await chromium.launch({ headless: true });
  const page    = await browser.newPage();

  try {
    // ── LOGIN ──────────────────────────────────────────────────────────────
    console.log('[scraper] Navigating to ConnectWise customer portal…');
    await page.goto(CW_LOGIN_URL, { waitUntil: 'networkidle' });
    await page.waitForTimeout(3000);

    await page.fill('input#emailBox', CW_USERNAME);
    await page.fill('input.gwt-PasswordTextBox', CW_PASSWORD);
    await page.click('button.cw-login-button');
    await page.waitForTimeout(6000);

    // ── NAVIGATE TO TICKET LIST ────────────────────────────────────────────
    console.log('[scraper] Clicking Tickets nav…');
    await page.evaluate(() => {
      const item = document.querySelector('#menuTickets, td#menuTickets');
      if (item) item.click();
    });
    await page.waitForTimeout(6000);

    // ── SCRAPE OPEN THEN CLOSED TICKETS ────────────────────────────────────
    const allRaw = [];

    // Pass 1: open tickets (default view)
    console.log('[scraper] Pass 1: open tickets…');
    allRaw.push(...await scrapeAllPages(page, 'open'));

    // Pass 2: switch to Closed filter and scrape those too
    console.log('[scraper] Switching to Closed filter…');
    const switchedToClosed = await page.evaluate(() => {
      // The portal status filter renders as GWT elements containing "Closed" text.
      // Try radio buttons, checkboxes, and clickable spans/tds near "Closed" label.
      const all = Array.from(document.querySelectorAll(
        'label, span.gwt-RadioButton, span.gwt-CheckBox, td.gwt-RadioButton, input[type="radio"], input[type="checkbox"]'
      ));
      const closedEl = all.find(el => el.textContent.trim() === 'Closed' ||
        (el.type && el.closest && el.closest('label,span,td')?.textContent.trim() === 'Closed')
      );
      if (closedEl) { closedEl.click(); return true; }
      // Fallback: find any element whose exact text is "Closed" and click it
      const any = Array.from(document.querySelectorAll('*')).find(
        el => el.children.length === 0 && el.textContent.trim() === 'Closed'
      );
      if (any) { any.click(); return 'fallback'; }
      return false;
    });
    console.log('[scraper] Closed filter clicked:', switchedToClosed);

    if (switchedToClosed) {
      await page.waitForTimeout(4000);
      console.log('[scraper] Pass 2: closed tickets…');
      allRaw.push(...await scrapeAllPages(page, 'closed'));
    } else {
      console.log('[scraper] Could not find Closed filter — only open tickets scraped.');
    }

    // ── NORMALIZE + DEDUPLICATE ───────────────────────────────────────────
    const seen    = new Set();
    const tickets = allRaw.map(t => ({
      num:       t.num,
      summary:   t.summary,
      type:      t.type,
      priority:  normalizePriority(t.priorityRaw),
      status:    t.status,
      resources: t.resources,
      contact:   t.contact,
      entered:   t.entered,
      closed:    t.closed || false,
    })).filter(t => {
      if (!t.num || !t.summary || seen.has(t.num)) return false;
      seen.add(t.num);
      return true;
    });

    const openCount   = tickets.filter(t => !t.closed).length;
    const closedCount = tickets.filter(t =>  t.closed).length;
    console.log(`[scraper] Total: ${tickets.length} tickets (${openCount} open, ${closedCount} closed).`);
    await browser.close();
    return tickets;

  } catch (err) {
    await browser.close();
    throw err;
  }
}

// ── Standalone test ──────────────────────────────────────────────────────────
if (require.main === module) {
  scrapeConnectWise()
    .then(tickets => {
      console.log(`\nScraped ${tickets.length} tickets:\n`);
      console.log(JSON.stringify(tickets.slice(0, 3), null, 2));
    })
    .catch(err => {
      console.error('[scraper] Error:', err.message);
      process.exit(1);
    });
}

module.exports = { scrapeConnectWise };
