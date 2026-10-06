import "server-only";

/**
 * Infernet Protocol daily stats report: counts + the email built from them.
 *
 * Used by POST /api/cron/daily-stats, which runs inside the app on dev2 so it
 * reads the same database, with the same keys, as the site itself.
 *
 * This replaces tooling/daily-stats-email.mjs run from the DigitalOcean
 * droplet. That crontab line pointed at /home/ubuntu/src/infernet-protocol,
 * a checkout that never existed there, so the report never ran once. Even if
 * it had, it counted `users` and `nodes`, tables the app never writes (both
 * empty), and every failed query was logged and turned into a 0.
 *
 * Here every query failure THROWS, and so does an empty core count. A report
 * with a hole in it is worse than no report: nothing gets sent unless every
 * number was actually read.
 *
 * Where the numbers come from:
 *   users  auth.users (Supabase Auth admin API); there is no profile table
 *   nodes  providers (every node that registers lands here)
 *   jobs   jobs
 */

export class DailyStatsQueryError extends Error {
    constructor(what, message) {
        super(`daily stats: ${what} failed: ${message}`);
        this.name = "DailyStatsQueryError";
    }
}

export const DAILY_STATS_TO = "anthony@profullstack.com";
export const DAILY_STATS_FROM = "Infernet Stats <stats@infernetprotocol.com>";

const HOUR = 3600_000;

function errMessage(error) {
    if (error && typeof error === "object" && "message" in error) return String(error.message);
    return String(error);
}

async function count(supabase, table, { eq, gte } = {}) {
    const what = `count(${table}${eq ? ` ${JSON.stringify(eq)}` : ""}${gte ? ` since ${gte[0]}` : ""})`;
    let q = supabase.from(table).select("*", { count: "exact", head: true });
    if (eq) for (const [col, val] of Object.entries(eq)) q = q.eq(col, val);
    if (gte) q = q.gte(gte[0], gte[1]);
    const { count: c, error } = await q;
    if (error) throw new DailyStatsQueryError(what, errMessage(error));
    if (typeof c !== "number") throw new DailyStatsQueryError(what, "no count returned");
    return c;
}

/**
 * The `models` table is a hand-curated catalog nothing writes, so it reads 0
 * however many models the network serves. What providers actually serve is
 * specs.served_models, refreshed by every heartbeat.
 */
async function servedModels(supabase, sinceIso) {
    const { data, error } = await supabase
        .from("providers")
        .select("specs")
        .gte("last_seen", sinceIso);
    if (error) throw new DailyStatsQueryError("servedModels(providers)", errMessage(error));
    const names = new Set();
    for (const row of data ?? []) {
        const served = row?.specs?.served_models;
        if (Array.isArray(served)) for (const m of served) if (typeof m === "string" && m) names.add(m);
    }
    return [...names].sort();
}

async function recent(supabase, table, columns, limit) {
    const { data, error } = await supabase
        .from(table)
        .select(columns)
        .order("created_at", { ascending: false })
        .limit(limit);
    if (error) throw new DailyStatsQueryError(`recent(${table})`, errMessage(error));
    return data ?? [];
}

/**
 * Signed-up accounts live in auth.users, which PostgREST does not expose.
 * The admin API pages through them; the user base is small enough that
 * reading every created_at is cheaper than a second code path.
 */
async function authUserStats(supabase, now) {
    const perPage = 1000;
    const created = [];
    for (let page = 1; page <= 100; page++) {
        const { data, error } = await supabase.auth.admin.listUsers({ page, perPage });
        if (error) throw new DailyStatsQueryError("auth.admin.listUsers", errMessage(error));
        const users = data?.users;
        if (!Array.isArray(users)) throw new DailyStatsQueryError("auth.admin.listUsers", "no users array returned");
        for (const u of users) created.push(Date.parse(u.created_at));
        if (users.length < perPage) break;
    }
    const since = (hours) => created.filter((t) => t >= now.getTime() - hours * HOUR).length;
    return { total: created.length, new24h: since(24), new7d: since(24 * 7), new30d: since(24 * 30) };
}

