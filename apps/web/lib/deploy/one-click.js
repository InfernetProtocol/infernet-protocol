/**
 * One-click deploy: rent a GPU on the operator's OWN cloud account and
 * boot it straight into an Infernet node.
 *
 * The browser sends the operator's provider API key with each request;
 * it is used for that one call and never stored or logged. The node is
 * linked to the operator's Infernet account through the same 24h deploy
 * bearer /deploy already mints, carried in the boot script.
 *
 * Providers:
 *   vast         live marketplace offers (key needed to search)
 *   vultr        public plan catalog, key needed to launch
 *   linode       public type + region catalog, key needed to launch
 *   digitalocean GPU sizes listed with the key
 *
 * Every call goes to a fixed provider host, so nothing here is an SSRF
 * surface. `fetchImpl` is injectable for tests.
 */

export const P2P_PORT = 46337;

export const ONE_CLICK_PROVIDERS = {
    vast: {
        label: "Vast.ai",
        keyUrl: "https://cloud.vast.ai/manage-keys/",
        consoleUrl: (id) => `https://cloud.vast.ai/instances/?id=${encodeURIComponent(id)}`,
        needsKeyToList: true
    },
    vultr: {
        label: "Vultr",
        keyUrl: "https://my.vultr.com/settings/#settingsapi",
        consoleUrl: (id) => `https://my.vultr.com/subs/?id=${encodeURIComponent(id)}`,
        needsKeyToList: false
    },
    linode: {
        label: "Linode / Akamai",
        keyUrl: "https://cloud.linode.com/profile/tokens",
        consoleUrl: (id) => `https://cloud.linode.com/linodes/${encodeURIComponent(id)}`,
        needsKeyToList: false
    },
    digitalocean: {
        label: "DigitalOcean",
        keyUrl: "https://cloud.digitalocean.com/account/api/tokens",
        consoleUrl: (id) => `https://cloud.digitalocean.com/droplets/${encodeURIComponent(id)}`,
        needsKeyToList: true
    }
};

const VULTR_UBUNTU_2404_OS_ID = 2284;
const VAST_IMAGE = "nvidia/cuda:12.4.1-runtime-ubuntu22.04";

export class OneClickError extends Error {
    constructor(message, status = 400) {
        super(message);
        this.status = status;
    }
}

// ---- boot scripts ---------------------------------------------------------

/** curl | sh line for the operator's cloud-init URL (token embedded). */
export function bootOneLiner(cloudInitUrl) {
    return `curl -fsSL '${String(cloudInitUrl).replace(/'/g, "'\\''")}' | sh`;
}

/** #cloud-config user data for VM providers. */
export function cloudConfig(cloudInitUrl) {
    return `#cloud-config\nruncmd:\n  - ${bootOneLiner(cloudInitUrl)}\n`;
}

/** Vast on-start: containers lack curl; no cloud-init. */
export function vastOnstart(cloudInitUrl) {
    return `(command -v curl >/dev/null || (apt-get update && apt-get install -y curl ca-certificates)) && ${bootOneLiner(cloudInitUrl)}`;
}

// ---- http -----------------------------------------------------------------

async function call(fetchImpl, label, url, { method = "GET", headers = {}, body } = {}) {
    let res;
    try {
        res = await fetchImpl(url, {
            method,
            headers: { accept: "application/json", ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(20_000)
        });
    } catch (e) {
        throw new OneClickError(`${label}: could not reach the API (${e?.message ?? e})`, 502);
    }
    const text = await res.text();
    let data;
    try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text.slice(0, 300) }; }
    if (!res.ok) {
        const msg = data?.error?.message ?? data?.errors?.[0]?.reason ?? data?.error ?? data?.msg ?? data?.message ?? `HTTP ${res.status}`;
        // 401/403 from the provider = the operator's key is wrong; say so plainly.
        const status = res.status === 401 || res.status === 403 ? 401 : 502;
        throw new OneClickError(`${label}: ${typeof msg === "string" ? msg : JSON.stringify(msg)}`, status);
    }
    return data;
}

const bearer = (k) => ({ authorization: `Bearer ${k}` });

// ---- offers ---------------------------------------------------------------

/**
 * Offer = { id, label, gpu, gpuCount, vramGb, pricePerHour, regions: string[], detail }
 * Sorted cheapest first.
 */
