import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A fake Supabase client: every count query resolves from `state.counts`
// (keyed by table), row queries from `state.rows`, and auth users from
// `state.users`. `state.fail` names a table whose query returns an error.
const state = {
    counts: {},
    rows: {},
    users: [],
    fail: null,
    nullCount: null,
    authError: null
};

function fakeClient() {
    return {
        auth: {
            admin: {
                async listUsers({ page, perPage }) {
                    if (state.authError) return { data: null, error: { message: state.authError } };
                    const start = (page - 1) * perPage;
                    return { data: { users: state.users.slice(start, start + perPage) }, error: null };
                }
            }
        },
        from(table) {
            let head = false;
            const result = () => {
                if (state.fail === table) return { data: null, count: null, error: { message: `relation "${table}" does not exist` } };
                if (head) {
                    const c = state.nullCount === table ? null : state.counts[table] ?? 1;
                    return { data: null, count: c, error: null };
                }
                return { data: state.rows[table] ?? [], error: null };
            };
            const q = {
                select(_cols, opts) { head = Boolean(opts?.head); return q; },
                eq() { return q; },
                gte() { return q; },
                order() { return q; },
                limit() { return Promise.resolve(result()); },
                then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); }
            };
            return q;
        }
    };
}

vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fakeClient() }));

const { POST } = await import("@/app/api/cron/daily-stats/route");
const { renderDailyStats, collectDailyStats } = await import("@/lib/daily-stats");

function req(path = "/api/cron/daily-stats", headers = { authorization: "Bearer s3cret" }) {
    return new Request(`https://infernetprotocol.com${path}`, { method: "POST", headers });
}

let fetchMock;

beforeEach(() => {
    process.env.CRON_SECRET = "s3cret";
    process.env.RESEND_API_KEY = "re_test";
    state.counts = { providers: 40, jobs: 739 };
    state.rows = {};
    state.users = [
        { created_at: new Date().toISOString() },
        { created_at: "2026-01-01T00:00:00Z" }
    ];
    state.fail = null;
    state.nullCount = null;
    state.authError = null;
    fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: "email_123" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.spyOn(console, "error").mockRestore();
});

describe("POST /api/cron/daily-stats", () => {
    it("rejects a missing or wrong secret", async () => {
        expect((await POST(req("/api/cron/daily-stats", {}))).status).toBe(401);
        expect((await POST(req("/api/cron/daily-stats", { authorization: "Bearer nope" }))).status).toBe(401);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("refuses everything when CRON_SECRET is unset", async () => {
        delete process.env.CRON_SECRET;
        expect((await POST(req("/api/cron/daily-stats", { authorization: "Bearer " }))).status).toBe(401);
    });

    it("accepts x-cron-secret too", async () => {
        const res = await POST(req("/api/cron/daily-stats?dry_run=1", { "x-cron-secret": "s3cret" }));
        expect(res.status).toBe(200);
    });

    it("sends the real counts to anthony@profullstack.com", async () => {
        const res = await POST(req());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ sent: true, id: "email_123" });
        expect(body.subject).toContain("2 users, 40 nodes, 739 jobs");
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.resend.com/emails");
        const payload = JSON.parse(init.body);
        expect(payload.to).toEqual(["anthony@profullstack.com"]);
        expect(payload.from).toContain("infernetprotocol.com");
        expect(payload.text).toContain("Total: 739");
    });

    it("dry run returns the stats and sends nothing", async () => {
        const res = await POST(req("/api/cron/daily-stats?dry_run=1"));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.dry_run).toBe(true);
        expect(body.stats.users).toMatchObject({ total: 2, new24h: 1 });
        expect(body.stats.nodes.total).toBe(40);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("counts the models live nodes serve, not the empty models table", async () => {
        state.rows = {
            providers: [
                { specs: { served_models: ["qwen2.5:0.5b", "gemma3:4b"] } },
                { specs: { served_models: ["qwen2.5:0.5b"] } },
                { specs: {} }
            ]
        };
        const res = await POST(req("/api/cron/daily-stats?dry_run=1"));
        const body = await res.json();
        expect(body.stats.models.served24h).toEqual(["gemma3:4b", "qwen2.5:0.5b"]);
        expect(typeof body.stats.nodes.live).toBe("number");
        const report = renderDailyStats(body.stats);
        expect(report.text).toContain("Served by nodes seen in 24h: 2 (gemma3:4b, qwen2.5:0.5b)");
        expect(report.html).toContain("gemma3:4b, qwen2.5:0.5b");
    });

    it("a query error sends nothing (500)", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        state.fail = "node_commands";
        const res = await POST(req());
        expect(res.status).toBe(500);
        const body = await res.json();
        expect(body.sent).toBe(false);
        expect(body.error).toContain("node_commands");
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("an auth admin error sends nothing (500)", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        state.authError = "invalid JWT";
        expect((await POST(req())).status).toBe(500);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a null count sends nothing (500)", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        state.nullCount = "models";
        expect((await POST(req())).status).toBe(500);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it.each([
        ["users", () => { state.users = []; }],
        ["providers", () => { state.counts.providers = 0; }],
        ["jobs", () => { state.counts.jobs = 0; }]
    ])("zero %s sends nothing (500)", async (_name, zero) => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        zero();
        expect((await POST(req())).status).toBe(500);
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it("a Resend failure is a 502", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        fetchMock.mockImplementation(async () => new Response("domain not verified", { status: 403 }));
        const res = await POST(req());
        expect(res.status).toBe(502);
        expect((await res.json()).error).toContain("Resend 403");
    });
});

describe("renderDailyStats", () => {
    it("escapes node names and job titles in the HTML", async () => {
        state.rows = {
            providers: [{ name: "<img src=x onerror=alert(1)>", status: "available", gpu_model: "RTX \"4090\"", created_at: "2026-09-29T00:00:00Z" }],
            jobs: [{ title: "<script>x</script>", status: "completed", model_name: "a&b", created_at: "2026-09-29T00:00:00Z" }]
        };
        const report = renderDailyStats(await collectDailyStats(fakeClient()));
        expect(report.html).not.toContain("<img src=x");
        expect(report.html).not.toContain("<script>x");
        expect(report.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
        expect(report.html).toContain("&lt;script&gt;x&lt;/script&gt;");
        expect(report.html).toContain("a&amp;b");
        expect(report.html).toContain("RTX &quot;4090&quot;");
    });
});
