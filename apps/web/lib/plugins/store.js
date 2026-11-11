import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
    CATALOG,
    discover,
    ensureFresh,
    finishAuth,
    listTools,
    needsApproval,
    openToken,
    resolvePluginInput,
    sealToken,
    startAuth,
    uniqueSlug
} from "@profullstack/chat-plugins";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { appUrl } from "@/lib/auth/app-url";

/*
 * Chat plugins: remote MCP servers a person adds to their account.
 *
 * Add = paste a URL or a catalog slug. The server discovers the plugin, and if
 * it wants sign-in, registers itself as an OAuth client (DCR) and hands back a
 * link that opens the plugin's own sign-in page. No forms, no client ids.
 *
 * Tokens are sealed with AES-256-GCM under a key derived from
 * INFERNET_DB_ENCRYPTION_KEY before they are written, and are only ever sent to
 * the plugin's own URL (the package refuses cross-host redirects with a token).
 */

export const MAX_PLUGINS_PER_USER = 20;
// Paths under /api/v1/plugins/ that are routes, not plugin slugs.
const RESERVED_SLUGS = ["callback", "catalog", "connect", "toggle"];
const TOOLS_TTL_MS = 10 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const APPROVAL_TTL_MS = 60 * 60 * 1000;
const TICKET_TTL_MS = 15 * 60 * 1000;

// Read through a variable: Next inlines literal process.env.NAME at build time.
const ENC_ENV = "INFERNET_DB_ENCRYPTION_KEY";

function withStatus(message, status) {
    return Object.assign(new Error(message), { status });
}

function secret() {
    const hex = process.env[ENC_ENV];
    if (!hex) throw withStatus("Plugins are not configured on this server (no encryption key).", 503);
    return hex;
}
const sealKey = () => `infernet-chat-plugins:v1:${secret()}`;

export function netOptions() {
    // Local dev may point a plugin at http://localhost; production never can.
    return process.env.NODE_ENV === "production" ? {} : { allowHttpLocalhost: true };
}

export function redirectUri() {
    return `${appUrl().replace(/\/+$/, "")}/api/v1/plugins/callback`;
}

export function catalog() {
    return CATALOG;
}

const db = () => getSupabaseServerClient();

/** PluginStore for registered OAuth clients (shared, not per user). */
const clientStore = {
    async getClient(key) {
        const { data } = await db().from("chat_plugin_clients").select("client").eq("key", key).maybeSingle();
        return data?.client ?? null;
    },
    async setClient(key, client) {
        const { error } = await db().from("chat_plugin_clients").upsert({ key, client });
        if (error) throw withStatus(error.message, 500);
    }
};

function toolView(t) {
    return {
        name: t.name,
        title: t.title ?? null,
        description: (t.description ?? "").slice(0, 300),
        needs_approval: needsApproval(t)
    };
}

function publicPlugin(row) {
    const connected = !!row.tokens_sealed;
    return {
        slug: row.slug,
        name: row.name,
        url: row.url,
        auth: row.auth,
        enabled: row.enabled,
        connected,
        needs_sign_in: row.auth === "oauth" && !connected,
        can_sign_in: row.auth !== "none" && !connected,
        tools: (Array.isArray(row.tools) ? row.tools : []).map(toolView),
        last_error: row.last_error ?? null,
        created_at: row.created_at
    };
}

async function rowsFor(userId) {
    const { data, error } = await db().from("chat_plugins").select("*").eq("user_id", userId).order("created_at", { ascending: true });
    if (error) throw withStatus(error.message, 500);
    return data ?? [];
}

async function rowFor(userId, slug) {
    const { data, error } = await db().from("chat_plugins").select("*").eq("user_id", userId).eq("slug", String(slug)).maybeSingle();
    if (error) throw withStatus(error.message, 500);
    if (!data) throw withStatus(`No plugin "${slug}". See /plugin ls.`, 404);
    return data;
}

export async function listPlugins(user) {
    return (await rowsFor(user.id)).map(publicPlugin);
}

// ---- one-time connect links (so a CLI or MCP client can open sign-in in any browser)

function b64url(buf) {
    return Buffer.from(buf).toString("base64url");
}

export function connectTicket(userId, slug, now = Date.now()) {
    const exp = now + TICKET_TTL_MS;
    const body = `${userId}.${slug}.${exp}`;
    const sig = createHmac("sha256", `plugin-ticket:${secret()}`).update(body).digest();
    return `${b64url(body)}.${b64url(sig)}`;
}

export function readTicket(ticket, now = Date.now()) {
    if (typeof ticket !== "string" || !ticket.includes(".")) return null;
    const [b, s] = ticket.split(".");
    let body;
    try {
        body = Buffer.from(b, "base64url").toString("utf8");
    } catch {
        return null;
    }
    const expect = createHmac("sha256", `plugin-ticket:${secret()}`).update(body).digest();
    const got = Buffer.from(s ?? "", "base64url");
    if (got.length !== expect.length || !timingSafeEqual(got, expect)) return null;
    const parts = body.split(".");
    const exp = Number(parts.pop());
    const slug = parts.pop();
    const userId = parts.join(".");
    if (!Number.isFinite(exp) || exp < now) return null;
    return { userId, slug };
}

