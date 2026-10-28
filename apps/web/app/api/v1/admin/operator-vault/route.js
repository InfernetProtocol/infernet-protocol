import { requireAdmin, ok, fail } from "@/lib/reservations/http";
import * as vault from "@/lib/operator-vault";

export const dynamic = "force-dynamic";

/**
 * The operator vault (lib/operator-vault.js). Admins only.
 *
 * GET  -> { exists, hasPayoutKey, seal, unlocked, expiresAt }  (seal is ciphertext;
 *         the browser needs it to derive the data key from the passphrase)
 * POST { action: "create", seal }            first time, made in the browser
 *      { action: "unlock", dek, ttl? }       the derived data key, never the passphrase
 *      { action: "lock" }
 *      { action: "set_payout_key", key }     sealed with the unlocked vault
 */
export async function GET(request) {
    const { error } = await requireAdmin(request);
    if (error) return error;
    try {
        return ok(await vault.status());
    } catch (e) {
        return fail(e.status ?? 500, e.message);
    }
}

export async function POST(request) {
    const { actor, error } = await requireAdmin(request);
    if (error) return error;
    const body = await request.json().catch(() => ({}));
    try {
        switch (body.action) {
            case "create":
                return ok(await vault.createVault(body.seal), 201);
            case "unlock": {
                const out = await vault.unlock(body.dek, body.ttl);
                console.log(`[operator-vault] unlocked by ${actor} until ${out.expiresAt}`);
                return ok(out);
            }
            case "lock":
                console.log(`[operator-vault] locked by ${actor}`);
                return ok(vault.lock());
            case "set_payout_key":
                return ok(await vault.setPayoutKey(body.key));
            default:
                return fail(400, "action must be create, unlock, lock or set_payout_key");
        }
    } catch (e) {
        return fail(e.status ?? 500, e.message);
    }
}
