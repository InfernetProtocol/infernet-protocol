#!/usr/bin/env node
/**
 * Infernet Protocol daily stats email: manual trigger.
 *
 * The report is built and sent inside the app by POST /api/cron/daily-stats
 * (apps/web/lib/daily-stats.js), so it reads the production database with
 * the app's own keys. This script only calls that route. It used to query
 * Supabase itself from the droplet crontab, out of a checkout that was never
 * there, so it never sent a single report.
 *
 * Usage:
 *   CRON_SECRET=... node tooling/daily-stats-email.mjs            # send
 *   CRON_SECRET=... node tooling/daily-stats-email.mjs --dry-run  # counts only
 *
 * Env:
 *   CRON_SECRET          the app's cron secret (from the vault)
 *   INFERNET_APP_URL     optional, default https://infernetprotocol.com
 */

const base = (process.env.INFERNET_APP_URL || "https://infernetprotocol.com").replace(/\/+$/, "");
const secret = process.env.CRON_SECRET;
if (!secret) {
    console.error("CRON_SECRET is not set");
    process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const url = `${base}/api/cron/daily-stats${dryRun ? "?dry_run=1" : ""}`;

const res = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret}` } });
const body = await res.text();
console.log(body);
if (!res.ok) {
    console.error(`daily stats: HTTP ${res.status}`);
    process.exit(1);
}