export function connectLink(userId, slug) {
    return `${appUrl().replace(/\/+$/, "")}/api/v1/plugins/${encodeURIComponent(slug)}/connect?t=${encodeURIComponent(connectTicket(userId, slug))}`;
}

// ---- add / remove / toggle

export async function addPlugin(user, input) {
    const resolved = resolvePluginInput(input, catalog());
    if (!resolved) throw withStatus("Give a plugin URL (https://...) or a catalog name like c0mpute.", 400);
    const rows = await rowsFor(user.id);
    const same = rows.find((r) => r.url.replace(/\/+$/, "") === resolved.url.replace(/\/+$/, ""));
    if (same) {
        const plugin = publicPlugin(same);
        return { plugin, already: true, ...(plugin.can_sign_in ? { connect_url: connectLink(user.id, same.slug) } : {}) };
    }
    if (rows.length >= MAX_PLUGINS_PER_USER) throw withStatus(`At most ${MAX_PLUGINS_PER_USER} plugins; remove one first.`, 409);

    let server;
    try {
        server = await discover(resolved.url, netOptions());
    } catch (e) {
        throw withStatus(`Could not add ${resolved.name}: ${e?.message ?? e}`, 400);
    }
    const auth = server.auth === "none" ? "none" : server.auth.required === false ? "optional" : "oauth";
    let tools = [];
    let lastError = null;
    if (auth !== "oauth") {
        try {
            tools = await listTools({ url: server.url }, netOptions());
        } catch (e) {
            lastError = String(e?.message ?? e).slice(0, 300);
        }
    }
    const slug = uniqueSlug(resolved.slug, [...rows.map((r) => r.slug), ...RESERVED_SLUGS]);
    const name = resolved.entry?.name ?? server.title ?? server.name ?? resolved.name;
    const { data, error } = await db().from("chat_plugins").insert({
        user_id: user.id,
        slug,
        name: String(name).slice(0, 80),
        url: server.url,
        auth,
        enabled: true,
        tools,
        tools_at: auth !== "oauth" && !lastError ? new Date().toISOString() : null,
        instructions: server.instructions ? server.instructions.slice(0, 4000) : null,
        last_error: lastError
    }).select("*").single();
    if (error) throw withStatus(error.message, 500);
    const plugin = publicPlugin(data);
    return { plugin, ...(auth !== "none" ? { connect_url: connectLink(user.id, slug) } : {}) };
}

export async function removePlugin(user, slug) {
    const row = await rowFor(user.id, slug);
    const { error } = await db().from("chat_plugins").delete().eq("id", row.id);
    if (error) throw withStatus(error.message, 500);
    return { removed: row.slug };
}

export async function togglePlugin(user, slug, enabled) {
    const row = await rowFor(user.id, slug);
    const next = typeof enabled === "boolean" ? enabled : !row.enabled;
    const { data, error } = await db().from("chat_plugins")
        .update({ enabled: next, updated_at: new Date().toISOString() }).eq("id", row.id).select("*").single();
    if (error) throw withStatus(error.message, 500);
    return publicPlugin(data);
}

// ---- sign-in

/** Begin OAuth for a plugin; returns the provider's authorize URL. */
export async function startConnect(userId, slug, { returnTo } = {}) {
    const row = await rowFor(userId, slug);
    if (row.auth === "none") throw withStatus(`${row.name} does not use sign-in.`, 400);
    let server;
    try {
        server = await discover(row.url, netOptions());
    } catch (e) {
        throw withStatus(`Could not reach ${row.name}: ${e?.message ?? e}`, 502);
    }
    if (server.auth === "none") throw withStatus(`${row.name} no longer asks for sign-in.`, 400);
    const { authorizeUrl, pending } = await startAuth({
        server,
        redirectUri: redirectUri(),
        clientName: "Infernet chat",
        clientUri: appUrl(),
        store: clientStore,
        ...netOptions()
    });
    // Old sign-ins that never came back.
    await db().from("chat_plugin_auth_pending").delete().lt("created_at", new Date(Date.now() - PENDING_TTL_MS).toISOString());
    const { error } = await db().from("chat_plugin_auth_pending").insert({
        state: pending.state,
        user_id: userId,
        slug: row.slug,
        pending_sealed: await sealToken(pending, sealKey()),
        return_to: typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo.slice(0, 200) : null
    });
    if (error) throw withStatus(error.message, 500);
    return authorizeUrl;
}

