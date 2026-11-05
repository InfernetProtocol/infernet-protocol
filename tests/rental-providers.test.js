import { describe, expect, it } from "vitest";
import {
    RENTAL_PROVIDERS, RENTAL_TIERS, rentalProviderOf, isRentalClass, providerById,
    operatorNameFor, rentalModelError, rentalModelsFor, rentalAction,
    PENDING_ENDPOINT_URL, isPendingEndpoint, WARMUP_MS
} from "../apps/web/lib/reservations/rental.js";
import {
    VAST_CLASSES, VAST_TIERS, offerQuery, pickOffer, instanceSpec as vastSpec, instanceLabel,
    endpointOf as vastEndpoint, instancePhase as vastPhase, vastConfig, vastModelError,
    MIN_RELIABILITY, VAST_PORT, DISK_GB as VAST_DISK
} from "../apps/web/lib/reservations/vast.js";
import {
    THUNDER_CLASSES, THUNDER_TIERS, instanceSpec as thunderSpec, liveCostOf, isAvailable,
    endpointOf as thunderEndpoint, instancePhase as thunderPhase, thunderConfig, thunderModelError,
    modelsFitting as thunderModels, THUNDER_PORT, THUNDER_TEMPLATE, DISK_PER_HOUR
} from "../apps/web/lib/reservations/thunder.js";
import { validateOrderInput, quoteFor, capacity, reservationFromOrder } from "../apps/web/lib/reservations/orders.js";
import { tierOf, ALL_TIERS, priceList } from "../apps/web/lib/reservations/pricing.js";
import { VLLM_MODELS, OLLAMA_MODELS, fitting, largestFitting } from "../apps/web/lib/reservations/rental-models.js";
import { priceFromCost } from "../apps/web/lib/reservations/margin.js";

const NOW = Date.parse("2026-11-05T09:20:00.000Z");
const NEXT = "2026-11-05T10:00:00.000Z";

describe("the rented-provider registry", () => {
    it("holds the three clouds, each with the keys it needs", () => {
        expect(RENTAL_PROVIDERS.map((p) => p.id)).toEqual(["salad", "vast", "thunder"]);
        expect(providerById("vast").env).toEqual(["VAST_API_KEY"]);
        expect(providerById("thunder").env).toEqual(["THUNDER_API_TOKEN"]);
        expect(providerById("salad").env).toContain("SALAD_ORG");
        expect(providerById("nope")).toBeNull();
    });

    it("routes a class to the provider that serves it, and leaves network classes alone", () => {
        expect(rentalProviderOf("vast-rtx4090").id).toBe("vast");
        expect(rentalProviderOf("THUNDER-A100").id).toBe("thunder");
        expect(rentalProviderOf("rtx4090").id).toBe("salad");
        expect(rentalProviderOf("h100")).toBeNull();
        expect(isRentalClass("l40s")).toBe(false);
        // Prototype keys must not resolve as classes.
        expect(rentalProviderOf("constructor")).toBeNull();
        expect(rentalProviderOf("toString")).toBeNull();
    });

    it("never lets two providers claim the same class id", () => {
        const seen = new Map();
        for (const p of RENTAL_PROVIDERS) {
            for (const id of Object.keys(p.tiers)) {
                expect(seen.has(id)).toBe(false);
                seen.set(id, p.id);
            }
        }
        expect(seen.size).toBe(Object.keys(RENTAL_TIERS).length);
    });

    it("names the cloud as the operator, since there is no node to name", () => {
        expect(operatorNameFor("vast-h100")).toBe("Infernet on Vast.ai");
        expect(operatorNameFor("thunder-l40")).toBe("Infernet on Thunder Compute");
        expect(operatorNameFor("rtx4090")).toBe("Infernet on SaladCloud");
        expect(operatorNameFor("h100", { id: "n1", name: "bonita" })).toBe("bonita");
        expect(operatorNameFor("h100", { id: "n1", name: "" })).toBe("node n1");
        expect(operatorNameFor("h100")).toBeNull();
    });
});