export async function collectDailyStats(supabase, now = new Date()) {
    const ago = (hours) => new Date(now.getTime() - hours * HOUR).toISOString();
    const d1 = ago(24);
    const d7 = ago(24 * 7);

    const [
        users,
        nodesTotal, nodesAvailable, nodesLive, nodesOffline, nodesSeen24h, nodesNew24h, nodesNew7d, recentNodes,
        modelsTotal, modelsPublic, modelsNew7d, served24h,
        jobsTotal, jobsPending, jobsAssigned, jobsRunning, jobsCompleted, jobsFailed, jobs24h, jobs7d, recentJobs,
        distTotal, dist24h,
        trainingTotal, training24h, shardsTotal, shardsCompleted,
        cprPending, cprSent, cprFailed, cprPermFail,
        cmdPending, cmdRunning, cmdCompleted, cmdFailed, cmd24h,
        pubkeyLinks, pubkeyLinks24h, cliSessions, cliSessions24h,
        payTotal, pay24h,
        legacyNodes, legacyAggregators, legacyClients
    ] = await Promise.all([
        authUserStats(supabase, now),
        count(supabase, "providers"),
        count(supabase, "providers", { eq: { status: "available" } }),
        count(supabase, "providers", { gte: ["last_seen", ago(1 / 6)] }),
        count(supabase, "providers", { eq: { status: "offline" } }),
        count(supabase, "providers", { gte: ["last_seen", d1] }),
        count(supabase, "providers", { gte: ["created_at", d1] }),
        count(supabase, "providers", { gte: ["created_at", d7] }),
        recent(supabase, "providers", "name, status, gpu_model, created_at", 5),
        count(supabase, "models"),
        count(supabase, "models", { eq: { visibility: "public" } }),
        count(supabase, "models", { gte: ["created_at", d7] }),
        servedModels(supabase, d1),
        count(supabase, "jobs"),
        count(supabase, "jobs", { eq: { status: "pending" } }),
        count(supabase, "jobs", { eq: { status: "assigned" } }),
        count(supabase, "jobs", { eq: { status: "running" } }),
        count(supabase, "jobs", { eq: { status: "completed" } }),
        count(supabase, "jobs", { eq: { status: "failed" } }),
        count(supabase, "jobs", { gte: ["created_at", d1] }),
        count(supabase, "jobs", { gte: ["created_at", d7] }),
        recent(supabase, "jobs", "title, status, model_name, created_at", 5),
        count(supabase, "distributed_jobs"),
        count(supabase, "distributed_jobs", { gte: ["created_at", d1] }),
        count(supabase, "training_jobs"),
        count(supabase, "training_jobs", { gte: ["created_at", d1] }),
        count(supabase, "training_shards"),
        count(supabase, "training_shards", { eq: { status: "completed" } }),
        count(supabase, "cpr_receipts_queue", { eq: { status: "pending" } }),
        count(supabase, "cpr_receipts_queue", { eq: { status: "sent" } }),
        count(supabase, "cpr_receipts_queue", { eq: { status: "failed" } }),
        count(supabase, "cpr_receipts_queue", { eq: { status: "permanent_fail" } }),
        count(supabase, "node_commands", { eq: { status: "pending" } }),
        count(supabase, "node_commands", { eq: { status: "running" } }),
        count(supabase, "node_commands", { eq: { status: "completed" } }),
        count(supabase, "node_commands", { eq: { status: "failed" } }),
        count(supabase, "node_commands", { gte: ["issued_at", d1] }),
        count(supabase, "pubkey_links"),
        count(supabase, "pubkey_links", { gte: ["created_at", d1] }),
        count(supabase, "cli_sessions"),
        count(supabase, "cli_sessions", { gte: ["created_at", d1] }),
        count(supabase, "payment_transactions"),
        count(supabase, "payment_transactions", { gte: ["created_at", d1] }),
        count(supabase, "nodes"),
        count(supabase, "aggregators"),
        count(supabase, "clients")
    ]);

    const stats = {
        date: now.toISOString().split("T")[0],
        users,
        nodes: {
            total: nodesTotal,
            available: nodesAvailable,
            live: nodesLive,
            offline: nodesOffline,
            seen24h: nodesSeen24h,
            new24h: nodesNew24h,
            new7d: nodesNew7d
        },
        recentNodes,
        models: { total: modelsTotal, public: modelsPublic, new7d: modelsNew7d, served24h },
        jobs: {
            total: jobsTotal,
            pending: jobsPending,
            assigned: jobsAssigned,
            running: jobsRunning,
            completed: jobsCompleted,
            failed: jobsFailed,
            new24h: jobs24h,
            new7d: jobs7d
        },
        recentJobs,
        distributed: { total: distTotal, new24h: dist24h },
        training: { jobs: trainingTotal, new24h: training24h, shards: shardsTotal, shardsCompleted },
        cpr: { pending: cprPending, sent: cprSent, failed: cprFailed, permanentFail: cprPermFail },
        commands: { pending: cmdPending, running: cmdRunning, completed: cmdCompleted, failed: cmdFailed, new24h: cmd24h },
        auth: { pubkeyLinks, pubkeyLinks24h, cliSessions, cliSessions24h },
        payments: { total: payTotal, new24h: pay24h },
        legacy: { nodes: legacyNodes, aggregators: legacyAggregators, clients: legacyClients }
    };

    // Infernet has had accounts, registered nodes and jobs since launch. A
    // zero in any of them means the report is reading the wrong database (an
    // empty one, or one whose rows RLS hides), not a quiet day.
    for (const [what, n] of [
        ["auth users", stats.users.total],
        ["count(providers)", stats.nodes.total],
        ["count(jobs)", stats.jobs.total]
    ]) {
        if (n === 0) {
            throw new DailyStatsQueryError(
                what,
                "returned 0; the report is not reading the production database (check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY)"
            );
        }
    }

    return stats;
}