export async function listOffers({ provider, apiKey, fetchImpl = fetch }) {
    const p = ONE_CLICK_PROVIDERS[provider];
    if (!p) throw new OneClickError(`unknown provider: ${provider}`);
    if (p.needsKeyToList && !apiKey) throw new OneClickError(`${p.label}: API key required to list offers`);

    let offers;
    if (provider === "vast") {
        const q = {
            verified: { eq: true },
            rentable: { eq: true },
            rented: { eq: false },
            num_gpus: { eq: 1 },
            reliability2: { gte: 0.98 },
            direct_port_count: { gte: 1 },
            gpu_ram: { gte: 12_000 },
            order: [["dph_total", "asc"]],
            type: "on-demand",
            limit: 30
        };
        const data = await call(fetchImpl, "Vast.ai",
            `https://console.vast.ai/api/v0/bundles/?q=${encodeURIComponent(JSON.stringify(q))}`,
            { headers: bearer(apiKey) });
        offers = (data?.offers ?? []).map((o) => ({
            id: String(o.id),
            label: `${o.gpu_name} · ${o.geolocation ?? "?"}`,
            gpu: o.gpu_name,
            gpuCount: o.num_gpus ?? 1,
            vramGb: o.gpu_ram ? Math.round(o.gpu_ram / 1024) : null,
            pricePerHour: Number(o.dph_total ?? 0),
            regions: [],
            detail: `${Math.round((o.reliability2 ?? o.reliability ?? 0) * 100)}% reliable, ${Math.round(o.inet_down ?? 0)} Mbps down`
        }));
    } else if (provider === "vultr") {
        const data = await call(fetchImpl, "Vultr", "https://api.vultr.com/v2/plans?type=vcg&per_page=500");
        offers = (data?.plans ?? []).map((pl) => ({
            id: pl.id,
            label: pl.id,
            gpu: pl.gpu_type ?? pl.id,
            gpuCount: 1,
            vramGb: pl.gpu_vram_gb ?? null,
            pricePerHour: Number(pl.hourly_cost ?? (pl.monthly_cost ? pl.monthly_cost / 730 : 0)),
            regions: pl.locations ?? [],
            detail: `${pl.vcpu_count} vCPU, ${Math.round((pl.ram ?? 0) / 1024)} GB RAM`
        }));
    } else if (provider === "linode") {
        const [types, regions, availability] = await Promise.all([
            call(fetchImpl, "Linode", "https://api.linode.com/v4/linode/types?page_size=500"),
            call(fetchImpl, "Linode", "https://api.linode.com/v4/regions?page_size=500"),
            linodeAvailability(fetchImpl)
        ]);
        const gpuRegions = (regions?.data ?? [])
            .filter((r) => (r.capabilities ?? []).includes("GPU Linodes") && (r.capabilities ?? []).includes("Metadata"))
            .map((r) => r.id);
        // Live stock: /regions/availability says which plan is in stock where.
        // If that call failed, fall back to every GPU region (launch will say if it's sold out).
        const inStock = (plan) => availability
            ? gpuRegions.filter((r) => availability.has(`${r}|${plan}`))
            : gpuRegions;
        offers = (types?.data ?? []).filter((t) => t.gpus > 0).map((t) => ({
            id: t.id,
            label: t.label,
            gpu: t.label,
            gpuCount: t.gpus,
            vramGb: null,
            pricePerHour: Number(t.price?.hourly ?? 0),
            regions: inStock(t.id),
            detail: `${t.vcpus} vCPU, ${Math.round(t.memory / 1024)} GB RAM`
        }));
    } else if (provider === "digitalocean") {
        const data = await call(fetchImpl, "DigitalOcean", "https://api.digitalocean.com/v2/sizes?per_page=200", { headers: bearer(apiKey) });
        offers = (data?.sizes ?? []).filter((s) => s.slug?.startsWith("gpu-") && s.available).map((s) => ({
            id: s.slug,
            label: s.slug,
            gpu: s.gpu_info?.model ?? s.slug,
            gpuCount: s.gpu_info?.count ?? 1,
            vramGb: s.gpu_info?.vram?.amount ?? null,
            pricePerHour: Number(s.price_hourly ?? 0),
            regions: s.regions ?? [],
            detail: s.description ?? `${s.vcpus} vCPU, ${Math.round(s.memory / 1024)} GB RAM`
        }));
    }
    return offers.sort((a, b) => a.pricePerHour - b.pricePerHour);
}

// ---- launch ---------------------------------------------------------------

/**
 * Rent the offer and boot it into a node. Returns { provider, instanceId, consoleUrl }.
 */