describe("the order tiers the new providers add", () => {
    it("joins ALL_TIERS without disturbing the Salad or network classes", () => {
        expect(tierOf("vast-rtx4090")).toBe(VAST_TIERS["vast-rtx4090"]);
        expect(tierOf("thunder-a100")).toBe(THUNDER_TIERS["thunder-a100"]);
        expect(tierOf("rtx4090").source).toBe("salad");
        expect(tierOf("h100").source).toBeUndefined();
        const listed = priceList().tiers.map((t) => t.gpu_class);
        expect(listed).toEqual(expect.arrayContaining(["h100", "rtx5090", "vast-h100", "thunder-h100"]));
    });

    it("lists every rented card at twice our cost", () => {
        for (const t of [...Object.values(VAST_TIERS), ...Object.values(THUNDER_TIERS)]) {
            expect(t.price_per_hour).toBeGreaterThanOrEqual(t.cost_per_hour * 2 - 1e-9);
            expect(t.price_per_hour).toBeLessThan(t.cost_per_hour * 2 + 0.01);
        }
    });

    it("rounds a doubled cost to the cent without overcharging one", () => {
        // 0.55 * 2 * 100 is 110.00000000000001 in floating point: ceilinged raw
        // it billed $1.11 for a $1.10 price (margin.js priceFromCost).
        expect(priceFromCost(0.55)).toBe(1.1);
        expect(priceFromCost(1.12)).toBe(2.24);
        // A real fraction of a cent still rounds up, so the margin holds.
        expect(priceFromCost(0.333)).toBe(0.67);
        expect(VAST_TIERS["vast-a6000"].price_per_hour).toBe(1.1);
    });

    it("charges the renter twice our cost per hour at the default margin", () => {
        // Vast quotes from our ceiling, so the price never moves with the market.
        expect(quoteFor("vast-rtx4090", 1).price_per_hour).toBe(0.9);
        expect(quoteFor("vast-h100", 1).price_per_hour).toBe(4.8);
        // Thunder: $1.09 GPU + $0.03 disk, doubled.
        expect(quoteFor("thunder-a100", 1).price_per_hour).toBe(2.24);
        expect(quoteFor("thunder-a6000", 1).price_per_hour).toBe(0.76);
    });

    it("prices Thunder's disk into our cost, because Thunder bills it separately", () => {
        expect(DISK_PER_HOUR).toBe(0.03);
        expect(THUNDER_CLASSES["thunder-h100"].cost_per_hour).toBe(3.23);
        expect(THUNDER_CLASSES["thunder-h100"].gpu_per_hour).toBe(3.2);
    });

    it("marks what each transport does not give us", () => {
        // Plain HTTP to a shared IP on Vast; TLS but an unauthenticated Ollama on Thunder.
        expect(VAST_TIERS["vast-rtx4090"].encrypted_transport).toBe(false);
        expect(THUNDER_TIERS["thunder-a100"].upstream_authenticated).toBe(false);
    });
});

describe("models on a rented card", () => {
    it("offers HF repos on vLLM providers and Ollama tags on Thunder", () => {
        expect(rentalModelsFor("vast-rtx4090")).toContain("Qwen/Qwen2.5-32B-Instruct-AWQ");
        expect(rentalModelsFor("thunder-a100")).toContain("qwen2.5:32b");
        expect(rentalModelsFor("thunder-a100")).not.toContain("Qwen/Qwen2.5-32B-Instruct-AWQ");
        expect(rentalModelsFor("h100")).toEqual([]);
    });

    it("only offers what fits the card", () => {
        // 24GB: the 72B AWQ (48GB) does not fit; the 32B AWQ does.
        expect(rentalModelsFor("vast-rtx4090")).not.toContain("Qwen/Qwen2.5-72B-Instruct-AWQ");
        expect(rentalModelsFor("vast-a100")).toContain("Qwen/Qwen2.5-72B-Instruct-AWQ");
        expect(thunderModels("thunder-a6000")).toContain("qwen2.5:32b");
        expect(thunderModels("thunder-a6000")).toContain("qwen2.5:72b");
    });

    it("insists on exactly one model that fits", () => {
        expect(vastModelError("vast-rtx4090", ["Qwen/Qwen2.5-7B-Instruct"])).toBeNull();
        expect(vastModelError("vast-rtx4090", [])).toMatch(/exactly one model/);
        expect(vastModelError("vast-rtx4090", ["Qwen/Qwen2.5-7B-Instruct", "Qwen/Qwen2.5-3B-Instruct"])).toMatch(/exactly one model/);
        expect(vastModelError("vast-rtx3090", ["Qwen/Qwen2.5-72B-Instruct-AWQ"])).toMatch(/is not offered on RTX 3090/);
        expect(thunderModelError("thunder-a6000", ["qwen2.5:7b"])).toBeNull();
        expect(thunderModelError("thunder-a6000", ["Qwen/Qwen2.5-7B-Instruct"])).toMatch(/is not offered/);
        // A network class has no such rule: it can serve several models.
        expect(rentalModelError("h100", ["a", "b"])).toBeNull();
    });

    it("fits by VRAM, and treats Infinity as 'every model' rather than none", () => {
        expect(fitting(VLLM_MODELS, Infinity)).toHaveLength(VLLM_MODELS.length);
        expect(fitting(OLLAMA_MODELS, Infinity)).toHaveLength(OLLAMA_MODELS.length);
        expect(fitting(VLLM_MODELS, 0)).toEqual([]);
        expect(fitting(VLLM_MODELS, "nonsense")).toEqual([]);
        expect(largestFitting(OLLAMA_MODELS, 12)).toBe(14);
        expect(largestFitting(OLLAMA_MODELS, 0)).toBe(0);
    });
});

