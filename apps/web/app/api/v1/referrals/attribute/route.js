import { NextResponse } from "next/server";
import { attributeNode } from "@/lib/data/referrals";
import { verifyC0mputeClaim, normalizeReferralCode } from "@/lib/referrals/core";
import { bearerFrom } from "@/lib/reservations/core";
import { trustedClientFor, billedSubjectFrom } from "@/lib/trusted-clients";
import { userIdForCoinpaySubject } from "@/lib/data/interactive-billing";
import { getClientIp, rateLimit } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 30 });

/**
 * POST /api/v1/referrals/attribute
 *   { peer_id, code, ts, sig }
 *
 * A c0mpute node claims its referral when it registers. `sig` is the node's
 * ed25519 signature (its libp2p identity key) over
 *   c0mpute-referral:v1:<peer_id>:<code>:<ts>
 * so only the holder of a node's key can attach a code to it. The node is
 * keyed as `c0mpute:<peer_id>`, the provider Infernet settles its jobs on.
 *
 * c0mpute.com relays these with its trusted key and may name the node's
 * operator (X-Infernet-Billed-Subject = their CoinPay sub, from the node's
 * chat key) and the node's address (X-Infernet-Client-Ip), which feed the
 * self-referral checks. Infernet daemons attribute through
 * `infernet register --ref` instead.
 */
export async function POST(request) {
    const trusted = trustedClientFor(bearerFrom(request.headers.get("authorization")));
    const ip = trusted ? request.headers.get("x-infernet-client-ip") || null : getClientIp(request);
    if (!trusted) {
        const rl = limiter.check(`ref-attr:${ip ?? "unknown"}`);
        if (!rl.ok) return NextResponse.json({ error: "too many referral claims, try later" }, { status: 429 });
    }
    let body = {};
    try {
        body = (await request.json()) ?? {};
    } catch {
        /* empty body */
    }
    const peerId = typeof body.peer_id === "string" ? body.peer_id.trim() : "";
    const code = normalizeReferralCode(body.code);
    if (!code) return NextResponse.json({ error: "a referral code is required", reason: "unknown_code" }, { status: 400 });
    const check = verifyC0mputeClaim({ peerId, code, ts: body.ts, sig: body.sig });
    if (!check.ok) return NextResponse.json({ error: check.error, reason: "bad_signature" }, { status: 401 });

    const subject = billedSubjectFrom(request, trusted);
    const ownerUserId = subject ? await userIdForCoinpaySubject(subject) : null;
    try {
        const out = await attributeNode({ nodeKey: `c0mpute:${peerId}`, code, via: "c0mpute-node", ip, ownerUserId });
        const status = out.attributed ? (out.already ? 200 : 201) : 409;
        return NextResponse.json({ data: out }, { status, headers: { "cache-control": "no-store" } });
    } catch (err) {
        console.error("[referrals] attribute failed", err?.message ?? err);
        return NextResponse.json({ error: "could not record the referral right now" }, { status: 503 });
    }
}