export async function launch({ provider, apiKey, offerId, region, cloudInitUrl, name, fetchImpl = fetch }) {
    const p = ONE_CLICK_PROVIDERS[provider];
    if (!p) throw new OneClickError(`unknown provider: ${provider}`);
    if (!apiKey) throw new OneClickError(`${p.label}: API key required`);
    if (!offerId || !/^[A-Za-z0-9._-]{1,80}$/.test(String(offerId))) throw new OneClickError("offerId is required");
    if (provider !== "vast" && (!region || !/^[a-z0-9-]{2,32}$/.test(String(region)))) {
        throw new OneClickError(`${p.label}: pick a region`);
    }
    if (!cloudInitUrl) throw new OneClickError("cloudInitUrl missing", 500);
    const label = name || `infernet-${Date.now().toString(36)}`;
    const userData = cloudConfig(cloudInitUrl);
    const b64 = Buffer.from(userData, "utf8").toString("base64");

    let instanceId;
    if (provider === "vast") {
        const data = await call(fetchImpl, "Vast.ai", `https://console.vast.ai/api/v0/asks/${encodeURIComponent(offerId)}/`, {
            method: "PUT",
            headers: bearer(apiKey),
            body: {
                client_id: "me",
                image: VAST_IMAGE,
                // Vast encodes docker options as env keys, same as `vastai --env`.
                env: { [`-p ${P2P_PORT}:${P2P_PORT}`]: "1" },
                disk: 80,
                label,
                onstart: vastOnstart(cloudInitUrl),
                runtype: "ssh_direc ssh_proxy"
            }
        });
        if (data?.success === false) throw new OneClickError(`Vast.ai: ${data?.msg ?? "offer no longer available"}`, 409);
        // Create answers `new_contract`, not `id`.
        instanceId = String(data?.new_contract ?? data?.id ?? "");
    } else if (provider === "vultr") {
        const data = await call(fetchImpl, "Vultr", "https://api.vultr.com/v2/instances", {
            method: "POST",
            headers: bearer(apiKey),
            body: { region, plan: offerId, os_id: VULTR_UBUNTU_2404_OS_ID, label, hostname: label, user_data: b64, tags: ["infernet"] }
        });
        instanceId = String(data?.instance?.id ?? "");
    } else if (provider === "linode") {
        const data = await call(fetchImpl, "Linode", "https://api.linode.com/v4/linode/instances", {
            method: "POST",
            headers: bearer(apiKey),
            body: {
                type: offerId,
                region,
                image: "linode/ubuntu24.04",
                label: label.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 64),
                // Linode requires a root password; nobody needs it (no SSH step).
                root_pass: randomPassword(),
                metadata: { user_data: b64 },
                tags: ["infernet"]
            }
        });
        instanceId = String(data?.id ?? "");
    } else if (provider === "digitalocean") {
        const data = await call(fetchImpl, "DigitalOcean", "https://api.digitalocean.com/v2/droplets", {
            method: "POST",
            headers: bearer(apiKey),
            body: {
                name: label,
                region,
                size: offerId,
                // DO's NVIDIA GPU base image (drivers preinstalled), same as the adapter.
                image: "gpu-h100x1-base",
                ipv6: true,
                monitoring: true,
                tags: ["infernet"],
                user_data: userData
            }
        });
        instanceId = String(data?.droplet?.id ?? "");
    }
    if (!instanceId) throw new OneClickError(`${p.label}: created, but the API returned no instance id; check your console`, 502);
    return { provider, instanceId, consoleUrl: p.consoleUrl(instanceId) };
}

/** Set of "region|plan" pairs Linode reports in stock, or null if unknown. */
async function linodeAvailability(fetchImpl) {
    try {
        const first = await call(fetchImpl, "Linode", "https://api.linode.com/v4/regions/availability?page_size=500&page=1");
        const pages = Math.min(Number(first?.pages ?? 1), 10);
        const rest = await Promise.all(
            Array.from({ length: pages - 1 }, (_, i) =>
                call(fetchImpl, "Linode", `https://api.linode.com/v4/regions/availability?page_size=500&page=${i + 2}`))
        );
        const set = new Set();
        for (const page of [first, ...rest]) {
            for (const row of page?.data ?? []) if (row.available) set.add(`${row.region}|${row.plan}`);
        }
        return set;
    } catch {
        return null;
    }
}

function randomPassword() {
    const bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Buffer.from(bytes).toString("base64").replace(/[^A-Za-z0-9]/g, "") + "Aa1!";
}
