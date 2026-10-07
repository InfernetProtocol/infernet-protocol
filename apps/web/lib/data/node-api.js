import "server-only";

import { getSupabaseServerClient } from "@/lib/supabase/server";
import { tableForRole } from "@/lib/auth/verify-signed-request";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";

const MAX_SPECS_GPUS = 16;

/**
 * Scrub an incoming specs object to the coarse, privacy-preserving shape we
 * accept. Nodes used to send hostname/platform/arch/cpu/ram — we drop all of
 * that and only persist a redacted GPU summary. Vendor + VRAM tier is enough
 * to route jobs; anything finer is deanonymization bait.
 */
export function sanitizeSpecs(input) {
    if (!input || typeof input !== "object") return null;
    const gpus = Array.isArray(input.gpus) ? input.gpus.slice(0, MAX_SPECS_GPUS) : [];

    // served_models — Ollama / vLLM model names the daemon advertises
    // for single-node inference. Already widely consumed; mirror in
    // case some daemons send it through register/heartbeat.
    const servedModels = Array.isArray(input.served_models)
        ? input.served_models
            .filter((m) => typeof m === "string" && m.length > 0 && m.length <= 200)
            .slice(0, 50)
        : [];

    // IPIP-0027 §7: providers advertise E2E (NIP-44) capability so the
    // control plane can expose it via /api/chat/provider and the UI
    // can show a lock indicator. Both fields are public booleans /
    // version strings — no privacy concern.
    const e2eCapable = input.e2e_capable === true;
    const e2eVersion = typeof input.e2e_version === "string"
        && input.e2e_version.length > 0
        && input.e2e_version.length <= 32
            ? input.e2e_version
            : null;

    // CLI version — semver-ish, public. Surfaced on /dashboard, /status,
    // and the public /nodes/[id] page so operators can see which fleet
    // members are out of date. Without this whitelist the daemon's
    // version would only appear after the first heartbeat (~5 min after
    // register) because heartbeat passes specs through unsanitized.
    const cliVersion = typeof input.cli_version === "string"
        && /^[0-9A-Za-z._+-]{1,32}$/.test(input.cli_version)
            ? input.cli_version
            : null;

    // IPIP-0033: federated-inference advertisements. Daemons that
    // run `infernet inference serve --backend rpc` populate `rpc`;
    // daemons that run `infernet inference primary` populate
    // `rpc_primary`. The control-plane proxy filters on these to
    // assemble --rpc peer lists.
    const rpc = sanitizeRpcSlot(input.rpc);
    const rpcPrimary = sanitizeRpcPrimarySlot(input.rpc_primary);

    return {
        gpus: gpus.map(sanitizeGpu).filter(Boolean),
        gpu_count: gpus.length,
        served_models: servedModels,
        e2e_capable: e2eCapable,
        e2e_version: e2eVersion,
        cli_version: cliVersion,
        ...(rpc ? { rpc } : {}),
        ...(rpcPrimary ? { rpc_primary: rpcPrimary } : {})
    };
}

function sanitizeRpcSlot(input) {
    if (!input || typeof input !== 'object') return null;
    const models = Array.isArray(input.models)
        ? input.models
            .filter((m) => typeof m === 'string' && m.length > 0 && m.length <= 200)
            .slice(0, 50)
        : [];
    if (models.length === 0) return null;
    return {
        engine: typeof input.engine === 'string' ? input.engine.slice(0, 32) : 'llama.cpp',
        version: typeof input.version === 'string'
            && /^[0-9A-Za-z._+-]{1,32}$/.test(input.version)
            ? input.version
            : null,
        models,
        host: typeof input.host === 'string' && input.host.length <= 253
            ? input.host
            : null,
        port: Number.isFinite(input.port) && input.port > 0 && input.port < 65536
            ? Number(input.port)
            : null,
        vram_gb: Number.isFinite(input.vram_gb) && input.vram_gb >= 0 ? Number(input.vram_gb) : null,
        ram_gb: Number.isFinite(input.ram_gb) && input.ram_gb >= 0 ? Number(input.ram_gb) : null,
        max_concurrent: Number.isFinite(input.max_concurrent) && input.max_concurrent > 0
            ? Math.min(Math.floor(input.max_concurrent), 64)
            : 1
    };
}