describe("validating an order for a rented class", () => {
    it("takes a good one and names the whole class list on a bad one", () => {
        const ok = validateOrderInput({ gpu_class: "vast-rtx4090", models: ["Qwen/Qwen2.5-7B-Instruct"], hours: 2 }, NOW);
        expect(ok).toMatchObject({ ok: true });
        expect(ok.value.gpu_class).toBe("vast-rtx4090");
        const bad = validateOrderInput({ gpu_class: "vast-9090", models: ["x"] }, NOW);
        expect(bad.ok).toBe(false);
        expect(bad.errors[0]).toMatch(/vast-rtx4090/);
        expect(bad.errors[0]).toMatch(/thunder-a100/);
    });

    it("refuses a model the rented card cannot hold", () => {
        const bad = validateOrderInput({ gpu_class: "thunder-a6000", models: ["qwen2.5:7b", "qwen2.5:3b"] }, NOW);
        expect(bad.ok).toBe(false);
        expect(bad.errors.join()).toMatch(/exactly one model/);
    });
});

describe("capacity across providers", () => {
    it("is unavailable until the provider says a class can be bought this minute", () => {
        const none = capacity([], [], NOW);
        expect(none.find((c) => c.gpu_class === "vast-h100")).toMatchObject({ source: "vast", available: false, nodes_available: null, models_per_order: 1 });
        expect(none.find((c) => c.gpu_class === "thunder-l40")).toMatchObject({ source: "thunder", available: false });

        const some = capacity([], [], NOW, 100, {
            rented: { "vast-h100": { available: true }, "thunder-l40": { available: false } }
        });
        expect(some.find((c) => c.gpu_class === "vast-h100").available).toBe(true);
        expect(some.find((c) => c.gpu_class === "thunder-l40").available).toBe(false);
        // A network class is unaffected by the rented map.
        expect(some.find((c) => c.gpu_class === "h100")).toMatchObject({ source: "network", available: false });
    });

    it("lists every rented class exactly once, with its models", () => {
        const classes = capacity([], [], NOW);
        const rented = classes.filter((c) => c.nodes_available === null);
        expect(rented).toHaveLength(Object.keys(RENTAL_TIERS).length);
        expect(new Set(rented.map((c) => c.gpu_class)).size).toBe(rented.length);
        expect(rented.every((c) => c.models.length > 0)).toBe(true);
    });
});

describe("the reservation a rented order becomes", () => {
    const order = {
        id: "o1", name: null, email: null, operator_name: "Infernet on Vast.ai",
        gpu_class: "vast-rtx4090", models: ["Qwen/Qwen2.5-7B-Instruct"],
        start_at: NEXT, hours: 2, price_per_hour: 0.9, setup_fee: 5.9, total_usd: 7.7, rail: "x402", provider_id: null
    };

    it("targets an endpoint it cannot reach yet, never a node", () => {
        const r = reservationFromOrder(order);
        expect(r.target_kind).toBe("endpoint");
        expect(r.provider_id).toBeNull();
        expect(r.endpoint_url).toBe(PENDING_ENDPOINT_URL);
        expect(isPendingEndpoint(r.endpoint_url)).toBe(true);
        // .invalid can never resolve, so a request before the cron fills it in fails closed.
        expect(new URL(r.endpoint_url).hostname.endsWith(".invalid")).toBe(true);
    });

    it("takes the real address once the provider hands one over", () => {
        const r = reservationFromOrder(order, { url: "http://1.2.3.4:33526/v1", apiKey: "k" });
        expect(r.endpoint_url).toBe("http://1.2.3.4:33526/v1");
        expect(r.endpoint_api_key).toBe("k");
        expect(isPendingEndpoint(r.endpoint_url)).toBe(false);
    });

    it("still pins the node for a network class", () => {
        const r = reservationFromOrder({ ...order, gpu_class: "h100", provider_id: "node-1" });
        expect(r).toMatchObject({ target_kind: "node", provider_id: "node-1", endpoint_url: null });
    });
});

