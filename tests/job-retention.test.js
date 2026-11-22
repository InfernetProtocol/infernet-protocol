import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeSupabase } from "./fixtures/fake-supabase.js";

/**
 * No-retain (house-lane) jobs: purgeJobContent removes the prompt, the answer
 * and the token stream and keeps only billing counts. A retained job is never
 * touched.
 */

process.env.INFERNET_DB_ENCRYPTION_KEY = "ab".repeat(32);
let fake;
vi.mock("@/lib/supabase/server", () => ({ getSupabaseServerClient: () => fake }));

const { encryptJSON, decryptJSON } = await import("../apps/web/lib/encrypt.js");
const { purgeJobContent } = await import("../apps/web/lib/data/job-retention.js");

const PROMPT = "Patient record: HbA1c 6.1% on 2024-03-02";

beforeEach(() => {
    fake = createFakeSupabase({
        tables: {
            jobs: [
                {
                    id: "j-house", no_retain: true, content_purged_at: null,
                    input_spec: encryptJSON({ messages: [{ role: "user", content: PROMPT }], billing: "interactive_balance", input_tokens: 40, max_tokens: 512, no_retain: true }),
                    result: encryptJSON({ text: "Your A1c was 6.1%" })
                },
                {
                    id: "j-normal", no_retain: false, content_purged_at: null,
                    input_spec: encryptJSON({ messages: [{ role: "user", content: "hello" }] }),
                    result: encryptJSON({ text: "hi" })
                }
            ],
            job_events: [
                { id: 1, job_id: "j-house", event_type: "token", data: encryptJSON({ text: "Your A1c" }) },
                { id: 2, job_id: "j-normal", event_type: "token", data: encryptJSON({ text: "hi" }) }
            ]
        }
    });
});

describe("purgeJobContent", () => {
    it("strips the prompt, the answer and the token stream of a no-retain job", async () => {
        const r = await purgeJobContent("j-house");
        expect(r.purged).toBe(true);
        const job = fake.db.tables.jobs.find((j) => j.id === "j-house");
        const spec = decryptJSON(job.input_spec);
        expect(spec).toEqual({ no_retain: true, purged: true, billing: "interactive_balance", input_tokens: 40, max_tokens: 512 });
        expect(decryptJSON(job.result)).toEqual({ redacted: true });
        expect(job.content_purged_at).toBeTruthy();
        expect(fake.db.tables.job_events.filter((e) => e.job_id === "j-house")).toHaveLength(0);
        expect(JSON.stringify(fake.db.tables.jobs)).not.toContain("HbA1c");
    });

    it("never touches a retained job", async () => {
        const r = await purgeJobContent("j-normal");
        expect(r).toMatchObject({ purged: false, reason: "retained_job" });
        expect(fake.db.tables.job_events.filter((e) => e.job_id === "j-normal")).toHaveLength(1);
        expect(decryptJSON(fake.db.tables.jobs.find((j) => j.id === "j-normal").result)).toEqual({ text: "hi" });
    });
});
