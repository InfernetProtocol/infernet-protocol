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
 * Node operators get more (Anthony, 2026-11-09: "node operators get a bigger
 * free allowance"). Qualifying is decided in the database by
 * operator_qualifies() (20261109000000_operator_free_quota.sql): a linked,
 * enabled node at least three days old that our aggregators found reachable
 * in at least half of the last day's probes.
 */
export const DEFAULT_OPERATOR_FREE_QUERIES_PER_DAY = 100;
export const DEFAULT_OPERATOR_FREE_SONGS_PER_DAY = 5;

/**
 * The operator allowance from the interactive_billing settings row
 * (operator_free_queries_per_day, operator_free_songs_per_day); the defaults
 * when absent or malformed.
 */
export function resolveOperatorAllowance({ settings = null } = {}) {
    const s = settings && typeof settings === "object" && !Array.isArray(settings) ? settings : {};
    return {
        queries: int(s.operator_free_queries_per_day, DEFAULT_OPERATOR_FREE_QUERIES_PER_DAY),
        songs: int(s.operator_free_songs_per_day, DEFAULT_OPERATOR_FREE_SONGS_PER_DAY)
    };
}

/**
 * The daily limit to spend against. A qualifying operator gets the larger of
 * the two, so a misconfigured operator setting never leaves an operator with
 * less than a stranger gets.
 */
export function pickFreeLimit({ base, operatorLimit, qualifies = false }) {
    if (!qualifies || !Number.isInteger(operatorLimit)) return base;
    return Math.max(base, operatorLimit);
}

/**
 * Remember operator_qualifies() per user for a while (default five minutes),
 * so a chat does not run a probe aggregation per message.
 *
 * `check(userId)` resolves to a boolean. Anything that goes wrong (it throws,
 * or returns something that is not a boolean) reads as "not an operator" and
 * is NOT cached, so a database hiccup costs an operator the bonus for one
 * request rather than five minutes, and never blocks the request.
 */
export function createOperatorCache({ check, ttlMs = 5 * 60 * 1000, now = () => Date.now(), max = 10_000 } = {}) {
    const seen = new Map();
    return async function qualifies(userId) {
        if (typeof userId !== "string" || userId.length === 0) return false;
        const t = now();
        const hit = seen.get(userId);
        if (hit && hit.until > t) return hit.value;
        let value;
        try {
            value = await check(userId);
        } catch {
            return false;
        }
        if (typeof value !== "boolean") return false;
        seen.delete(userId);
        if (seen.size >= max) seen.delete(seen.keys().next().value);
        seen.set(userId, { value, until: t + ttlMs });
        return value;
    };
}

/**
 * How many free songs a qualifying operator gets today.
 *
 * operator_free_songs_per_day, but never fewer than a stranger could make:
 * a stranger spends one free query per song, so with the defaults they can
 * make up to 10 (burst-limited), and a cap of 5 would leave the operator
 * worse off than someone who never ran a node.
 */
export function operatorSongLimit({ songs, base }) {
    const s = Number.isInteger(songs) && songs >= 0 ? songs : DEFAULT_OPERATOR_FREE_SONGS_PER_DAY;
    const b = Number.isInteger(base) && base >= 0 ? base : 0;
    return Math.max(s, b);
}

/** A 429 body for an operator who has made all of today's free songs. */
export function songLimitMessage(limit) {
    return `free daily song limit reached (${limit} ${limit === 1 ? "song" : "songs"} a day for node operators). `
        + "Top up a compute balance to keep going, or spend what your nodes earned: "
        + "POST /api/v1/billing/topup, or /api/v1/billing/fund-from-earnings.";
}

/** The per-day song counter for a qualifying operator, beside their query counter. */
export function musicSubject(userId) {
    return typeof userId === "string" && userId.length > 0 ? `music:user:${userId}` : null;
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

/** Where someone learns to run a node. */
export const RUN_A_NODE_URL = "https://infernetprotocol.com/getting-started#operate";

/**
 * A 429 body that tells the caller what to do about it.
 *
 * Someone who is not already a qualifying operator also hears that running a
 * node raises the allowance: the most useful thing to tell someone who wants
 * more for free, and the cheapest way for the network to get more supply.
 * `opts` is usually the consumeFreeQuery result itself ({ operator,
 * operatorLimit }).
 */
export function freeLimitMessage(limit, { operator = false, operatorLimit = DEFAULT_OPERATOR_FREE_QUERIES_PER_DAY } = {}) {
    let m = `free daily limit reached (${limit} ${limit === 1 ? "query" : "queries"} a day). `
        + "Top up a compute balance to keep going, or spend what your nodes earned: "
        + "POST /api/v1/billing/topup, or /api/v1/billing/fund-from-earnings.";
    if (!operator && Number.isInteger(operatorLimit) && operatorLimit > limit) {
        m += ` Or run an Infernet node to get ${operatorLimit} free queries a day: ${RUN_A_NODE_URL}`;
    }
    return m;
}

/** Seconds until the allowance resets (next UTC midnight). */
export function secondsUntilReset(now = new Date()) {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0);
    return Math.max(1, Math.ceil((next - now.getTime()) / 1000));
}