describe("the rented lifecycle the cron drives", () => {
    const start = Date.parse(NEXT);
    const vast = { rental_provider: "vast", rental_ref: null, rental_state: "pending", start_at: NEXT, hours: 2 };
    const salad = { rental_provider: "salad", rental_ref: "infernet-o1", rental_state: "created", start_at: NEXT, hours: 2 };

    it("does nothing before warm-up, however close the booking is", () => {
        expect(rentalAction(vast, start - WARMUP_MS - 1000)).toBeNull();
        expect(rentalAction(salad, start - WARMUP_MS - 1000)).toBeNull();
    });

    it("rents a by-the-hour box at warm-up, and only starts a Salad group", () => {
        expect(rentalAction(vast, start - WARMUP_MS)).toBe("rent");
        expect(rentalAction({ ...vast, rental_provider: "thunder" }, start - WARMUP_MS)).toBe("rent");
        // A stopped Salad group already exists; it is started, never rented.
        expect(rentalAction(salad, start - WARMUP_MS)).toBe("start");
        expect(rentalAction({ ...salad, rental_state: "pending" }, start - WARMUP_MS)).toBeNull();
    });

    it("keeps asking a rented box to serve until it does", () => {
        const rented = { ...vast, rental_ref: "9911", rental_state: "created" };
        expect(rentalAction(rented, start - WARMUP_MS + 60_000)).toBe("serve");
        expect(rentalAction(rented, start + 60_000)).toBe("serve");
        expect(rentalAction({ ...rented, rental_state: "started" }, start + 60_000)).toBeNull();
    });

    it("gives the box back when the window closes, whatever state it was in", () => {
        const end = start + 2 * 60 * 60 * 1000;
        expect(rentalAction({ ...vast, rental_ref: "9911", rental_state: "created" }, end)).toBe("delete");
        expect(rentalAction({ ...vast, rental_ref: "9911", rental_state: "started" }, end)).toBe("delete");
        expect(rentalAction(salad, end)).toBe("delete");
        // An order that never got a box still ends, so the row stops being tended.
        expect(rentalAction(vast, end)).toBe("delete");
        expect(rentalAction({ ...salad, rental_state: "deleted" }, end)).toBeNull();
    });

    it("reads a row written before the provider columns existed as a created Salad group", () => {
        expect(rentalAction({ rental_provider: "salad", rental_ref: "g", rental_state: null, start_at: NEXT, hours: 1 }, start - WARMUP_MS)).toBe("start");
    });

    it("ignores a row it cannot act on", () => {
        expect(rentalAction({ rental_provider: null, start_at: NEXT, hours: 1 }, start)).toBeNull();
        expect(rentalAction({ rental_provider: "vast", start_at: "nonsense", hours: 1 }, start)).toBeNull();
        expect(rentalAction({ rental_provider: "vast", start_at: NEXT, hours: null }, start)).toBeNull();
        expect(rentalAction(null, start)).toBeNull();
    });
});