export function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

const day = (ts) => (typeof ts === "string" ? ts.slice(0, 10) : "");

export function renderDailyStats(s) {
    const { users, nodes, models, jobs, distributed, training, cpr, commands, auth, payments, legacy } = s;

    const text = `
Infernet Protocol Daily Report - ${s.date}
${"=".repeat(50)}

USERS (auth accounts)
  Total: ${users.total}
  New (24h): ${users.new24h}
  New (7d): ${users.new7d}
  New (30d): ${users.new30d}

NODES (providers)
  Total: ${nodes.total}
  Available: ${nodes.available}
  Live (heartbeat in last 10 min): ${nodes.live}
  Offline: ${nodes.offline}
  Seen (24h): ${nodes.seen24h}
  New (24h): ${nodes.new24h}
  New (7d): ${nodes.new7d}

RECENT NODES
${s.recentNodes.map((n) => `  - ${n.name || "(unnamed)"} [${n.status}] ${n.gpu_model || ""} (${day(n.created_at)})`).join("\n") || "  (none)"}

MODELS
  Served by nodes seen in 24h: ${models.served24h.length}${models.served24h.length ? ` (${models.served24h.join(", ")})` : ""}
  Catalog (models table): ${models.total}
  Public: ${models.public}
  New (7d): ${models.new7d}

INFERENCE JOBS
  Total: ${jobs.total}
  Pending: ${jobs.pending}
  Assigned: ${jobs.assigned}
  Running: ${jobs.running}
  Completed: ${jobs.completed}
  Failed: ${jobs.failed}
  New (24h): ${jobs.new24h}
  New (7d): ${jobs.new7d}

RECENT JOBS
${s.recentJobs.map((j) => `  - ${j.title || "(untitled)"} [${j.status}] ${j.model_name || "?"} (${day(j.created_at)})`).join("\n") || "  (none)"}

DISTRIBUTED JOBS
  Total: ${distributed.total} (+${distributed.new24h} 24h)

TRAINING MARKET
  Training jobs: ${training.jobs} (+${training.new24h} 24h)
  Shards: ${training.shards} (${training.shardsCompleted} completed)

CPR RECEIPTS QUEUE
  Pending: ${cpr.pending}
  Sent: ${cpr.sent}
  Failed (retrying): ${cpr.failed}
  Permanent fail: ${cpr.permanentFail}

NODE COMMANDS
  Pending: ${commands.pending}
  Running: ${commands.running}
  Completed: ${commands.completed}
  Failed: ${commands.failed}
  New (24h): ${commands.new24h}

AUTH / SESSIONS
  Pubkey links: ${auth.pubkeyLinks} (+${auth.pubkeyLinks24h} 24h)
  CLI sessions: ${auth.cliSessions} (+${auth.cliSessions24h} 24h)

PAYMENT TRANSACTIONS
  Total: ${payments.total} (+${payments.new24h} 24h)

LEGACY TABLES
  nodes: ${legacy.nodes}, aggregators: ${legacy.aggregators}, clients: ${legacy.clients}
`.trim();

    const row = (label, value, style = "") =>
        `<tr><td style="padding: 4px 0;">${label}</td><td style="text-align: right;${style}">${value}</td></tr>`;
    const green = (n) => ` font-weight: bold; color: ${n > 0 ? "#16a34a" : "#666"};`;
    const warn = (n, color) => ` color: ${n > 0 ? color : "#666"};`;
    const plus = (total, delta) => `${total} <span style="color: #16a34a; font-weight: normal;">+${delta}</span>`;
    const h2 = (t) => `<h2 style="font-size: 16px; color: #0ea5e9; margin: 0 0 12px;">${t}</h2>`;
    const table = (rows, mb = 20) =>
        `<table style="width: 100%; font-size: 14px; margin-bottom: ${mb}px;">${rows.join("")}</table>`;
    const list = (items) =>
        items.length > 0
            ? `<ul style="font-size: 13px; padding-left: 20px; margin: 0 0 20px;">${items.join("")}</ul>`
            : `<div style="margin-bottom: 20px;"></div>`;

    const html = `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; color: #1a1a2e; background: #f8f9fa;">
  <div style="background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 100%); color: white; padding: 20px 24px; border-radius: 12px 12px 0 0;">
    <h1 style="margin: 0; font-size: 20px;">📊 Infernet Protocol Daily Report</h1>
    <p style="margin: 4px 0 0; opacity: 0.9; font-size: 14px;">${esc(s.date)}</p>
  </div>
  <div style="background: white; padding: 24px; border-radius: 0 0 12px 12px; border: 1px solid #e0e0e0; border-top: none;">
    ${h2("👤 Users")}
    ${table([
        row("Total", users.total, " font-weight: bold;"),
        row("New (24h)", users.new24h, green(users.new24h)),
        row("New (7d)", users.new7d),
        row("New (30d)", users.new30d)
    ])}
    ${h2("🖥️ Nodes")}
    ${table([
        row("Total", nodes.total, " font-weight: bold;"),
        row("Available", nodes.available, " color: #16a34a;"),
        row("Live (10 min)", nodes.live, " color: #16a34a;"),
        row("Offline", nodes.offline),
        row("Seen (24h)", nodes.seen24h),
        row("New (24h)", nodes.new24h, green(nodes.new24h)),
        row("New (7d)", nodes.new7d)
    ], 12)}
    ${list(s.recentNodes.map((n) => `<li style="margin-bottom: 4px;"><strong>${esc(n.name || "(unnamed)")}</strong> <span style="color: #999;">[${esc(n.status)}] ${esc(n.gpu_model)} · ${esc(day(n.created_at))}</span></li>`))}
    ${h2("🧩 Models")}
    ${table([
        row("Served by nodes seen (24h)", models.served24h.length, " font-weight: bold;"),
        row("Catalog (models table)", models.total),
        row("Public", models.public),
        row("New (7d)", models.new7d)
    ])}
    ${models.served24h.length ? `<p style="margin: 4px 0 12px; color: #666; font-size: 13px;">${esc(models.served24h.join(", "))}</p>` : ""}
    ${h2("⚙️ Inference Jobs")}
    ${table([
        row("Total", jobs.total, " font-weight: bold;"),
        row("Pending", jobs.pending),
        row("Assigned", jobs.assigned),
        row("Running", jobs.running, " color: #d97706;"),
        row("Completed", jobs.completed, " color: #16a34a;"),
        row("Failed", jobs.failed, warn(jobs.failed, "#dc2626")),
        row("New (24h)", jobs.new24h, green(jobs.new24h)),
        row("New (7d)", jobs.new7d)
    ], 12)}
    ${list(s.recentJobs.map((j) => `<li style="margin-bottom: 4px;"><strong>${esc(j.title || "(untitled)")}</strong> <span style="color: #999;">[${esc(j.status)}] ${esc(j.model_name || "?")} · ${esc(day(j.created_at))}</span></li>`))}
    ${h2("🪜 Distributed & Training")}
    ${table([
        row("Distributed jobs", plus(distributed.total, distributed.new24h), " font-weight: bold;"),
        row("Training jobs", plus(training.jobs, training.new24h), " font-weight: bold;"),
        row("Shards", training.shards),
        row("Completed shards", training.shardsCompleted, " color: #16a34a;")
    ])}
    ${h2("🧾 CPR Receipts Queue")}
    ${table([
        row("Pending", cpr.pending, warn(cpr.pending, "#d97706")),
        row("Sent", cpr.sent, " color: #16a34a;"),
        row("Failed (retrying)", cpr.failed, warn(cpr.failed, "#d97706")),
        row("Permanent fail", cpr.permanentFail, warn(cpr.permanentFail, "#dc2626"))
    ])}
    ${h2("📡 Node Commands")}
    ${table([
        row("Pending", commands.pending),
        row("Running", commands.running, " color: #d97706;"),
        row("Completed", commands.completed, " color: #16a34a;"),
        row("Failed", commands.failed, warn(commands.failed, "#dc2626")),
        row("New (24h)", commands.new24h, green(commands.new24h))
    ])}
    ${h2("🔑 Auth / Sessions")}
    ${table([
        row("Pubkey links", plus(auth.pubkeyLinks, auth.pubkeyLinks24h), " font-weight: bold;"),
        row("CLI sessions", plus(auth.cliSessions, auth.cliSessions24h))
    ])}
    ${h2("💰 Payment Transactions")}
    ${table([row("Total", plus(payments.total, payments.new24h), " font-weight: bold;")])}
    ${h2("📁 Legacy Tables")}
    ${table([
        row("nodes", legacy.nodes),
        row("aggregators", legacy.aggregators),
        row("clients", legacy.clients)
    ])}
  </div>
  <p style="text-align: center; font-size: 12px; color: #999; margin-top: 16px;">
    Sent by Infernet Stats · <a href="https://infernetprotocol.com" style="color: #0ea5e9;">infernetprotocol.com</a>
  </p>
</body>
</html>
`.trim();

    return {
        subject: `📊 Infernet Daily - ${s.date} | ${users.total} users, ${nodes.total} nodes, ${jobs.total} jobs`,
        html,
        text
    };
}

/** Send through Resend's HTTP API, the same way /api/contact does. */
export async function sendDailyStatsEmail(report, { apiKey, to, from, fetchImpl = fetch } = {}) {
    const key = apiKey ?? process.env.RESEND_API_KEY;
    if (!key) throw new Error("RESEND_API_KEY not configured");
    const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            from: from ?? process.env.STATS_FROM_EMAIL ?? DAILY_STATS_FROM,
            to: [to ?? DAILY_STATS_TO],
            subject: report.subject,
            html: report.html,
            text: report.text
        })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend ${res.status}: ${detail.slice(0, 500)}`);
    }
    const body = await res.json().catch(() => ({}));
    return body?.id ?? null;
}
