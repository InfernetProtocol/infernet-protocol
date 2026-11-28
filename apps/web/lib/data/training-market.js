import { getSupabaseServerClient } from "@/lib/supabase/server";
import {
    validateTrainingConfig,
    validateModelName,
    validateTrainingUrl,
    looksLikeCode,
    TrainingConfigError
} from "@infernetprotocol/config/training-config";

/**
 * Training market data layer (IPIP-0030).
 *
 * - submitter writes a job + N pending shards
 * - opted-in operators poll listAvailableShards (filters by their VRAM)
 * - operator claimShard atomically flips pending → claimed for that pubkey
 * - operator reportShard writes completed | failed and triggers payout
 */

const ALLOWED_SHARD_STATUS = new Set(["pending", "claimed", "running", "completed", "failed"]);

const TIER_TO_GB = {
    "<8gb": 6, "8-16gb": 12, "16-24gb": 20, "24-48gb": 36, ">=48gb": 64
};

export async function submitTrainingJob({
    submitterId, submitterPubkey,
    name, baseModel, config, datasetBaseUrl, uploadBaseUrl,
    numShards, minVramGb = 16, pricePerShardUsd = 0, expiresAt = null
}) {
    if (!baseModel) throw httpErr(400, "base_model required");
    if (!datasetBaseUrl) throw httpErr(400, "dataset_base_url required");
    if (!Number.isFinite(numShards) || numShards < 1 || numShards > 256) {
        throw httpErr(400, "num_shards must be 1..256");
    }
    // Operators render config into a Python training script and fetch these
    // URLs, so both are untrusted input to someone else's machine. Throws a
    // TrainingConfigError (400, .attack when it carried code).
    baseModel = validateModelName(baseModel);
    config = validateTrainingConfig(config);
    datasetBaseUrl = validateTrainingUrl(datasetBaseUrl, "dataset_base_url");
    if (uploadBaseUrl) uploadBaseUrl = validateTrainingUrl(uploadBaseUrl, "upload_base_url");
    if (name != null && (typeof name !== "string" || name.length > 200)) {
        throw httpErr(400, "name must be a string of at most 200 characters");
    }
    if (looksLikeCode(name)) throw new TrainingConfigError("name: contains code", { field: "name", attack: true });
    const supabase = getSupabaseServerClient();
    const budget = pricePerShardUsd * numShards;

    const { data: job, error: jobErr } = await supabase
        .from("training_jobs")
        .insert({
            submitter_id: submitterId ?? null,
            submitter_pubkey: submitterPubkey ?? null,
            name: name ?? null,
            base_model: baseModel,
            config,
            dataset_base_url: datasetBaseUrl,
            upload_base_url: uploadBaseUrl ?? null,
            num_shards: numShards,
            min_vram_gb: minVramGb,
            price_per_shard_usd: pricePerShardUsd,
            budget_usd: budget,
            status: "open",
            expires_at: expiresAt
        })
        .select()
        .single();
    if (jobErr) throw new Error(jobErr.message);

    const shardRows = [];
    for (let i = 0; i < numShards; i += 1) {
        shardRows.push({
            job_id: job.id,
            shard_index: i,
            shard_url: `${datasetBaseUrl.replace(/\/$/, "")}/shard-${i}.jsonl`,
            upload_url: uploadBaseUrl ? `${uploadBaseUrl.replace(/\/$/, "")}/shard-${i}.adapter.safetensors` : null,
            status: "pending"
        });
    }
    const { data: shards, error: shErr } = await supabase
        .from("training_shards")
        .insert(shardRows)
        .select("id, shard_index, shard_url, status");
    if (shErr) throw new Error(shErr.message);

    return { job, shards };
}

/**
 * Operator-side: list shards this pubkey can pick up.
 * Filters: status='pending' AND job's min_vram_gb ≤ operator's vram.
 */
export async function listAvailableShards({ pubkey, vramGb = 0, limit = 5 }) {
    const supabase = getSupabaseServerClient();
    // Pull pending shards joined with their job so we can filter by min_vram_gb.
    const { data, error } = await supabase
        .from("training_shards")
        .select("id, job_id, shard_index, shard_url, upload_url, training_jobs!inner(id, base_model, config, min_vram_gb, price_per_shard_usd, status)")
        .eq("status", "pending")
        .eq("training_jobs.status", "open")
        .lte("training_jobs.min_vram_gb", Math.max(0, Math.floor(vramGb)))
        .limit(limit * 4); // overscan; we filter further client-side
    if (error) throw new Error(error.message);

    // Skip jobs the same operator has already claimed enough shards from
    // (cheap fairness — keeps one greedy node from grabbing everything).
    const out = [];
    const perJob = new Map();
    for (const row of data ?? []) {
        const job = row.training_jobs;
        const seen = perJob.get(job.id) ?? 0;
        if (seen >= 2) continue;
        perJob.set(job.id, seen + 1);
        out.push({
            shard_id: row.id,
            shard_index: row.shard_index,
            shard_url: row.shard_url,
            upload_url: row.upload_url,
            job_id: job.id,
            base_model: job.base_model,
            config: job.config,
            price_per_shard_usd: job.price_per_shard_usd
        });
        if (out.length >= limit) break;
    }
    return out;
}

