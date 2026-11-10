# CDS IT Ticket Dashboard

One view of Carolina Day School's open IT tickets across **ConnectWise** and **HappyFox**,
with Microsoft Teams chatter used to spot recurring problems.

## Running it

```bash
npm install
cp .env.example .env    # then fill in the values
npm start               # http://localhost:3000
```

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

- **SLA** — ConnectWise targets are P1/P2 = 1 business day, P3 = 2, P4 = 4, counted from the
  date entered. The clock is paused for tickets in a "Waiting…" status. Weekends are skipped;
  school holidays are not.
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
| HappyFox | Upload a CSV export (Reports → Ticket Export). |

`POST /api/sync-all` starts a ConnectWise + Teams sync in the background and returns at once,
so an outside scheduler can trigger it. Set `CRON_SECRET` to restrict who can call it.

An open dashboard re-reads the data every 5 minutes, and the header warns when a ticket
source has not been synced for 3 days.

## Files

- `index.html` — the whole front end (markup, styles, analysis and charts)
- `server.js` — Express server: API, sync scheduling, history snapshots
- `scraper.js` — Playwright scraper for the ConnectWise customer portal
