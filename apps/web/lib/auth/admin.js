/**
 * Who is an Infernet admin. Pure (env in, answer out) so routes, pages and
 * tests agree on one rule:
 *
 *   INFERNET_ADMIN_USER_IDS  comma list of auth user ids (preferred)
 *   INFERNET_ADMIN_EMAILS    comma list of emails; only counts once the
 *                            account's email is confirmed
 */

function list(v) {
    return String(v ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

export function isAdminUser(user, env = process.env) {
    if (!user?.id) return false;
    if (list(env.INFERNET_ADMIN_USER_IDS).includes(String(user.id).toLowerCase())) return true;
    const email = String(user.email ?? "").toLowerCase();
    const confirmed = Boolean(user.email_confirmed_at ?? user.confirmed_at);
    return Boolean(email) && confirmed && list(env.INFERNET_ADMIN_EMAILS).includes(email);
}

/** A post-login redirect target: same-site paths only, never another host. */
export function safeNext(next, fallback = "/dashboard") {
    const v = typeof next === "string" ? next.trim() : "";
    if (!v.startsWith("/") || v.startsWith("//") || v.startsWith("/\\") || /[\r\n\t]/.test(v)) return fallback;
    return v;
}

/**
 * Cookie auth must only count for requests made by our own pages, or any
 * site could drive a signed-in admin's browser. Browsers send Sec-Fetch-Site;
 * fall back to comparing Origin with Host.
 */
export function isSameOriginRequest(headers) {
    const site = headers.get("sec-fetch-site");
    if (site) return site === "same-origin";
    const origin = headers.get("origin");
    if (!origin) return true;
    try {
        return new URL(origin).host === (headers.get("x-forwarded-host") ?? headers.get("host"));
    } catch {
        return false;
    }
}