/** Finish OAuth from the callback. */
export async function finishConnect({ state, code }) {
    if (!state) throw withStatus("Missing state.", 400);
    const { data: p } = await db().from("chat_plugin_auth_pending").select("*").eq("state", String(state)).maybeSingle();
    if (!p) throw withStatus("This sign-in link expired or was already used. Start again from /plugins.", 400);
    await db().from("chat_plugin_auth_pending").delete().eq("state", p.state);
    if (Date.now() - new Date(p.created_at).getTime() > PENDING_TTL_MS) throw withStatus("Sign-in took too long. Start again.", 400);
    const pending = await openToken(p.pending_sealed, sealKey());
    const row = await rowFor(p.user_id, p.slug);
    if (row.url !== pending.url) throw withStatus("The plugin changed while signing in. Start again.", 400);
    const tokens = await finishAuth({ pending, code, state, redirectUri: redirectUri(), ...netOptions() });
    let tools = Array.isArray(row.tools) ? row.tools : [];
    let lastError = null;
    try {
        tools = await listTools({ url: row.url, token: tokens.access_token }, netOptions());
    } catch (e) {
        lastError = String(e?.message ?? e).slice(0, 300);
    }
    const { error } = await db().from("chat_plugins").update({
        tokens_sealed: await sealToken(tokens, sealKey()),
        tools,
        tools_at: lastError ? row.tools_at : new Date().toISOString(),
        last_error: lastError,
        enabled: true,
        updated_at: new Date().toISOString()
    }).eq("id", row.id);
    if (error) throw withStatus(error.message, 500);
    return { slug: row.slug, name: row.name, userId: p.user_id, returnTo: p.return_to, tools: tools.length };
}

// ---- for the tool loop

/**
 * Enabled plugins ready for runToolLoop: fresh tokens, tool lists at most 10 min old.
 * Plugins that need sign-in are reported in `skipped`, not used.
 */
export async function loadLoopPlugins(userId) {
    const rows = (await rowsFor(userId)).filter((r) => r.enabled);
    const skipped = [];
    const plugins = await Promise.all(rows.map(async (row) => {
        let tokens = null;
        if (row.tokens_sealed) {
            try {
                tokens = await openToken(row.tokens_sealed, sealKey());
                const fresh = await ensureFresh(tokens, netOptions());
                if (fresh.refreshed) {
                    tokens = fresh.tokens;
                    await db().from("chat_plugins").update({ tokens_sealed: await sealToken(tokens, sealKey()), updated_at: new Date().toISOString() }).eq("id", row.id);
                }
            } catch (e) {
                // A refused refresh (invalid_grant) means sign in again; a network
                // blip keeps the stored tokens for the next turn.
                const refused = e?.status === 400 || e?.status === 401 || e?.code === "reauth_required" || !tokens;
                if (refused) {
                    tokens = null;
                    await db().from("chat_plugins").update({ tokens_sealed: null, last_error: `Sign in again: ${String(e?.message ?? e).slice(0, 200)}` }).eq("id", row.id);
                }
            }
        }
        if (row.auth === "oauth" && !tokens) {
            skipped.push({ slug: row.slug, name: row.name, reason: "needs_sign_in" });
            return null;
        }
        let tools = Array.isArray(row.tools) ? row.tools : [];
        const stale = !row.tools_at || Date.now() - new Date(row.tools_at).getTime() > TOOLS_TTL_MS;
        if (stale || !tools.length) {
            try {
                tools = await listTools({ url: row.url, token: tokens?.access_token }, netOptions());
                await db().from("chat_plugins").update({ tools, tools_at: new Date().toISOString(), last_error: null }).eq("id", row.id);
            } catch (e) {
                if (e?.code === "unauthorized" && row.auth === "oauth") {
                    skipped.push({ slug: row.slug, name: row.name, reason: "needs_sign_in" });
                    return null;
                }
                if (!tools.length) {
                    skipped.push({ slug: row.slug, name: row.name, reason: String(e?.message ?? e).slice(0, 200) });
                    return null;
                }
            }
        }
        return { slug: row.slug, name: row.name, url: row.url, token: tokens?.access_token, tools, enabled: true };
    }));
    return { plugins: plugins.filter(Boolean), skipped };
}

export async function hasEnabledPlugins(userId) {
    const { count } = await db().from("chat_plugins").select("id", { count: "exact", head: true }).eq("user_id", userId).eq("enabled", true);
    return (count ?? 0) > 0;
}

// ---- approval cards

export async function saveApproval(userId, pending, modelName) {
    await db().from("chat_plugin_approvals").delete().lt("created_at", new Date(Date.now() - APPROVAL_TTL_MS).toISOString());
    const { data, error } = await db().from("chat_plugin_approvals").insert({
        user_id: userId,
        model_name: modelName ?? null,
        pending_sealed: await sealToken(pending, sealKey())
    }).select("id").single();
    if (error) throw withStatus(error.message, 500);
    return data.id;
}

export async function takeApproval(userId, id) {
    const { data } = await db().from("chat_plugin_approvals").select("*").eq("id", String(id)).eq("user_id", userId).maybeSingle();
    if (!data) throw withStatus("This approval expired or was already answered.", 404);
    await db().from("chat_plugin_approvals").delete().eq("id", data.id);
    if (Date.now() - new Date(data.created_at).getTime() > APPROVAL_TTL_MS) throw withStatus("This approval expired.", 410);
    return { pending: await openToken(data.pending_sealed, sealKey()), modelName: data.model_name };
}