function sanitizeRpcPrimarySlot(input) {
    if (!input || typeof input !== 'object') return null;
    const models = Array.isArray(input.models)
        ? input.models
            .filter((m) => typeof m === 'string' && m.length > 0 && m.length <= 200)
            .slice(0, 50)
        : [];
    if (models.length === 0) return null;
    return {
        engine: typeof input.engine === 'string' ? input.engine.slice(0, 32) : 'llama.cpp',
        version: typeof input.version === 'string'
            && /^[0-9A-Za-z._+-]{1,32}$/.test(input.version)
            ? input.version
            : null,
        models
    };
}

const ALLOWED_VRAM_TIERS = new Set([
    "<8gb", "8-16gb", "16-24gb", "24-48gb", ">=48gb", "unknown"
]);

function sanitizeGpu(gpu) {
    if (!gpu || typeof gpu !== "object") return null;
    const vendor = typeof gpu.vendor === "string" ? gpu.vendor.toLowerCase() : null;
    // The CLI ships an already-classified `vram_tier` string. Earlier
    // versions of this sanitizer ignored it and re-derived from
    // `gpu.vram_mb` — but the CLI never sends `vram_mb` (the whole point
    // of pre-classifying client-side is to keep exact VRAM off the wire),
    // so every register call landed with vram_tier="unknown". Trust the
    // client tier when it matches the allowed enum, fall back to deriving
    // from vram_mb if provided, else "unknown".
    const clientTier = typeof gpu.vram_tier === "string" ? gpu.vram_tier.toLowerCase() : null;
    const vramMb = Number.isFinite(gpu.vram_mb) ? Number(gpu.vram_mb) : null;
    const tier = clientTier && ALLOWED_VRAM_TIERS.has(clientTier)
        ? clientTier
        : vramTier(vramMb);
    return {
        vendor: vendor && ["nvidia", "amd", "apple", "intel"].includes(vendor) ? vendor : "unknown",
        vram_tier: tier,
        model: typeof gpu.model === "string" ? gpu.model.slice(0, 64) : null
    };
}

function vramTier(vramMb) {
    if (!Number.isFinite(vramMb) || vramMb <= 0) return "unknown";
    if (vramMb < 8 * 1024) return "<8gb";
    if (vramMb < 16 * 1024) return "8-16gb";
    if (vramMb < 24 * 1024) return "16-24gb";
    if (vramMb < 48 * 1024) return "24-48gb";
    return ">=48gb";
}

/**
 * Upsert a provider/aggregator/client row keyed on node_id. The caller has
 * already verified the request signature and matched pubkey→resource.
 */
export async function registerNode({ role, pubkey, body }) {
    const table = tableForRole(role);
    if (!table) throw withStatus(`invalid role: ${role}`, 400);

    const nodeId = body.node_id;
    if (!nodeId || typeof nodeId !== "string") {
        throw withStatus("node_id is required", 400);
    }

    const supabase = getSupabaseServerClient();
    const { data: existing } = await supabase
        .from(table)
        .select("id, public_key")
        .eq("node_id", nodeId)
        .maybeSingle();

    if (existing && existing.public_key && existing.public_key !== pubkey) {
        throw withStatus("node_id is registered to a different pubkey", 403);
    }

    const payload = {
        node_id: nodeId,
        public_key: pubkey,
        name: typeof body.name === "string" ? body.name : nodeId,
        status: body.status === "offline" ? "offline" : "available",
        last_seen: new Date().toISOString()
    };

    if (typeof body.address === "string") payload.address = body.address;
    if (Number.isFinite(body.port)) payload.port = Number(body.port);

    if (role === "provider") {
        if (typeof body.gpu_model === "string") payload.gpu_model = body.gpu_model.slice(0, 64);
        if (Number.isFinite(body.price)) payload.price = Number(body.price);
        const specs = sanitizeSpecs(body.specs);
        if (specs) payload.specs = specs;
    }

    if (role === "client") {
        delete payload.status;
    }

    const { data, error } = await supabase
        .from(table)
        .upsert(payload, { onConflict: "node_id" })
        .select("id, node_id")
        .single();

    if (error) throw withStatus(error.message, 500);
    return { id: data.id, node_id: data.node_id };
}

