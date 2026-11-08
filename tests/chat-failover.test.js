import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { issueChatRetryToken, verifyChatRetryToken, consumeChatRetryToken } = await import("../apps/web/lib/chat/retry-token.js");

afterEach(() => vi.unstubAllEnvs());

function fakeDb(job) {
    return {
        from(table) {
            if (table === "job_events") {
                return {
                    select: () => ({
                        eq: () => ({ eq: async () => ({ count: 0, error: null }) })
                    })
                };
            }
            return {
                select: () => ({
                    eq: (_field, value) => ({ maybeSingle: async () => ({ data: job.id === value ? job : null, error: null }) })
                }),
                update: (patch) => {
                    const filters = {};
                    const query = {
                        eq(field, value) { filters[field] = value; return query; },
                        select() { return query; },
                        async maybeSingle() {
                            if (job.id !== filters.id || job.status !== filters.status || job.error !== filters.error) {
                                return { data: null, error: null };
                            }
                            Object.assign(job, patch);
                            return { data: { id: job.id }, error: null };
                        }
                    };
                    return query;
                }
            };
        }
    };
}

describe("chat first-token failover token", () => {
    it("binds the one-use grant to the job, IP, fingerprint, and expiry", () => {
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret");
        const fields = {
            jobId: "62ebd4f8-23f1-4afd-8fb2-c415a994f222",
            nonce: "abcdefghijklmnopqrstuvwxyz012345",
            expiresAt: Date.now() + 60_000,
            ip: "203.0.113.4",
            fingerprint: "signed-browser-fingerprint"
        };
        const token = issueChatRetryToken(fields);
        expect(verifyChatRetryToken(token, fields)).toMatchObject({ jobId: fields.jobId, nonce: fields.nonce });
        expect(verifyChatRetryToken(token, { ...fields, ip: "203.0.113.5" })).toBeNull();
        expect(verifyChatRetryToken(token, { ...fields, fingerprint: "another-browser" })).toBeNull();
        expect(verifyChatRetryToken(token, { ...fields, now: fields.expiresAt + 1 })).toBeNull();
    });

    it("can be consumed once only", async () => {
        vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "test-secret");
        const job = {
            id: "62ebd4f8-23f1-4afd-8fb2-c415a994f222",
            status: "failed",
            error: "first_token_timeout:abcdefghijklmnopqrstuvwxyz012345"
        };
        const fields = {
            jobId: job.id,
            nonce: "abcdefghijklmnopqrstuvwxyz012345",
            expiresAt: Date.now() + 60_000,
            ip: "203.0.113.4",
            fingerprint: "signed-browser-fingerprint"
        };
        const token = issueChatRetryToken(fields);
        const db = fakeDb(job);
        await expect(consumeChatRetryToken({ token, ip: fields.ip, fingerprint: fields.fingerprint, supabase: db }))
            .resolves.toMatchObject({ ok: true, jobId: job.id });
        await expect(consumeChatRetryToken({ token, ip: fields.ip, fingerprint: fields.fingerprint, supabase: db }))
            .resolves.toMatchObject({ ok: false, status: 409 });
    });
});
