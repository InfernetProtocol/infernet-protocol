import { describe, expect, it, vi, beforeEach } from "vitest";

process.env.INFERNET_CLI_SESSION_SECRET = "test-cli-session-secret-bytes-32x";
process.env.NEXT_PUBLIC_APP_URL = "https://example.test";

let mockedUser = null;
vi.mock("@/lib/supabase/auth-server", () => ({
    getCurrentUser: async () => mockedUser,
    getSupabaseAuthClient: async () => null
}));
vi.mock("server-only", () => ({}));

const { listOffers, launch, cloudConfig, vastOnstart } = await import("@/lib/deploy/one-click");
const { POST } = await import("@/app/api/v1/user/deploy/one-click/route");

const CI_URL = "https://example.test/api/deploy/cloud-init?token=abc";

function fakeFetch(routes) {
    const calls = [];
    const impl = async (url, init = {}) => {
        calls.push({ url, init, body: init.body ? JSON.parse(init.body) : undefined });
        const hit = routes.find(([match]) => url.startsWith(match));
        if (!hit) throw new Error(`unexpected fetch ${url}`);
        const [, status, payload] = hit;
        return { ok: status < 400, status, text: async () => JSON.stringify(payload) };
    };
    return { impl, calls };
}

describe("boot scripts", () => {
    it("cloud-config runs the cloud-init one-liner", () => {
        expect(cloudConfig(CI_URL)).toBe(`#cloud-config\nruncmd:\n  - curl -fsSL '${CI_URL}' | sh\n`);
    });
    it("vast on-start installs curl first", () => {
        expect(vastOnstart(CI_URL)).toMatch(/^\(command -v curl .*apt-get install -y curl.*\) && curl -fsSL '/);
    });
});

describe("listOffers", () => {
    it("linode: GPU types only, regions need GPU + Metadata, cheapest first", async () => {
        const { impl } = fakeFetch([
            ["https://api.linode.com/v4/linode/types", 200, { data: [
                { id: "g6-standard-2", gpus: 0, price: { hourly: 0.03 }, vcpus: 2, memory: 4096, label: "Linode 4GB" },
                { id: "g1-gpu-rtx6000-1", gpus: 1, price: { hourly: 1.5 }, vcpus: 8, memory: 32768, label: "RTX6000 x1" },
                { id: "g2-gpu-rtx4000a1-s", gpus: 1, price: { hourly: 0.52 }, vcpus: 4, memory: 16384, label: "RTX4000 Ada x1 Small" }
            ] }],
            ["https://api.linode.com/v4/regions/availability", 200, { pages: 1, data: [
                { region: "us-ord", plan: "g2-gpu-rtx4000a1-s", available: true },
                { region: "us-sea", plan: "g2-gpu-rtx4000a1-s", available: false },
                { region: "us-sea", plan: "g1-gpu-rtx6000-1", available: true }
            ] }],
            ["https://api.linode.com/v4/regions", 200, { data: [
                { id: "us-ord", capabilities: ["GPU Linodes", "Metadata"] },
                { id: "us-sea", capabilities: ["GPU Linodes", "Metadata"] },
                { id: "us-east", capabilities: ["GPU Linodes"] },
                { id: "nl-ams", capabilities: ["Metadata"] }
            ] }]
        ]);
        const offers = await listOffers({ provider: "linode", fetchImpl: impl });
        expect(offers.map((o) => o.id)).toEqual(["g2-gpu-rtx4000a1-s", "g1-gpu-rtx6000-1"]);
        // only regions where that plan is in stock (and Metadata exists)
        expect(offers[0].regions).toEqual(["us-ord"]);
        expect(offers[1].regions).toEqual(["us-sea"]);
    });

    it("vast: requires a key and sends it as a bearer", async () => {
        await expect(listOffers({ provider: "vast", apiKey: "" })).rejects.toThrow(/API key required/);
        const { impl, calls } = fakeFetch([["https://console.vast.ai/api/v0/bundles/", 200, { offers: [
            { id: 9, gpu_name: "RTX 4090", num_gpus: 1, gpu_ram: 24564, dph_total: 0.41, geolocation: "US", reliability2: 0.995 },
            { id: 7, gpu_name: "RTX 3090", num_gpus: 1, gpu_ram: 24576, dph_total: 0.19, geolocation: "PL", reliability2: 0.99 }
        ] }]]);
        const offers = await listOffers({ provider: "vast", apiKey: "k1", fetchImpl: impl });
        expect(calls[0].init.headers.authorization).toBe("Bearer k1");
        expect(offers.map((o) => o.id)).toEqual(["7", "9"]);
        expect(offers[1].vramGb).toBe(24);
    });

    it("maps a provider 401 to a 401 with a plain message", async () => {
        const { impl } = fakeFetch([["https://api.digitalocean.com/v2/sizes", 401, { message: "Unable to authenticate you" }]]);
        await expect(listOffers({ provider: "digitalocean", apiKey: "bad", fetchImpl: impl }))
            .rejects.toMatchObject({ status: 401, message: "DigitalOcean: Unable to authenticate you" });
    });
});

describe("launch", () => {
    it("vast: PUT /asks/<id>/ with the P2P port and on-start, returns new_contract", async () => {
        const { impl, calls } = fakeFetch([["https://console.vast.ai/api/v0/asks/123/", 200, { success: true, new_contract: 555 }]]);
        const r = await launch({ provider: "vast", apiKey: "k", offerId: "123", cloudInitUrl: CI_URL, fetchImpl: impl });
        expect(r).toEqual({ provider: "vast", instanceId: "555", consoleUrl: "https://cloud.vast.ai/instances/?id=555" });
        expect(calls[0].init.method).toBe("PUT");
        expect(calls[0].body.env).toEqual({ "-p 46337:46337": "1" });
        expect(calls[0].body.onstart).toContain(CI_URL);
    });

    it("vultr: base64 cloud-config user_data + Ubuntu 24.04", async () => {
        const { impl, calls } = fakeFetch([["https://api.vultr.com/v2/instances", 202, { instance: { id: "abc-1" } }]]);
        const r = await launch({ provider: "vultr", apiKey: "k", offerId: "vcg-l40s-16c-180g-48vram", region: "ewr", cloudInitUrl: CI_URL, fetchImpl: impl });
        expect(r.instanceId).toBe("abc-1");
        expect(calls[0].body.os_id).toBe(2284);
        expect(Buffer.from(calls[0].body.user_data, "base64").toString()).toBe(cloudConfig(CI_URL));
    });

    it("linode: metadata.user_data is base64 cloud-config", async () => {
        const { impl, calls } = fakeFetch([["https://api.linode.com/v4/linode/instances", 200, { id: 42 }]]);
        await launch({ provider: "linode", apiKey: "k", offerId: "g2-gpu-rtx4000a1-s", region: "us-ord", cloudInitUrl: CI_URL, fetchImpl: impl });
        expect(Buffer.from(calls[0].body.metadata.user_data, "base64").toString()).toBe(cloudConfig(CI_URL));
        expect(calls[0].body.root_pass.length).toBeGreaterThan(20);
    });

    it("VM providers need a region; offer ids are validated", async () => {
        await expect(launch({ provider: "linode", apiKey: "k", offerId: "x", cloudInitUrl: CI_URL })).rejects.toThrow(/region/);
        await expect(launch({ provider: "vast", apiKey: "k", offerId: "../x", cloudInitUrl: CI_URL })).rejects.toThrow(/offerId/);
    });
});

function req(body) {
    return { headers: { get: () => null }, json: async () => body };
}

describe("POST /api/v1/user/deploy/one-click", () => {
    beforeEach(() => { mockedUser = null; });

    it("401 when signed out", async () => {
        const res = await POST(req({ action: "offers", provider: "vast", apiKey: "k" }));
        expect(res.status).toBe(401);
    });

    it("launch mints a token into the cloud-init URL and never echoes the key", async () => {
        mockedUser = { id: "user-1", email: "a@example.test" };
        const seen = [];
        const realFetch = globalThis.fetch;
        globalThis.fetch = async (url, init) => {
            seen.push({ url, body: JSON.parse(init.body) });
            return { ok: true, status: 200, text: async () => JSON.stringify({ success: true, new_contract: 77 }) };
        };
        try {
            const res = await POST(req({ action: "launch", provider: "vast", apiKey: "secret-key-xyz", offerId: "5" }));
            const json = await res.json();
            expect(res.status).toBe(200);
            expect(json.data.instanceId).toBe("77");
            expect(JSON.stringify(json)).not.toContain("secret-key-xyz");
            expect(seen[0].body.onstart).toMatch(/https:\/\/example\.test\/api\/deploy\/cloud-init\?token=[\w.-]+/);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});