/**
 * Update last_seen + optional address/port/status. Returns the new row id.
 */
export async function heartbeatNode({ role, pubkey, body }) {
    const table = tableForRole(role);
    if (!table) throw withStatus(`invalid role: ${role}`, 400);

    const supabase = getSupabaseServerClient();
    const { data: existing, error: lookupErr } = await supabase
        .from(table)
        .select("id, public_key")
        .eq("public_key", pubkey)
        .maybeSingle();

    if (lookupErr) throw withStatus(lookupErr.message, 500);
    if (!existing) throw withStatus("no row for this pubkey — call /register first", 404);

    const patch = { last_seen: new Date().toISOString() };
    if (role !== "client") {
        patch.status = body.status === "offline" ? "offline" : "available";
    }
    if (typeof body.address === "string") patch.address = body.address;
    if (Number.isFinite(body.port)) patch.port = Number(body.port);
    // IPIP-0008: heartbeats may carry a fresh `specs` snapshot so the
    // control plane reflects current CPU / GPU / served_models without
    // requiring a separate `infernet register`. The daemon caches and
    // refreshes this every ~5 min; we accept whatever shape arrives —
    // sanitization already happened CLI-side via gatherCoarseSpecs.
    if (body.specs && typeof body.specs === "object" && !Array.isArray(body.specs)) {
        patch.specs = body.specs;
    }

    const { error } = await supabase.from(table).update(patch).eq("id", existing.id);
    if (error) throw withStatus(error.message, 500);
    return { id: existing.id };
}

export async function pollJobsForNode({ pubkey, limit = 5 }) {
    const supabase = getSupabaseServerClient();
    const { data: provider, error: provErr } = await supabase
        .from("providers")
        .select("id")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (provErr) throw withStatus(provErr.message, 500);
    if (!provider) throw withStatus("no provider row for this pubkey", 404);

    const { data, error } = await supabase
        .from("jobs")
        .select("id, title, type, status, payment_offer, payment_coin, model_name, input_spec, client_pubkey, created_at")
        .eq("provider_id", provider.id)
        .in("status", ["assigned"])
        .order("created_at", { ascending: true })
        .limit(Math.min(Math.max(Number(limit) || 5, 1), 25));

    if (error) throw withStatus(error.message, 500);
    const jobs = (data ?? []).map((j) => ({ ...j, input_spec: decryptJSON(j.input_spec) }));
    return { provider_id: provider.id, jobs };
}

// Statuses a job can be completed (or failed) from by its node.
export const COMPLETABLE_JOB_STATUSES = ["pending", "assigned", "running"];

