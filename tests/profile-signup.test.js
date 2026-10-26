import { describe, expect, it, vi, beforeEach } from "vitest";

process.env.NEXT_PUBLIC_APP_URL = "https://example.test";

// The cookie Supabase client (signUp) and the service-role client the shared
// profile store writes user_profiles through.
let signUpResult;
let signUpArgs;
const upserts = [];

vi.mock("@/lib/supabase/auth-server", () => ({
    getSupabaseAuthClient: async () => ({
        auth: {
            signUp: async (args) => {
                signUpArgs = args;
                return signUpResult;
            }
        }
    }),
    getCurrentUser: async () => null
}));

vi.mock("@/lib/supabase/server", () => ({
    getSupabaseServerClient: () => ({
        auth: {},
        from: (table) => ({
            upsert: (row, opts) => {
                upserts.push({ table, row, opts });
                return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
            }
        })
    })
}));

const { POST } = await import("@/app/api/auth/signup/route");

function jsonReq(body) {
    return new Request("https://example.test/api/auth/signup", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify(body)
    });
}

describe("POST /api/auth/signup profile fields", () => {
    beforeEach(() => {
        upserts.length = 0;
        signUpArgs = null;
        signUpResult = { data: { user: null }, error: null };
    });

    it("requires first and last name before signing up", async () => {
        const res = await POST(jsonReq({ email: "ada@acme.com", password: "longenough" }));
        expect(res.status).toBe(400);
        const body = await res.json();
        expect(Object.keys(body.errors)).toEqual(expect.arrayContaining(["first_name", "last_name"]));
        expect(signUpArgs).toBeNull();
    });

    it("stores the six fields in user_profiles for a new account", async () => {
        signUpResult = { data: { user: { id: "u-1", email: "ada@acme.com", identities: [{}] } }, error: null };
        const res = await POST(
            jsonReq({
                email: "ada@acme.com",
                password: "longenough",
                first_name: "Ada",
                last_name: "Lovelace",
                company_domain: "https://www.acme.com/about",
                job_title: " VP Engineering ",
                linkedin_url: "in/ada-lovelace"
            })
        );
        expect(res.status).toBe(200);
        expect(signUpArgs.options.data).toMatchObject({ first_name: "Ada", company_domain: "acme.com" });
        expect(upserts).toHaveLength(1);
        expect(upserts[0]).toMatchObject({ table: "user_profiles", opts: { onConflict: "user_id" } });
        expect(upserts[0].row).toMatchObject({
            user_id: "u-1",
            email: "ada@acme.com",
            first_name: "Ada",
            last_name: "Lovelace",
            company_domain: "acme.com",
            job_title: "VP Engineering",
            linkedin_url: "https://www.linkedin.com/in/ada-lovelace"
        });
    });

    it("leaves an already-registered address alone", async () => {
        signUpResult = { data: { user: { id: "u-old", email: "a@b.co", identities: [] } }, error: null };
        const res = await POST(jsonReq({ email: "a@b.co", password: "longenough", first_name: "A", last_name: "B" }));
        expect(res.status).toBe(200);
        expect(upserts).toHaveLength(0);
    });
});