describe("Vast.ai: picking and renting an offer", () => {
    it("asks only for whole, verified, reliable, on-demand GPUs under our ceiling", () => {
        const q = offerQuery("vast-rtx4090").q;
        expect(q.gpu_name).toEqual({ eq: "RTX_4090" });
        expect(q.num_gpus).toEqual({ eq: 1 });
        expect(q.rentable).toEqual({ eq: true });
        expect(q.verified).toEqual({ eq: true });
        expect(q.reliability).toEqual({ gte: MIN_RELIABILITY });
        expect(q.type).toBe("on-demand");
        expect(q.dph_total).toEqual({ lte: VAST_CLASSES["vast-rtx4090"].ceiling_per_hour });
        expect(q.order).toEqual([["dph_total", "asc"]]);
        // gpu_ram is MB in the REST API, GB in the CLI.
        expect(q.gpu_ram.gte).toBeGreaterThan(1024);
        expect(offerQuery("nope")).toBeNull();
    });

    it("takes the cheapest offer that clears the ceiling and refuses the rest", () => {
        const offers = [
            { id: 3, dph_total: 0.44, reliability: 0.99, num_gpus: 1 },
            { id: 1, dph_total: 0.9, reliability: 0.999, num_gpus: 1 },   // over the 0.45 ceiling
            { id: 2, dph_total: 0.3, reliability: 0.5, num_gpus: 1 },     // too unreliable
            { id: 4, dph_total: 0.2, reliability: 0.99, num_gpus: 1 }
        ];
        expect(pickOffer(offers, "vast-rtx4090").id).toBe(4);
        expect(pickOffer([{ id: 1, dph_total: 0.9, reliability: 1 }], "vast-rtx4090")).toBeNull();
        expect(pickOffer([], "vast-rtx4090")).toBeNull();
        expect(pickOffer(null, "vast-rtx4090")).toBeNull();
        // A free or negative price is a broken row, not a bargain.
        expect(pickOffer([{ id: 7, dph_total: 0, reliability: 1, num_gpus: 1 }], "vast-rtx4090")).toBeNull();
    });

    it("breaks a price tie on the offer id so a retry picks the same box", () => {
        const offers = [
            { id: 9, dph_total: 0.2, reliability: 0.99, num_gpus: 1 },
            { id: 4, dph_total: 0.2, reliability: 0.99, num_gpus: 1 }
        ];
        expect(pickOffer(offers, "vast-rtx4090").id).toBe(4);
        expect(pickOffer([...offers].reverse(), "vast-rtx4090").id).toBe(4);
    });

    it("starts vLLM on the one booked model, with a key only we hold", () => {
        const spec = vastSpec({ orderId: "o1", gpuClass: "vast-rtx4090", model: "Qwen/Qwen2.5-7B-Instruct", apiKey: "sek", image: "vllm/vllm-openai:v0.11.0" });
        expect(spec.image).toBe("vllm/vllm-openai:v0.11.0");
        expect(spec.disk).toBe(VAST_DISK);
        expect(spec.runtype).toBe("args");
        expect(spec.env).toContain(`-p ${VAST_PORT}:${VAST_PORT}`);
        expect(spec.args).toEqual(expect.arrayContaining(["--model", "Qwen/Qwen2.5-7B-Instruct", "--api-key", "sek"]));
        expect(spec.args).toEqual(expect.arrayContaining(["--port", String(VAST_PORT)]));
        expect(spec.label).toBe("infernet-o1");
        expect(vastSpec({ orderId: "o1", gpuClass: "nope" })).toBeNull();
    });

    it("labels an instance so an orphan can be recognised as ours", () => {
        expect(instanceLabel("Order_42/x")).toBe("infernet-order42x");
        expect(instanceLabel("a".repeat(50))).toHaveLength("infernet-".length + 32);
    });

    it("reads the external address out of the docker-style port map", () => {
        const inst = { public_ipaddr: "63.135.50.11", ports: { "8000/tcp": [{ HostIp: "0.0.0.0", HostPort: "33526" }] } };
        expect(vastEndpoint(inst)).toEqual({ url: "http://63.135.50.11:33526/v1", host: "63.135.50.11", port: 33526 });
        // Not published yet: no IP, no mapping, or only the docs' simplified array.
        expect(vastEndpoint({ ports: { "8000/tcp": [{ HostPort: "1" }] } })).toBeNull();
        expect(vastEndpoint({ public_ipaddr: "1.2.3.4" })).toBeNull();
        expect(vastEndpoint({ public_ipaddr: "1.2.3.4", ports: [8000] })).toBeNull();
        expect(vastEndpoint({ public_ipaddr: "1.2.3.4", ports: { "9000/tcp": [{ HostPort: "1" }] } })).toBeNull();
        expect(vastEndpoint(null)).toBeNull();
    });

    it("knows the documented poll trap: some states never reach running", () => {
        expect(vastPhase({ actual_status: "running" })).toBe("running");
        expect(vastPhase({ actual_status: "loading" })).toBe("starting");
        expect(vastPhase({ actual_status: "created" })).toBe("starting");
        for (const dead of ["exited", "unknown", "offline"]) {
            expect(vastPhase({ actual_status: dead })).toBe("dead");
        }
    });

    it("is off sale without a key", () => {
        expect(vastConfig({})).toBeNull();
        expect(vastConfig({ VAST_API_KEY: "  " })).toBeNull();
        expect(vastConfig({ VAST_API_KEY: "k" })).toMatchObject({ apiKey: "k", image: expect.stringContaining("vllm") });
        expect(vastConfig({ VAST_API_KEY: "k", VAST_VLLM_IMAGE: "mine:1" }).image).toBe("mine:1");
    });
});

