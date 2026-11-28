import "server-only";
import { isIP } from "node:net";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Reporting a request we know is an attack (code in a training config, not a
 * typo): one structured line on stdout that ThreatCrush's `[docker_logs]`
 * watcher turns into a ban for the source IP, plus a ban on the account.
 *
 * Line contract (ThreatCrush docker-logs app detections, v1):
 *   THREATCRUSH_DETECTION {"v":1,"ip":"...","severity":"high","category":"app.rce_payload",
 *                          "source":"infernet","reason":"...","account":"..."}
 * ThreatCrush applies its own protected list, private-address filter,
 * min_severity and ban length; this side only says what it saw.
 */

/**
 * The address nginx saw. nginx appends $remote_addr (after Cloudflare real-ip)
 * to X-Forwarded-For, so the LAST hop is the one a client cannot forge; the
 * first hop is whatever the client sent. Never ban on the first hop.
 */
export function trustedClientIp(request) {
    const h = request.headers;
    const hops = (h.get("x-forwarded-for") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    const last = hops.at(-1);
    if (last && isIP(last)) return last;
    const real = h.get("x-real-ip")?.trim();
    if (real && isIP(real)) return real;
    return null;
}

const clean = (s, n) => String(s ?? "").replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, n);

export function threatcrushDetectionLine({ ip, category, reason, account = null, severity = "high" }) {
    return `THREATCRUSH_DETECTION ${JSON.stringify({
        v: 1,
        ip,
        severity,
        category: clean(category, 64),
        source: "infernet",
        reason: clean(reason, 300),
        ...(account ? { account: clean(account, 64) } : {})
    })}`;
}

/**
 * @param {Request} request
 * @param {{ category: string, reason: string, userId?: string|null }} what
 */
export async function reportAttack(request, { category, reason, userId = null }) {
    const ip = trustedClientIp(request);
    if (ip) console.log(threatcrushDetectionLine({ ip, category, reason, account: userId }));
    else console.warn(`[security] ${category} with no client IP: ${clean(reason, 300)}`);

    if (userId) {
        try {
            // Code in a submission is unambiguous, so the account goes too.
            // ~100 years; lift with auth.admin.updateUserById(id, { ban_duration: "none" }).
            const { error } = await getSupabaseServerClient().auth.admin.updateUserById(userId, { ban_duration: "876000h" });
            if (error) console.warn(`[security] could not ban account ${userId}: ${error.message}`);
            else console.warn(`[security] banned account ${userId} (${category})`);
        } catch (e) {
            console.warn(`[security] could not ban account ${userId}: ${e?.message ?? e}`);
        }
    }
}
