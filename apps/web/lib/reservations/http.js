import "server-only";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { verifyBearerHeader } from "@/lib/auth/bearer";
import { bearerFrom } from "@/lib/reservations/core";
import { getReservation, buyerTokenMatches } from "@/lib/data/reservations";

/**
 * Auth + response helpers for /api/v1/reservations/*.
 *
 * Admin (create, keys, pricing): either
 *   - Authorization: Bearer $INFERNET_ADMIN_TOKEN, or
 *   - a CLI bearer (`infernet login`) whose email is in INFERNET_ADMIN_EMAILS
 *     or whose user id is in INFERNET_ADMIN_USER_IDS (comma lists).
 * Buyer (one reservation only: show, report, invoice, and issue / list /
 *   revoke that reservation's keys for its own customers): the reservation's
 *   buyer token, as X-Buyer-Token or ?token=. It cannot create, reprice or
 *   cancel reservations.
 */

function list(v) {
    return String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function same(a, b) {
    const x = Buffer.from(String(a));
    const y = Buffer.from(String(b));
    return x.length === y.length && timingSafeEqual(x, y);
}

/** Returns an actor string for an admin caller, or null. */
export function adminActor(request) {
    const header = request.headers.get("authorization");
    const token = bearerFrom(header);
    const adminToken = process.env.INFERNET_ADMIN_TOKEN;
    if (token && adminToken && adminToken.length >= 32 && same(token, adminToken)) return "admin-token";
    const claims = verifyBearerHeader(header);
    if (!claims) return null;
    const email = String(claims.email ?? "").toLowerCase();
    if (email && list(process.env.INFERNET_ADMIN_EMAILS).includes(email)) return `user:${claims.sub}`;
    if (list(process.env.INFERNET_ADMIN_USER_IDS).includes(String(claims.sub).toLowerCase())) return `user:${claims.sub}`;
    return null;
}

export function fail(status, message, extra = {}) {
    return NextResponse.json({ error: message, ...extra }, { status, headers: { "cache-control": "no-store" } });
}

export function ok(data, status = 200) {
    return NextResponse.json({ data }, { status, headers: { "cache-control": "no-store" } });
}

export function requireAdmin(request) {
    const actor = adminActor(request);
    return actor ? { actor } : { error: fail(401, "admin authorization required") };
}

/** Load a reservation for an admin or for the buyer holding its token. */
export async function loadForReader(request, id) {
    const res = await getReservation(id);
    if (!res) return { error: fail(404, "reservation not found") };
    if (adminActor(request)) return { res, as: "admin" };
    const token = request.headers.get("x-buyer-token") || new URL(request.url).searchParams.get("token");
    if (buyerTokenMatches(res, token)) return { res, as: "buyer" };
    return { error: fail(401, "admin authorization or the reservation's buyer token is required") };
}

export async function guard(fn) {
    try {
        return await fn();
    } catch (e) {
        const status = Number.isInteger(e?.status) ? e.status : 500;
        if (status >= 500) console.error("[reservations]", e?.message ?? e);
        return fail(status, e?.message ?? String(e));
    }
}