describe("Thunder Compute: the stock Ollama template", () => {
    it("asks for one GPU on the ollama template with the cheapest vCPU option", () => {
        const spec = thunderSpec("thunder-a100");
        expect(spec).toEqual({ gpu_type: "a100xl", num_gpus: 1, cpu_cores: 8, disk_size_gb: 100, template: THUNDER_TEMPLATE });
        expect(thunderSpec("thunder-a6000", "ssh-ed25519 AAA").public_key).toBe("ssh-ed25519 AAA");
        expect(thunderSpec("nope")).toBeNull();
    });

    it("reads our cost out of Thunder's live rate card, disk included", () => {
        const live = { pricing: { a100xl_x1: 1.09, h100_x1: 3.2, disk_gb: 0.0003 } };
        expect(liveCostOf(live, "thunder-a100")).toBe(1.12);
        expect(liveCostOf(live, "thunder-h100")).toBe(3.23);
        // A rise shows up as a higher live cost, which is what takes it off sale.
        expect(liveCostOf({ pricing: { a100xl_x1: 2, disk_gb: 0.0003 } }, "thunder-a100")).toBe(2.03);
        expect(liveCostOf({ pricing: {} }, "thunder-a100")).toBeNull();
        expect(liveCostOf(null, "thunder-a100")).toBeNull();
        expect(liveCostOf(live, "nope")).toBeNull();
    });

    it("quotes from the snapshot, and the snapshot matches what Thunder charged on review day", () => {
        const reviewed = { pricing: { a6000_x1: 0.35, l40_x1: 0.79, a100xl_x1: 1.09, h100_x1: 3.2, disk_gb: 0.0003 } };
        for (const [id, c] of Object.entries(THUNDER_CLASSES)) {
            expect(liveCostOf(reviewed, id)).toBe(c.cost_per_hour);
        }
    });

    it("believes Thunder's own availability feed", () => {
        const status = {
            specs: { a100xl_x1: "available", h100_x1: "unavailable" },
            gpu_type: { l40: { 1: "available" }, a6000: { 1: "unavailable" } }
        };
        expect(isAvailable(status, "thunder-a100")).toBe(true);
        expect(isAvailable(status, "thunder-h100")).toBe(false);
        // Falls back to the per-type map when the spec key is missing.
        expect(isAvailable(status, "thunder-l40")).toBe(true);
        expect(isAvailable(status, "thunder-a6000")).toBe(false);
        expect(isAvailable({}, "thunder-a100")).toBe(false);
        expect(isAvailable(null, "thunder-a100")).toBe(false);
    });

    it("addresses a forwarded port at its own https host", () => {
        const inst = { uuid: "abc-123", httpPorts: [8000] };
        expect(thunderEndpoint(inst)).toEqual({
            url: "https://abc-123-8000.thundercompute.com/v1",
            base: "https://abc-123-8000.thundercompute.com",
            uuid: "abc-123"
        });
        // Nothing to address until the port is actually forwarded.
        expect(thunderEndpoint({ uuid: "abc-123", httpPorts: [] })).toBeNull();
        expect(thunderEndpoint({ uuid: "abc-123" })).toBeNull();
        expect(thunderEndpoint({ httpPorts: [THUNDER_PORT] })).toBeNull();
    });

    it("maps Thunder's status to a phase", () => {
        expect(thunderPhase({ status: "running" })).toBe("running");
        expect(thunderPhase({ status: "pending" })).toBe("starting");
        expect(thunderPhase({ status: "starting" })).toBe("starting");
        for (const dead of ["stopped", "terminated", "deleted", "failed", "error"]) {
            expect(thunderPhase({ status: dead })).toBe("dead");
        }
    });

    it("is off sale without a token", () => {
        expect(thunderConfig({})).toBeNull();
        expect(thunderConfig({ THUNDER_API_TOKEN: " " })).toBeNull();
        expect(thunderConfig({ THUNDER_API_TOKEN: "t" })).toEqual({ token: "t" });
    });
});