export async function completeJobForNode({ pubkey, jobId, body }) {
    if (!jobId) throw withStatus("jobId is required", 400);
    const supabase = getSupabaseServerClient();

    const { data: provider, error: provErr } = await supabase
        .from("providers")
        .select("id")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (provErr) throw withStatus(provErr.message, 500);
    if (!provider) throw withStatus("no provider row for this pubkey", 404);

    const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .select("id, provider_id, payment_offer, payment_coin, status")
        .eq("id", jobId)
        .maybeSingle();
    if (jobErr) throw withStatus(jobErr.message, 500);
    if (!job) throw withStatus("job not found", 404);
    if (job.provider_id !== provider.id) throw withStatus("job not assigned to this provider", 403);

    const completedAt = new Date().toISOString();
    const failed = body.status === "failed";
    const patch = {
        status: failed ? "failed" : "completed",
        updated_at: completedAt,
        completed_at: completedAt
    };
    if (!failed && body.result !== undefined) patch.result = encryptJSON(body.result);
    if (failed && typeof body.error === "string") patch.error = body.error.slice(0, 1024);

    // Only a job still in flight can be completed. Daemons retry this call
    // when the response is slow or lost, and every retry used to re-mark the
    // job and queue another CPR receipt (and, on paid jobs, another payout
    // row): one job in August has 353 receipts, and 3,353 receipts were queued
    // for 695 jobs. A repeat now answers with the status already recorded and
    // writes nothing else.
    const { data: marked, error: markErr } = await supabase
        .from("jobs")
        .update(patch)
        .eq("id", job.id)
        .in("status", COMPLETABLE_JOB_STATUSES)
        .select("id");
    if (markErr) throw withStatus(markErr.message, 500);
    if (!marked || marked.length === 0) {
        return { id: job.id, status: job.status, noop: true };
    }

    if (!failed) {
        const amount = Number.parseFloat(job.payment_offer ?? 0) || 0;
        if (amount > 0) {
            const coin = job.payment_coin ?? "USDC";
            const { error: payErr } = await supabase.from("payment_transactions").insert({
                direction: "outbound",
                job_id: job.id,
                provider_id: provider.id,
                coin,
                amount,
                amount_usd: amount,
                address: "pending-payout",
                status: "pending",
                metadata: { via: "node-api" }
            });
            if (payErr) {
                // Non-fatal — payment accounting is follow-up work.
                console.warn(`payment_transactions insert failed: ${payErr.message}`);
            }
        }
    }

    // IPIP-0007 phase 2: emit a CPR Receipt for this job. Non-blocking
    // by design — CPR being unreachable MUST NOT fail the completion
    // flow. The queue captures everything; a worker (phase 3) drains
    // any rows that didn't go through immediately.
    try {
        const { buildReceiptBody } = await import("@/lib/cpr/receipts");
        const { enqueueAndFlush } = await import("@/lib/cpr/queue");
        const receipt = buildReceiptBody({
            job: {
                id: job.id,
                type: job.type ?? "inference",
                status: patch.status,
                payment_offer: job.payment_offer,
                payment_coin: job.payment_coin,
                payment_tx_hash: job.payment_tx_hash
            },
            provider: { public_key: pubkey, id: provider.id }
        });
        // Fire-and-await but suppress all errors — worst case the row
        // ends up `pending` and the worker handles it.
        await enqueueAndFlush({ receipt, jobId: job.id }).catch((err) => {
            console.warn(`CPR enqueueAndFlush failed: ${err?.message ?? err}`);
        });
    } catch (err) {
        console.warn(`CPR receipt emission failed: ${err?.message ?? err}`);
    }

    return { id: job.id, status: patch.status };
}

export async function removeNode({ role, pubkey }) {
    const table = tableForRole(role);
    if (!table) throw withStatus(`invalid role: ${role}`, 400);

    const supabase = getSupabaseServerClient();
    const { data: existing, error: lookupErr } = await supabase
        .from(table)
        .select("id, public_key")
        .eq("public_key", pubkey)
        .maybeSingle();

    if (lookupErr) throw withStatus(lookupErr.message, 500);
    if (!existing) return { deleted: false };

    const { error } = await supabase.from(table).delete().eq("id", existing.id);
    if (error) throw withStatus(error.message, 500);
    return { deleted: true, id: existing.id };
}

export async function getSelfRow({ role, pubkey }) {
    const table = tableForRole(role);
    if (!table) throw withStatus(`invalid role: ${role}`, 400);

    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from(table)
        .select("*")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (error) throw withStatus(error.message, 500);
    return { row: data ?? null };
}

const EVENT_BATCH_MAX = 200;
const EVENT_TYPES = new Set(["meta", "token", "done", "error"]);

