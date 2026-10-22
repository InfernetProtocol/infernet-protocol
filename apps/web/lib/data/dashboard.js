import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { decryptJSON } from "@/lib/encrypt";

/**
 * User-scoped reads for /dashboard.
 *
 * Join path:
 *   auth.users.id
 *     → pubkey_links.user_id (role: provider | client | aggregator)
 *       → providers.public_key  (or clients.public_key)
 *         → payment_transactions.provider_id / client_id
 *
 * The dashboard is rendered server-side from the service-role client,
 * so all RLS bypasses are intentional. We re-check user_id at every
 * step rather than trusting the linked-pubkey set blindly.
 */

function fmtUsd(value) {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return "$0.00";
    return n.toLocaleString("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    });
}

export async function getUserPubkeys(userId) {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("pubkey_links")
        .select("pubkey, role, label, created_at")
        .eq("user_id", userId)
        .order("created_at", { ascending: false });
    if (error) throw new Error(error.message);
    return data ?? [];
}

export async function getUserProviders(userId) {
    const links = await getUserPubkeys(userId);
    const keys = links.filter((l) => l.role === "provider").map((l) => l.pubkey);
    if (keys.length === 0) return [];
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("providers")
        .select(
            "id, name, status, gpu_model, price, reputation, node_id, public_key, address, port, specs, last_seen, created_at"
        )
        .in("public_key", keys)
        .order("last_seen", { ascending: false, nullsFirst: false });
    if (error) throw new Error(error.message);
    return data ?? [];
}

export async function getUserClients(userId) {
    const links = await getUserPubkeys(userId);
    const keys = links.filter((l) => l.role === "client").map((l) => l.pubkey);
    if (keys.length === 0) return [];
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("clients")
        .select("id, name, status, budget_usd, public_key, last_seen, created_at")
        .in("public_key", keys);
    if (error) throw new Error(error.message);
    return data ?? [];
}

/**
 * Sum payment_transactions in USD, optionally restricted to a window.
 * `direction='inbound'` joined to my providers = earnings.
 * `direction='outbound'` joined to my clients = spend.
 */
async function sumPaymentsUsd({ ids, direction, sinceDays }) {
    if (!ids?.length) return { total: 0, count: 0 };
    const supabase = getSupabaseServerClient();
    const column = direction === "inbound" ? "provider_id" : "client_id";
    let q = supabase
        .from("payment_transactions")
        .select("amount_usd, status, created_at, confirmed_at", { count: "exact" })
        .eq("direction", direction)
        .in(column, ids)
        .eq("status", "confirmed");
    if (sinceDays) {
        const since = new Date(Date.now() - sinceDays * 86400 * 1000).toISOString();
        q = q.gte("confirmed_at", since);
    }
    const { data, count, error } = await q;
    if (error) throw new Error(error.message);
    const total = (data ?? []).reduce((acc, row) => acc + Number(row.amount_usd ?? 0), 0);
    return { total, count: count ?? data?.length ?? 0 };
}

/**
 * Provider earnings from the provider_earnings ledger (every completed job
 * credits its node; free jobs carry the house subsidy, pending approval).
 */
export async function getEarningsSummary(userId) {
    const providers = await getUserProviders(userId);
    const { getEarningsForProviders } = await import("@/lib/data/earnings");
    const out = await getEarningsForProviders(providers.map((p) => p.id), { recent: 0 });
    return {
        ...out.balance,
        per_provider: out.per_provider,
        payouts: out.payouts,
        config: out.config
    };
}

export async function getSpendSummary(userId) {
    const clients = await getUserClients(userId);
    const ids = clients.map((c) => c.id);
    const [allTime, last30d] = await Promise.all([
        sumPaymentsUsd({ ids, direction: "outbound" }),
        sumPaymentsUsd({ ids, direction: "outbound", sinceDays: 30 })
    ]);
    return {
        all_time_usd: fmtUsd(allTime.total),
        last_30d_usd: fmtUsd(last30d.total),
        confirmed_payments: allTime.count
    };
}

/**
 * Hardware in use across the user's providers — pulled from
 * providers.specs (jsonb).
 *
 * Schema we send today (apps/cli/commands/register.js → gatherCoarseSpecs):
 *   { cpu: { vendor, arch, cores, groups, ram_gb }, gpus: [{vendor, vram_tier, model}], gpu_count, interconnects: {...} }
 *
 * We also accept a couple of older / alternate shapes so dashboards
 * built against a previous register payload don't go blank: legacy
 * { specs.gpu_model, specs.cpu_model } and the providers.gpu_model
 * column directly.
 */
export function summarizeHardware(providers) {
    const gpus = new Map(); // label → count
    const cpus = new Map(); // label → cores
    for (const p of providers) {
        const specs = p.specs && typeof p.specs === "object" ? p.specs : {};

        // GPUs
        if (Array.isArray(specs.gpus) && specs.gpus.length > 0) {
            for (const g of specs.gpus) {
                const model = String(g.model ?? g.vendor ?? "GPU").trim() || "GPU";
                const count = Number(g.count ?? 1) || 1;
                gpus.set(model, (gpus.get(model) ?? 0) + count);
            }
        } else if (specs.gpu_model) {
            const model = String(specs.gpu_model).trim();
            const count = Number(specs.gpu_count ?? 1) || 1;
            gpus.set(model, (gpus.get(model) ?? 0) + count);
        } else if (p.gpu_model) {
            const model = String(p.gpu_model).trim();
            gpus.set(model, (gpus.get(model) ?? 0) + 1);
        }

        // CPUs — current shape: specs.cpu = { vendor, arch, cores, groups, ram_gb }
        if (specs.cpu && typeof specs.cpu === "object") {
            const c = specs.cpu;
            const label = formatCpuLabel(c);
            const cores = Number(c.cores ?? 0) || 0;
            cpus.set(label, (cpus.get(label) ?? 0) + cores);
        } else if (specs.cpu_model) {
            const label = String(specs.cpu_model).trim();
            const cores = Number(specs.cpu_cores ?? 0) || 0;
            cpus.set(label, (cpus.get(label) ?? 0) + cores);
        }
    }
    return {
        gpus: [...gpus.entries()].map(([model, count]) => ({ model, count })),
        cpus: [...cpus.entries()].map(([model, cores]) => ({ model, cores }))
    };
}

function formatCpuLabel(c) {
    const vendor = c.vendor ? String(c.vendor) : null;
    const arch = c.arch ? String(c.arch) : null;
    const ram = Number.isFinite(c.ram_gb) && c.ram_gb > 0 ? `${c.ram_gb} GB RAM` : null;
    const parts = [];
    if (vendor) parts.push(vendor);
    if (arch) parts.push(arch);
    if (ram) parts.push(ram);
    return parts.length ? parts.join(" · ") : "CPU";
}

/**
 * Aggregate fabric capability across the user's providers.
 *   - any_nvlink: at least one provider has NVLink between GPUs
 *   - any_infiniband: at least one IB-active provider
 *   - rdma_capable_providers: count of providers advertising RDMA
 */
export function summarizeInterconnects(providers) {
    let any_nvlink = false;
    let any_xgmi = false;
    let any_infiniband = false;
    let any_efa = false;
    let rdma_capable_providers = 0;
    const nvlink_topologies = new Set();
    const xgmi_topologies = new Set();
    for (const p of providers) {
        const ic = (p.specs && typeof p.specs === "object" && p.specs.interconnects) || {};
        if (ic.nvlink?.available) {
            any_nvlink = true;
            if (ic.nvlink.topology) nvlink_topologies.add(ic.nvlink.topology);
        }
        if (ic.xgmi?.available) {
            any_xgmi = true;
            if (ic.xgmi.topology) xgmi_topologies.add(ic.xgmi.topology);
        }
        if (ic.infiniband?.available) any_infiniband = true;
        if (ic.efa?.available) any_efa = true;
        if (ic.rdma_capable) rdma_capable_providers += 1;
    }
    return {
        any_nvlink,
        any_xgmi,
        any_infiniband,
        any_efa,
        rdma_capable_providers,
        nvlink_topologies: [...nvlink_topologies],
        xgmi_topologies: [...xgmi_topologies]
    };
}

export async function getUserModelsServed(userId) {
    const providers = await getUserProviders(userId);
    const models = new Set();
    for (const p of providers) {
        const specs = p.specs && typeof p.specs === "object" ? p.specs : {};
        // Daemon heartbeat writes specs.served_models (canonical field
        // matching /status + /chat routing). The previous specs.models
        // path was a stale name from an earlier schema and always
        // returned empty — that's why /dashboard showed 0 models while
        // /status showed correctly. Fallback kept for backwards-compat
        // with any old rows still on disk.
        const served = Array.isArray(specs.served_models)
            ? specs.served_models
            : Array.isArray(specs.models)
                ? specs.models
                : [];
        for (const m of served) {
            if (typeof m === "string") models.add(m);
            else if (m?.name) models.add(String(m.name));
        }
    }
    return [...models];
}

/**
 * Recent jobs by client_name match against the user's client labels.
 * Approximate — the jobs table doesn't have a client_id FK yet, so
 * this is a best-effort match. Exact scoping arrives once jobs gets
 * a client_id column (TODO: schema migration).
 */
export async function getRecentJobs(userId, { limit = 8 } = {}) {
    const clients = await getUserClients(userId);
    const names = clients.map((c) => c.name).filter(Boolean);
    if (names.length === 0) return [];
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("jobs")
        .select("id, title, status, payment_offer, model_name, client_name, created_at, input_spec")
        .in("client_name", names)
        .order("created_at", { ascending: false })
        .limit(limit);
    if (error) throw new Error(error.message);
    return (data ?? []).map(withPrompt);
}

/**
 * Recent jobs PROCESSED by the user's owned providers — operator-
 * side view. Joins jobs.provider_id back to the providers the user
 * owns (via pubkey_links), so an operator running a node sees the
 * actual work that node handled.
 *
 * Includes the provider's display name + node_id so the operator
 * can tell which of their nodes processed each job (matters when
 * they run multiple).
 */
export async function getRecentJobsProcessed(userId, { limit = 8 } = {}) {
    const providers = await getUserProviders(userId);
    const ids = providers.map((p) => p.id).filter(Boolean);
    if (ids.length === 0) return [];

    const nameById = new Map(providers.map((p) => [p.id, {
        name: p.name ?? null,
        node_id: p.node_id ?? null
    }]));

    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("jobs")
        .select("id, title, status, payment_offer, model_name, provider_id, created_at, completed_at, input_spec")
        .in("provider_id", ids)
        .order("created_at", { ascending: false })
        .limit(limit);
    if (error) throw new Error(error.message);
    const { getEarningsByJob } = await import("@/lib/data/earnings");
    const earned = await getEarningsByJob((data ?? []).map((j) => j.id)).catch(() => new Map());
    return (data ?? []).map((j) => {
        const meta = nameById.get(j.provider_id) ?? {};
        const e = earned.get(j.id);
        return {
            ...withPrompt(j),
            provider_name: meta.name,
            provider_node_id: meta.node_id,
            earned_usd: e ? e.amount_usd : null,
            earned_status: e?.status ?? null,
            output_tokens: e?.output_tokens ?? null
        };
    });
}

function withPrompt(j) {
    try {
        const spec = decryptJSON(j.input_spec);
        const messages = Array.isArray(spec?.messages) ? spec.messages : [];
        const first = messages.find((m) => m?.role === "user" && typeof m.content === "string");
        return { ...j, prompt: first?.content ?? null };
    } catch {
        return { ...j, prompt: null };
    }
}