/** Atomically flip a pending shard → claimed by this pubkey. */
export async function claimShard({ pubkey, shardId }) {
    const supabase = getSupabaseServerClient();

    // Fetch + verify it's still pending, then flip with a guarded update
    // so two operators racing both can't end up "owning" it.
    const { data: row, error: lookErr } = await supabase
        .from("training_shards")
        .select("id, status, job_id")
        .eq("id", shardId)
        .maybeSingle();
    if (lookErr) throw new Error(lookErr.message);
    if (!row) throw httpErr(404, "shard not found");
    if (row.status !== "pending") throw httpErr(409, `shard is ${row.status}`);

    const { data: updated, error: upErr } = await supabase
        .from("training_shards")
        .update({
            status: "claimed",
            claimed_by_pubkey: pubkey,
            claimed_at: new Date().toISOString()
        })
        .eq("id", shardId)
        .eq("status", "pending")           // race guard
        .select("id, job_id, shard_index, shard_url, upload_url, training_jobs!inner(id, base_model, config)")
        .single();
    if (upErr) throw new Error(upErr.message);
    if (!updated) throw httpErr(409, "shard was claimed by another node");

    // Bump job to filling on first claim.
    await supabase
        .from("training_jobs")
        .update({ status: "filling" })
        .eq("id", row.job_id)
        .eq("status", "open");

    return {
        shard_id: updated.id,
        shard_index: updated.shard_index,
        shard_url: updated.shard_url,
        upload_url: updated.upload_url,
        job_id: updated.training_jobs.id,
        base_model: updated.training_jobs.base_model,
        config: updated.training_jobs.config
    };
}

/** Operator reports completion / failure of a claimed shard. */
export async function reportShard({ pubkey, shardId, status, adapterUrl = null, metrics = null, errorMessage = null }) {
    if (!ALLOWED_SHARD_STATUS.has(status)) {
        throw httpErr(400, `status must be one of ${[...ALLOWED_SHARD_STATUS].join(",")}`);
    }
    const supabase = getSupabaseServerClient();
    const { data: row, error: lookErr } = await supabase
        .from("training_shards")
        .select("id, claimed_by_pubkey, status, job_id")
        .eq("id", shardId)
        .maybeSingle();
    if (lookErr) throw new Error(lookErr.message);
    if (!row) throw httpErr(404, "shard not found");
    if (row.claimed_by_pubkey !== pubkey) throw httpErr(403, "shard not claimed by this pubkey");

    const patch = {
        status,
        completed_at: new Date().toISOString(),
        ...(adapterUrl ? { adapter_url: adapterUrl } : {}),
        ...(metrics ? { metrics } : {}),
        ...(errorMessage ? { error: errorMessage } : {})
    };
    const { error: upErr } = await supabase
        .from("training_shards")
        .update(patch)
        .eq("id", shardId);
    if (upErr) throw new Error(upErr.message);

    // If every shard in the job is in a terminal state, flip the job too.
    const { data: peerStats } = await supabase
        .from("training_shards")
        .select("status")
        .eq("job_id", row.job_id);
    const allDone = (peerStats ?? []).every((s) => s.status === "completed" || s.status === "failed");
    if (allDone) {
        await supabase
            .from("training_jobs")
            .update({ status: "completed", completed_at: new Date().toISOString() })
            .eq("id", row.job_id);
    }

    return { id: shardId, status };
}

/** Submitter-facing: read job + per-shard status. */
export async function getTrainingJob({ jobId }) {
    const supabase = getSupabaseServerClient();
    const [{ data: job }, { data: shards }] = await Promise.all([
        supabase.from("training_jobs").select("*").eq("id", jobId).maybeSingle(),
        supabase.from("training_shards").select("*").eq("job_id", jobId).order("shard_index", { ascending: true })
    ]);
    if (!job) throw httpErr(404, "job not found");
    return { job, shards: shards ?? [] };
}

function httpErr(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}

export { TIER_TO_GB };
