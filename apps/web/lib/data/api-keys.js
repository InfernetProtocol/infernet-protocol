import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { requestUser } from "@/lib/auth/request-user";

/**
 * Consumer API keys for paid batch inference: ik_live_<43 base64url chars>.
 * Only the sha256 is stored; the key is shown once at creation. Scoped to
 * the user who made it, revocable, last_used_at on every use.
 *
 * Keys are made, listed and revoked by the signed-in user (site cookie or
 * `infernet login` bearer), never by another key.
 */

export const KEY_PREFIX = "ik_live_";
const KEY_RE = /^ik_live_[A-Za-z0-9_-]{43}$/;
const MAX_KEYS_PER_USER = 25;

const sha256 = (s) => createHash("sha256").update(String(s)).digest("hex");

function withStatus(message, status) {
    return Object.assign(new Error(message), { status });
}

export function looksLikeApiKey(s) {
    return typeof s === "string" && KEY_RE.test(s);
}

export function newApiKey() {
    const key = `${KEY_PREFIX}${randomBytes(32).toString("base64url")}`;
    return { key, hash: sha256(key), prefix: key.slice(0, KEY_PREFIX.length + 6) };
}

function publicKey(row) {
    return {
        id: row.id,
        name: row.name,
        prefix: row.key_prefix,
        created_at: row.created_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at
    };
}

export async function createApiKey(user, { name } = {}) {
    const db = getSupabaseServerClient();
    const { count, error: cErr } = await db.from("inference_api_keys")
        .select("id", { count: "exact", head: true }).eq("user_id", user.id).is("revoked_at", null);
    if (cErr) throw withStatus(cErr.message, 500);
    if ((count ?? 0) >= MAX_KEYS_PER_USER) throw withStatus(`at most ${MAX_KEYS_PER_USER} active keys; revoke one first`, 409);
    const k = newApiKey();
    const { data, error } = await db.from("inference_api_keys").insert({
        user_id: user.id,
        user_email: user.email ?? null,
        name: typeof name === "string" && name.trim() ? name.trim().slice(0, 100) : null,
        key_prefix: k.prefix,
        key_hash: k.hash
    }).select("*").single();
    if (error) throw withStatus(error.message, 500);
    return { ...publicKey(data), key: k.key };
}

export async function listApiKeys(user) {
    const { data, error } = await getSupabaseServerClient().from("inference_api_keys")
        .select("*").eq("user_id", user.id).order("created_at", { ascending: false }).limit(100);
    if (error) throw withStatus(error.message, 500);
    return (data ?? []).map(publicKey);
}

export async function revokeApiKey(user, id) {
    if (!/^[0-9a-f-]{36}$/i.test(String(id ?? ""))) throw withStatus("key not found", 404);
    const { data, error } = await getSupabaseServerClient().from("inference_api_keys")
        .update({ revoked_at: new Date().toISOString() })
        .eq("id", id).eq("user_id", user.id).is("revoked_at", null)
        .select("*").maybeSingle();
    if (error) throw withStatus(error.message, 500);
    if (!data) throw withStatus("key not found or already revoked", 404);
    return publicKey(data);
}

/** The owner of a live API key, or null. Touches last_used_at. */
export async function userForApiKey(key) {
    if (!looksLikeApiKey(key)) return null;
    const db = getSupabaseServerClient();
    const { data, error } = await db.from("inference_api_keys")
        .select("id, user_id, user_email, revoked_at").eq("key_hash", sha256(key)).maybeSingle();
    if (error || !data || data.revoked_at) return null;
    await db.from("inference_api_keys").update({ last_used_at: new Date().toISOString() }).eq("id", data.id);
    return { id: data.user_id, email: data.user_email ?? null, via: "api_key", key_id: data.id };
}

/**
 * Caller of the batch / billing API: an ik_live_ key as Bearer, else the
 * signed-in user (`infernet login` bearer or site cookie). null = anonymous.
 */
export async function billingCaller(request) {
    const m = /^Bearer\s+(\S+)$/.exec(request.headers.get("authorization") ?? "");
    if (m && m[1].startsWith(KEY_PREFIX)) return userForApiKey(m[1]);
    return requestUser(request);
}
