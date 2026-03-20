#!/bin/bash
# Auto-push IT Dashboard updates to GitHub Pages
# Run via cron: */15 * * * * /Users/rjames/CDS-IT-Ticket-Board/push-update.sh

REPO="/Users/rjames/CDS-IT-Ticket-Board"
cd "$REPO" || exit 1

# Only commit and push if index.html has actually changed
if ! git diff --quiet index.html 2>/dev/null || git ls-files --others --exclude-standard | grep -q "index.html"; then
  git add index.html
  git -c user.name="Ryan James" -c user.email="rjames@carolinaday.org" \
    commit -m "Dashboard refresh $(date '+%Y-%m-%d %H:%M')"
  git push origin main
fi
