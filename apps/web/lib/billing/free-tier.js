/**
 * The free allowance: how many queries a day someone gets for nothing.
 *
 * Pure half. The counter itself is in the database
 * (20261105120000_free_query_allowance.sql) because an in-memory daily count
 * resets on every deploy, and this app deploys several times a day.
 *
 * The allowance is spent per CONSUMER, not per endpoint:
 *
 *   signed in            user:<id>          their account, wherever they call from
 *   trusted client user  user:<id>          a c0mpute.com person, resolved from
 *                                           their CoinPay subject, so the free
 *                                           tier is theirs and not the client's
 *   named but unlinked   sub:<hash>         the same person before they have an
 *                                           account here, keyed on the subject
 *                                           rather than the client's server IP
 *   anonymous browser    visitor:<key>      the DEVICE, from
 *                                           @profullstack/browser-fingerprint
 *   anonymous API caller ip:<key>           the address prefix, hashed
 *
 * Keying an identified caller on their account rather than their IP is what
 * stops ten people behind one office NAT sharing one allowance, and equally
 * stops one person collecting a fresh allowance per IP they appear from.
 *
 * The anonymous keys come from @profullstack/browser-fingerprint rather than
 * being hashed here. It is the house module for this ("one vote per browser,
 * not per IP") and it does the parts worth not hand-writing: a server-signed
 * challenge so a payload cannot be replayed, one visitor per token, a bot
 * score, and a keyed hash of the caller's /24 or /64 rather than the exact
 * address. The /24 matters: a hash of the exact address handed out a fresh
 * allowance for every address someone appeared from, which is the hole this
 * closes.
 */

/** Ten a day (Anthony, 2026-11-05: "make free queries limited to ten per day"). */
export const DEFAULT_FREE_QUERIES_PER_DAY = 10;

function int(v, fallback, { min = 0, max = 1_000_000 } = {}) {
    const n = typeof v === "string" ? Number.parseInt(v, 10) : v;
    if (!Number.isInteger(n) || n < min || n > max) return fallback;
    return n;
}

/**
 * Resolve the allowance: defaults < env < settings row. A malformed value
 * falls back rather than becoming unlimited, because the failure that matters
 * here is giving compute away.
 */
export function resolveFreeAllowance({ env = {}, settings = null } = {}) {
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    const fromEnv = int(env.INFERNET_FREE_QUERIES_PER_DAY, DEFAULT_FREE_QUERIES_PER_DAY);
    return int(s.free_queries_per_day, fromEnv);
}

/**
 * Who this free query is charged against.
 *
 * `userId` wins over the address whenever we have one, including for a trusted
 * client calling on behalf of one of its own people. Returns null when there
 * is nothing to key on, which the caller treats as "do not serve free".
 */
export function freeSubject({
    userId = null,
    clientSubject = null,
    visitorKey = null,
    ipKey = null
} = {}) {
    if (typeof userId === "string" && userId.length > 0) return `user:${userId}`;
    // A trusted client named a person who has no account here yet. Key on
    // that person, not on the client's server address: otherwise every
    // unlinked c0mpute.com user would share ONE allowance between them,
    // because they all reach us from the same IP.
    if (typeof clientSubject === "string" && clientSubject.length > 0) return `sub:${clientSubject}`;
    // A browser that collected a fingerprint against a signed challenge: the
    // device, not the address.
    if (typeof visitorKey === "string" && visitorKey.length > 0) return `visitor:${visitorKey}`;
    // Everything else (an API client, curl, the CLI): the hashed address
    // prefix the guard derived.
    if (typeof ipKey === "string" && ipKey.length > 0) return `ip:${ipKey}`;
    return null;
}

/** Only a confident bot signal costs someone the free tier. */
export const DEFAULT_BOT_THRESHOLD = 0.9;

/**
 * Should this free request be refused as automation?
 *
 * The bot score is heuristic and the package says good automation passes it,
 * so it only gates the FREE tier: a bot is welcome to pay. Refusing a human on
 * a false positive would be worse than serving a bot ten queries, which is why
 * the threshold is deliberately loose and a missing score never refuses.
 */
export function looksLikeBot(bot, threshold = DEFAULT_BOT_THRESHOLD) {
    const score = Number(bot?.score);
    return Number.isFinite(score) && score >= threshold;
}

/** A 429 body that tells the caller what to do about it. */
export function freeLimitMessage(limit) {
    return `free daily limit reached (${limit} ${limit === 1 ? "query" : "queries"} a day). `
        + "Top up a compute balance to keep going, or spend what your nodes earned: "
        + "POST /api/v1/billing/topup, or /api/v1/billing/fund-from-earnings.";
}

/** Seconds until the allowance resets (next UTC midnight). */
export function secondsUntilReset(now = new Date()) {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
    return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
