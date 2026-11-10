# CDS IT Ticket Dashboard

One view of Carolina Day School's open IT tickets across **ConnectWise** and **HappyFox**,
with Microsoft Teams chatter used to spot recurring problems.

## Running it

```bash
npm install
cp .env.example .env    # then fill in the values
npm start               # http://localhost:3000
```

`DASHBOARD_PASSWORD` must be set — the dashboard stays locked without it.

Ticket data is stored in Supabase (one JSON row in the `dashboard_data` table, `id = 1`).

## What the dashboard does

| Area | What you get |
|------|--------------|
| **Daily briefing** | A plain-English summary written from the live data: how many issues are open, what is past SLA, which ticket to start with, the busiest category. |
| **Summary cards** | Unique issues, Critical/P2, Past SLA target, CW unassigned, HF-only. Each card opens the matching ticket list and shows the change since the previous sync day. |
| **Needs attention** | Past-SLA tickets, priority mismatches between the two systems, unassigned tickets, tickets stalled on a vendor or requester, tickets open 30+ days, and repeat issues. |
| **Deduplication** | HappyFox and ConnectWise copies of the same issue are matched by title on every load, and counted once. Repeat entries inside one system are grouped. |
| **Systemic intelligence** | Tickets sorted into categories, long-running issues, and frequent requestors. |
| **Charts** | Status, type and priority mix, workload per assignee (with past-SLA share), backlog by age, and backlog trend over time. |
| **Tickets page** | Every open issue, most urgent first. Filter by source, flag, category and assignee; search; sort by any column; export the current view to CSV. |

### How the analysis works

- **Response SLA** — a ConnectWise ticket must get a first response within 4 business hours
  (P1/P2), 8 (P3) or 16 (P4). A ticket counts as *awaiting response* while its status is
  "New" or "Reassign Dispatcher", or while nobody is assigned. Business hours are 8 AM–4 PM,
  Monday–Friday; school holidays are not skipped. ConnectWise gives only an entered *date*,
  so the clock starts the next working morning. All of this is set by `SLA_HOURS`,
  `BUSINESS_DAY` and `AWAITING_RESPONSE_STATUS` near the top of the script in `index.html`.
- **HappyFox reply status** — when synced through the API, tickets with no staff reply or a
  HappyFox-reported SLA breach are flagged.
- **Cross-system matching** — two titles match when they are identical after clean-up, or
  share at least two words with 50%+ word overlap. If both tickets have a created date they
  must be within 21 days of each other. Fuzzy matches are listed under *Duplicate Group
  Analysis* so they can be checked.
- **Categories** — each ticket goes into the first category whose keywords match its title.
  Edit `ISSUE_CATEGORIES` in `index.html` to tune them.
- **Trend** — the server saves one snapshot per day that data is synced (open counts,
  critical, unassigned, opened and closed since the previous sync).

## Keeping data fresh

| Source | How |
|--------|-----|
| ConnectWise | Button on *Sync & Import*, or automatically with `AUTO_SYNC_HOURS`. |
| Teams | Button, or automatically alongside ConnectWise. |
| HappyFox | Through the HappyFox API (optionally narrowed with `HF_CATEGORIES` and `HF_IGNORE_STATUSES`; the Sync page breaks the open count down by category and status) once `HF_ACCOUNT`, `HF_API_KEY` and `HF_AUTH_CODE` are set (create the key under Apps → Goodies → API; then button, or automatically). A CSV export (Reports → Ticket Export) still works as a fallback. |

`POST /api/sync-all` starts a sync of every configured source in the background and returns
at once, so an outside scheduler can trigger it. The scheduler sends `CRON_SECRET` in an
`x-cron-secret` header.

## Security

- The password is checked on the server (`POST /api/login`) and never appears in the page.
  A correct login sets an HttpOnly, signed session cookie that lasts 30 days.
- Every `/api` route needs that session, so ticket data cannot be read, and syncs cannot be
  started, without signing in. Eight wrong passwords from one address locks it out for 15 minutes.
- No ticket data is built into the page itself.

An open dashboard re-reads the data every 5 minutes, and the header warns when a ticket
source has not been synced for 3 days.

## Files

- `index.html` — the whole front end (markup, styles, analysis and charts)
- `server.js` — Express server: API, sync scheduling, history snapshots
- `scraper.js` — Playwright scraper for the ConnectWise customer portal
