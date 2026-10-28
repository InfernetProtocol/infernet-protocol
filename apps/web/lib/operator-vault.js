import "server-only";
import {
    UnlockStore,
    base64ToBytes,
    createSealer,
    isCipherBlob,
    isSealRecord,
    parseTtl,
    wipe
} from "@profullstack/sealed-secrets";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/*
 * The operator vault: Infernet's own CoinPay payout key, sealed.
 *
 * Payouts move real money, so the key that can send them is not kept in the
 * environment around the clock. It is sealed under a passphrase only the
 * operators hold; an admin unlocks from /admin/payouts (the browser derives the
 * data key and sends only that) and the key is opened just before each payout.
 * Unlocks last 7 days by default (max 7). A restart forgets the key: payouts,
 * including auto-approved ones, wait in 'requested' until someone unlocks, and
 * the first locked attempt logs one alert line for the uptime path to pick up.
 */

export const sealer = createSealer({ app: "infernet", scope: "operator" });
export const SUBJECT = "operator";
const FIELD = "coinpay_payout_api_key";
const ROW = "operator";
const DEFAULT_TTL = "7d";

const STORE = Symbol.for("infernet.operatorVault");
function state() {
    globalThis[STORE] ??= { store: new UnlockStore(), alerted: false };
    return globalThis[STORE];
}
export function resetOperatorVaultForTests() {
    state().store.lockAll();
    delete globalThis[STORE];
}

export class OperatorLockedError extends Error {
    constructor(message = "Operator keys are locked: unlock the operator vault on /admin/payouts to send payouts.") {
        super(message);
        this.name = "OperatorLockedError";
        this.status = 423;
    }
}

function alertOnce(why) {
    const s = state();
    if (s.alerted) return;
    s.alerted = true;
    // One line per lock; the fleet uptime/alert path watches for "[alert]".
    console.error(`[alert] infernetprotocol.com: operator keys locked, unlock to resume (${why})`);
}

const db = () => getSupabaseServerClient();

export async function readVault(client = db()) {
    const { data, error } = await client.from("operator_secrets").select("seal, blob").eq("name", ROW).maybeSingle();
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { seal: isSealRecord(data?.seal) ? data.seal : null, blob: isCipherBlob(data?.blob) ? data.blob : null };
}

export async function status(client) {
    const { seal, blob } = await readVault(client);
    return { exists: Boolean(seal), hasPayoutKey: Boolean(blob), seal, subject: SUBJECT, ...state().store.status(SUBJECT) };
}

export async function createVault(seal, client = db()) {
    if (!isSealRecord(seal)) throw Object.assign(new Error("a sealed vault record is required"), { status: 400 });
    const current = await readVault(client);
    if (current.seal) throw Object.assign(new Error("the operator vault already exists"), { status: 409 });
    const { error } = await client.from("operator_secrets").insert({ name: ROW, seal });
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { exists: true };
}

export async function unlock(dekBase64, ttl = DEFAULT_TTL, client = db()) {
    const { seal } = await readVault(client);
    if (!seal) throw Object.assign(new Error("create the operator vault first"), { status: 404 });
    let seconds;
    try {
        seconds = parseTtl(String(ttl || DEFAULT_TTL));
    } catch {
        throw Object.assign(new Error("ttl must look like 8h or 7d (7 days at most)"), { status: 400 });
    }
    const dek = base64ToBytes(String(dekBase64 || ""));
    try {
        if (dek.length !== 32 || !(await sealer.verifyDataKey(dek, seal, SUBJECT))) {
            throw Object.assign(new Error("that passphrase does not open the operator vault"), { status: 403 });
        }
        const out = state().store.unlock(SUBJECT, dek, seconds);
        state().alerted = false;
        return out;
    } finally {
        wipe(dek);
    }
}

export function lock() {
    state().store.lock(SUBJECT);
    return { unlocked: false, expiresAt: null };
}

/** Seal a payout key with the unlocked vault. The plaintext is never stored. */
export async function setPayoutKey(apiKey, client = db()) {
    const key = String(apiKey ?? "").trim();
    if (key.length < 10) throw Object.assign(new Error("paste the CoinPay payout API key"), { status: 400 });
    const dek = state().store.get(SUBJECT);
    if (!dek) throw new OperatorLockedError();
    const blob = await sealer.sealSecrets(dek, { [FIELD]: key }, SUBJECT, FIELD);
    const { error } = await client
        .from("operator_secrets")
        .update({ blob, updated_at: new Date().toISOString() })
        .eq("name", ROW);
    if (error) throw Object.assign(new Error(error.message), { status: 500 });
    return { hasPayoutKey: true };
}

/** The payout key, opened just before use. Never falls back to the environment. */
export async function payoutKey(client = db()) {
    const dek = state().store.get(SUBJECT);
    if (!dek) {
        alertOnce("no unlock in this process");
        throw new OperatorLockedError();
    }
    const { blob } = await readVault(client);
    if (!blob) throw Object.assign(new Error("no payout key sealed yet: add it on /admin/payouts"), { status: 503 });
    const map = await sealer.unsealSecrets(dek, blob, SUBJECT, FIELD);
    return map[FIELD];
}