export async function emitJobEvents({ pubkey, jobId, events }) {
    if (!jobId) throw withStatus("jobId is required", 400);
    if (!Array.isArray(events) || events.length === 0) {
        throw withStatus("events must be a non-empty array", 400);
    }
    if (events.length > EVENT_BATCH_MAX) {
        throw withStatus(`too many events (max ${EVENT_BATCH_MAX})`, 400);
    }

    const supabase = getSupabaseServerClient();
    const { data: provider, error: provErr } = await supabase
        .from("providers")
        .select("id")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (provErr) throw withStatus(provErr.message, 500);
    if (!provider) throw withStatus("no provider row for this pubkey", 404);

    const { data: job, error: jobErr } = await supabase
        .from("jobs")
        .select("id, provider_id")
        .eq("id", jobId)
        .maybeSingle();
    if (jobErr) throw withStatus(jobErr.message, 500);
    if (!job) throw withStatus("job not found", 404);
    if (job.provider_id !== provider.id) {
        throw withStatus("job not assigned to this provider", 403);
    }

    const rows = events.map((e) => {
        if (!e || typeof e !== "object" || !EVENT_TYPES.has(e.event_type)) {
            throw withStatus(`invalid event_type (must be one of ${[...EVENT_TYPES].join(", ")})`, 400);
        }
        return {
            job_id: jobId,
            event_type: e.event_type,
            data: encryptJSON(e.data ?? {})
        };
    });

    const { error } = await supabase.from("job_events").insert(rows);
    if (error) throw withStatus(error.message, 500);
    return { inserted: rows.length };
}

export async function listPaymentsForNode({ role, pubkey, limit = 20 }) {
    const table = tableForRole(role);
    if (!table) throw withStatus(`invalid role: ${role}`, 400);
    if (role === "aggregator") {
        return { rows: [] };
    }

    const supabase = getSupabaseServerClient();
    const { data: row, error: rowErr } = await supabase
        .from(table)
        .select("id")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (rowErr) throw withStatus(rowErr.message, 500);
    if (!row) throw withStatus("no row for this pubkey", 404);

    const safeLimit = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const column = role === "provider" ? "provider_id" : "client_id";
    const { data, error } = await supabase
        .from("payment_transactions")
        .select("*")
        .eq(column, row.id)
        .order("created_at", { ascending: false })
        .limit(safeLimit);
    if (error) throw withStatus(error.message, 500);
    return { rows: data ?? [] };
}

export async function listPayoutsForNode({ pubkey }) {
    const supabase = getSupabaseServerClient();
    const { data: provider, error: provErr } = await supabase
        .from("providers")
        .select("id")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (provErr) throw withStatus(provErr.message, 500);
    if (!provider) throw withStatus("no provider row for this pubkey", 404);

    const { data, error } = await supabase
        .from("provider_payouts")
        .select("*")
        .eq("provider_id", provider.id)
        .order("is_default", { ascending: false })
        .order("created_at", { ascending: true });
    if (error) throw withStatus(error.message, 500);
    return { rows: data ?? [] };
}

export async function setPayoutForNode({ pubkey, coin, network, address }) {
    if (!coin || !network || !address) {
        throw withStatus("coin, network, and address are required", 400);
    }
    const supabase = getSupabaseServerClient();
    const { data: provider, error: provErr } = await supabase
        .from("providers")
        .select("id")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (provErr) throw withStatus(provErr.message, 500);
    if (!provider) throw withStatus("no provider row for this pubkey", 404);

    const { error: demoteErr } = await supabase
        .from("provider_payouts")
        .update({ is_default: false })
        .eq("provider_id", provider.id)
        .eq("is_default", true);
    if (demoteErr) throw withStatus(demoteErr.message, 500);

    const { data, error } = await supabase
        .from("provider_payouts")
        .upsert(
            {
                provider_id: provider.id,
                coin,
                network,
                address,
                is_default: true
            },
            { onConflict: "provider_id,coin,address" }
        )
        .select()
        .single();
    if (error) throw withStatus(error.message, 500);
    return { row: data };
}

function withStatus(message, status) {
    const err = new Error(message);
    err.status = status;
    return err;
}
