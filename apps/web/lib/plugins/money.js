// Money plugins on Infernet chat: the pure half (no server-only imports, so
// tests and the CLI can load it). The catalog entries, read-only allowlists
// and confirmation gate come from @profullstack/chat-plugins (FINANCE_CATALOG,
// applyPolicy), the same source c0mpute chat uses, so the two cannot drift.

import { CATALOG, DEFAULT_PLUGINS, FINANCE_CATALOG, applyPolicy, policyFor } from "@profullstack/chat-plugins";

/** The package catalog plus the money plugins (Mercury and CoinPay on for everyone; moomoo listed, off). */
export function moneyCatalog() {
    const money = FINANCE_CATALOG.map((e) => ({ slug: e.slug, name: e.name, url: e.url, description: e.description, homepage: e.homepage, icon: e.icon, default: e.default }));
    const taken = new Set(money.map((e) => e.slug));
    return [...money, ...CATALOG.filter((e) => !taken.has(e.slug))];
}

/**
 * The confirmation gate, applied to a plugin's tools before the loop sees
 * them: only allowlisted reads run alone; writes and unknown tools are marked
 * destructive (the loop then holds them for the person). Brokerage in paper
 * mode hides the live order tools.
 */
export function gatedTools(row, tools, mode) {
    return applyPolicy(policyFor(row.url), Array.isArray(tools) ? tools : [], mode === "live" ? "live" : "paper");
}

/** A discovered server with the money policy's narrower OAuth scopes. */
export function withPolicyScopes(server) {
    const scopes = policyFor(server.url)?.scopes;
    return scopes && server.auth && server.auth !== "none" ? { ...server, auth: { ...server.auth, scopes: [...scopes] } } : server;
}

const norm = (u) => String(u).replace(/\/+$/, "");

/**
 * Which default plugins to add for an account: those not yet marked "seeded",
 * minus servers the account already has, within the per-account limit.
 * Returns rows to insert and slugs to mark seeded (all of `todo`).
 */
export function defaultsToSeed(prefs, rows, max, defaults = DEFAULT_PLUGINS) {
    const todo = defaults.filter((d) => !prefs.has(`${d.slug}|seeded`));
    const urls = new Set(rows.map((r) => norm(r.url)));
    const slugs = new Set(rows.map((r) => r.slug));
    let count = rows.length;
    const insert = [];
    for (const d of todo) {
        if (urls.has(norm(d.url)) || slugs.has(d.slug) || count >= max) continue;
        insert.push({ slug: d.slug, name: d.name, url: d.url, auth: "oauth", enabled: true, tools: [] });
        count++;
    }
    return { insert, mark: todo.map((d) => d.slug) };
}

export { DEFAULT_PLUGINS, FINANCE_CATALOG, describeAction, policyFor } from "@profullstack/chat-plugins";
