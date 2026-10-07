import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isNimConfigured, nimVirtualProvider } from "@infernetprotocol/nim-adapter";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";

/**
 * Pick a P2P provider to serve a chat job.
 *
 * Filtering:
 *   - status = 'available'
 *   - last_seen within the last 2 minutes (liveness)
 *   - if a model is requested, the provider's specs.served_models must
 *     include it (so we don't route to a node that can't serve the
 *     model — that 500s mid-stream and rots reputation)
 *
 * Selection from the filtered set:
 *   - reputation-weighted random pick. Higher-reputation providers get
 *     proportionally more traffic, but no single node monopolizes the
 *     queue when several qualify. Reputation defaults to 50 so brand-
 *     new providers still get tried.
 *
 * Returns null if no provider qualifies. Callers decide whether to use
 * the NIM fallback (see createChatJob).
 */
// IPIP-0026 §2.1 — trust tier ladder. Higher index = more trusted.
// `private` providers are excluded from open-market routing and only
// accept jobs addressed by provider_id with the right allowlist.
const TRUST_TIER_RANK = { public: 0, verified: 1, trusted: 2, private: 3 };

export function meetsTrustTier(provider, minTier) {
  if (!minTier || minTier === "public") return true;
  const have = TRUST_TIER_RANK[provider?.trust_tier ?? "public"] ?? 0;
  const need = TRUST_TIER_RANK[minTier] ?? 0;
  return have >= need;
}

export async function pickChatProvider({ modelName, minTrustTier } = {}) {
  const supabase = getSupabaseServerClient();
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("providers")
    .select("id, node_id, name, reputation, price, gpu_model, specs, public_key, trust_tier")
    .eq("status", "available")
    .gte("last_seen", twoMinAgo);

  if (error) {
    // Schema may not yet have trust_tier (older deployments). Retry without it.
    if (/trust_tier/.test(error.message ?? "")) {
      const fallback = await supabase
        .from("providers")
        .select("id, node_id, name, reputation, price, gpu_model, specs, public_key")
        .eq("status", "available")
        .gte("last_seen", twoMinAgo);
      if (fallback.error) throw fallback.error;
      return finishPick(fallback.data ?? [], { modelName, minTrustTier });
    }
    throw error;
  }

  return finishPick(data ?? [], { modelName, minTrustTier });
}

function finishPick(rows, { modelName, minTrustTier }) {
  let candidates = rows;

  if (typeof modelName === "string" && modelName) {
    candidates = candidates.filter((p) => {
      const served = Array.isArray(p?.specs?.served_models) ? p.specs.served_models : [];
      return served.includes(modelName);
    });
  }

  // IPIP-0026 §2.2 — clients can require a minimum trust tier. Default
  // routing also drops `private` providers, which only accept jobs sent
  // by provider_id with an explicit allowlist.
  candidates = candidates.filter((p) => (p.trust_tier ?? "public") !== "private");
  if (minTrustTier) {
    candidates = candidates.filter((p) => meetsTrustTier(p, minTrustTier));
  }

  // Hard filter: drop saturated nodes. A node with active_jobs at or
  // above its concurrency cap shouldn't get more work — it's currently
  // unable to serve. Default cap = 4 if the node didn't advertise one.
  candidates = candidates.filter(notSaturated);

  if (candidates.length === 0) return null;
  return reputationWeightedPick(candidates);
}

const DEFAULT_CONCURRENCY_CAP = 4;
const HIGH_GPU_UTILIZATION_PCT = 95;

export function notSaturated(p) {
  const load = p?.specs?.load;
  if (!load) return true; // no load info → can't filter; trust the node
  const cap = Number.isFinite(load.concurrency_cap) ? load.concurrency_cap : DEFAULT_CONCURRENCY_CAP;
  if (Number.isFinite(load.active_jobs) && load.active_jobs >= cap) return false;
  // GPU pegged at >95% util means a job is already streaming flat-out;
  // adding another would queue inside Ollama.
  if (Number.isFinite(load.gpu_utilization_max) && load.gpu_utilization_max >= HIGH_GPU_UTILIZATION_PCT) {
    return false;
  }
  return true;
}

/**
 * Pick one provider, weighted by `reputation × throughput × headroom`.
 *
 *   - reputation: trust signal (CPR + history). Floor 1, default 50.
 *   - throughput: rolling tokens_per_second_avg from the last N
 *     completed chat jobs. Default 10 when missing (conservative
 *     baseline so brand-new providers aren't stranded).
 *   - headroom: live free-resource snapshot from the last heartbeat.
 *     Free-RAM-gb plus free-VRAM-gb plus a slot bonus per unused
 *     concurrency cap. Default 1 when missing — i.e. the picker
 *     doesn't penalize providers that don't advertise load yet.
 *
 * The product means: a fast node currently saturated loses to a
 * mid-tier node with headroom. A slow node with lots of free RAM
 * still loses to a fast node with even modest headroom. No single
 * factor monopolizes the ranking.
 *
 * Hard filtering (active_jobs ≥ cap, GPU util ≥ 95%) happens upstream
 * in pickChatProvider — by the time we get here, every candidate is
 * at least nominally available.
 */
export function reputationWeightedPick(candidates, rng = Math.random) {
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  const weights = candidates.map((c) => {
    const repNum = Number(c.reputation);
    const reputation = Math.max(1, Number.isFinite(repNum) ? repNum : 50);
    const tps = Number(c?.specs?.bench?.tokens_per_second_avg);
    const speed = Number.isFinite(tps) && tps > 0 ? tps : 10;
    const headroom = headroomScore(c);
    return reputation * speed * headroom;
  });
  const total = weights.reduce((a, w) => a + w, 0);
  let r = rng() * total;
  for (let i = 0; i < candidates.length; i++) {
    r -= weights[i];
    if (r <= 0) return candidates[i];
  }
  return candidates[candidates.length - 1];
}

/**
 * Headroom score from the candidate's specs.load snapshot.
 * Returns 1 when no load info is available (don't penalize), or a
 * value > 0 representing "how much capacity does this provider have
 * to spare right now":
 *
 *   free_vram_gb + free_ram_gb + slot_bonus
 *
 * where slot_bonus = 4 × (1 - active_jobs/cap), so a fully-idle
 * 4-slot node gets +4, a half-busy one gets +2, fully-busy gets +0.
 *
 * Floor 1 so saturated-but-still-eligible nodes (e.g. one with no
 * load info) get tried at minimal weight rather than zero.
 */
export function headroomScore(c) {
  const load = c?.specs?.load;
  if (!load) return 1;
  const freeRam = Number.isFinite(load.ram?.free_gb) ? load.ram.free_gb : 0;
  const freeVram = Number.isFinite(load.vram?.free_gb) ? load.vram.free_gb : 0;
  const cap = Number.isFinite(load.concurrency_cap) ? load.concurrency_cap : 4;
  const active = Number.isFinite(load.active_jobs) ? load.active_jobs : 0;
  const slotBonus = cap > 0 ? 4 * Math.max(0, 1 - active / cap) : 0;
  return Math.max(1, freeRam + freeVram + slotBonus);
}

/**
 * Create a chat job and route it to either a live P2P provider or the
 * NVIDIA NIM fallback. Routing policy:
 *
 *   1. If a P2P provider is available, assign the job to it. The provider
 *      daemon picks it up from its poll loop and streams tokens into
 *      job_events.
 *   2. Otherwise, if NVIDIA_NIM_API_KEY is set, mark the job as running
 *      via the NIM fallback. The SSE stream route detects this and
 *      streams from build.nvidia.com directly while mirroring events
 *      into job_events for a uniform audit trail.
 *   3. If neither is available, the job is recorded as 'failed' with a
 *      `no_provider:` error and callers answer 503.
 *
 * @param {Object} params
 * @param {Array<{role: string, content: string}>} params.messages
 * @param {string} [params.modelName]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 * @returns {Promise<{ job: Object, provider: Object | null, source: 'p2p' | 'nim' | 'none' }>}
 */
/**
 * @param {Object} params
 * @param {Array}  [params.messages]          - plaintext messages (legacy / NIM path)
 * @param {string} [params.encryptedMessages] - NIP-44 ciphertext (E2E path, IPIP-0027)
 * @param {string} [params.clientPubkey]      - consumer's x-only pubkey hex (E2E path)
 * @param {string} [params.modelPubkey]       - model's x-only pubkey hex (IPIP-0028; null → node-keyed)
 * @param {string} [params.providerId]        - pre-selected provider UUID (E2E path)
 * @param {string} [params.modelName]
 * @param {number} [params.maxTokens]
 * @param {number} [params.temperature]
 */
/**
 * The error recorded on a chat job no provider could take. Starts with
 * `no_provider:` so unmet demand can be counted apart from engine failures.
 */
export function noProviderError(modelName) {
  return modelName
    ? `no_provider: no live provider serves model "${modelName}" and the NVIDIA NIM fallback is not configured`
    : "no_provider: no live provider and the NVIDIA NIM fallback is not configured";
}

/**
 * Names no Infernet node will ever serve: the defaults OpenAI-compatible
 * clients send when the user never picked a model (gpt-4o-mini is the
 * openai-python / LangChain / Cursor default), other hosted-API names, and
 * routing placeholders like `auto` or `auto/best-fast`. In production these
 * were the newest failures (chat:gpt-4o-mini, chat:gpt-5.2-mini,
 * chat:auto/best-fast), each a 503 for someone trying the network.
 *
 * Such a request means "any good chat model", so it is served by whatever a
 * live node runs, and the response reports the model that actually answered.
 * A real open-model name nobody serves (llama3.1:70b, or gpt-oss, which is
 * open weights) still fails, with the served list: substituting a different
 * open model there would be a lie.
 */
const MODEL_ALIAS_RE = /^(?:auto(?:[/:-].*)?|default|any|gpt-(?!oss)[\w.:-]+|chatgpt[\w.:-]*|o[1-9](?:-[\w.:-]+)?|text-davinci[\w.:-]*|claude[\w.:-]*|gemini[\w.:-]*)$/i;

export function isModelAlias(modelName) {
  return typeof modelName === "string" && MODEL_ALIAS_RE.test(modelName.trim());
}

// What an alias resolves to, best first, when the picked node serves several.
// General chat models that answer well at small sizes; anything else the node
// serves comes after, in its own order.
const ALIAS_PREFERENCE = [
  "qwen2.5:7b", "qwen3:8b", "llama3.1:8b", "qwen3:4b", "gemma3:4b",
  "llama3.2:3b", "llama-3.2-3b:latest", "qwen2.5:3b",
  "llama3.2:1b", "llama-3.2-1b:latest", "qwen2.5:1.5b", "qwen2.5:0.5b"
];

export function aliasTargetFor(provider) {
  const served = Array.isArray(provider?.specs?.served_models)
    ? provider.specs.served_models.filter((m) => typeof m === "string" && m)
    : [];
  if (served.length === 0) return null;
  for (const m of ALIAS_PREFERENCE) if (served.includes(m)) return m;
  return served[0];
}

export async function createChatJob({
  messages,
  encryptedMessages,
  clientPubkey,
  modelPubkey,
  providerId,
  modelName,
  maxTokens = 512,
  temperature = 0.7,
  distributed = false,
  minTrustTier
}) {
  const supabase = getSupabaseServerClient();
  const now = new Date().toISOString();

  const e2e = Boolean(encryptedMessages && clientPubkey);

  let p2pProvider = null;
  if (providerId) {
    // Client pre-selected a provider (E2E encryption / IPIP-0026 §2.3).
    const { data } = await supabase
      .from("providers")
      .select("id, node_id, name, reputation, price, gpu_model, specs, public_key, trust_tier")
      .eq("id", providerId)
      .eq("status", "available")
      .maybeSingle();
    if (data && minTrustTier && !meetsTrustTier(data, minTrustTier)) {
      // Client demanded a higher tier than the addressed provider has —
      // refuse to route there.
      p2pProvider = null;
    } else {
      p2pProvider = data ?? null;
    }
  }

  // The model the job actually runs. Differs from modelName only when an
  // alias (gpt-4o-mini, auto, ...) was resolved to a model a live node serves.
  let servedModel = modelName;
  let requestedModel = null;

  if (!p2pProvider) {
    p2pProvider = await pickChatProvider({ modelName, minTrustTier });
    if (!p2pProvider && isModelAlias(modelName)) {
      const anyProvider = await pickChatProvider({ minTrustTier });
      const target = aliasTargetFor(anyProvider);
      if (anyProvider && target) {
        p2pProvider = anyProvider;
        servedModel = target;
        requestedModel = modelName;
      }
    }
  }

  const nimAvailable = !p2pProvider && isNimConfigured();
  const source = p2pProvider ? "p2p" : nimAvailable ? "nim" : "none";
  if (nimAvailable && isModelAlias(modelName)) {
    // NIM would 404 on "gpt-4o-mini" too; run its configured default instead.
    servedModel = nimVirtualProvider().model;
    requestedModel = modelName;
  }

  const inputSpec = {
    ...(e2e
      ? { encrypted_messages: encryptedMessages }
      : { messages }),
    max_tokens: maxTokens,
    temperature,
    ...(requestedModel ? { requested_model: requestedModel } : {}),
    ...(nimAvailable ? { fallback: "nvidia-nim" } : {}),
    ...(distributed ? { distributed: true } : {})
  };

  // Nothing can serve this request. Nothing ever picks up an unassigned
  // 'pending' chat job either (daemons poll for jobs assigned to them), so a
  // pending row here just sat forever and inflated the pending count. Record
  // it as failed instead: the row still shows the unmet demand (which model
  // people asked for), and the caller answers 503.
  const status = p2pProvider ? "assigned" : nimAvailable ? "running" : "failed";

  const insertRow = {
    title: servedModel ? `chat:${servedModel}` : "chat",
    type: "chat",
    status,
    provider_id: p2pProvider?.id ?? null,
    model_name: servedModel ?? null,
    input_spec: encryptJSON(inputSpec),
    payment_offer: 0,
    assigned_at: p2pProvider || nimAvailable ? now : null,
    updated_at: now
  };
  if (source === "none") {
    insertRow.error = noProviderError(modelName);
    insertRow.completed_at = now;
  }

  if (e2e && clientPubkey) insertRow.client_pubkey = clientPubkey;
  if (e2e && modelPubkey) insertRow.model_pubkey = modelPubkey;

  let { data: job, error } = await supabase
    .from("jobs")
    .insert(insertRow)
    .select()
    .single();

  // Graceful degradation: if the migration adding E2E columns hasn't been
  // applied yet, retry without them so the playground stays functional.
  if (error?.message?.includes("client_pubkey") || error?.message?.includes("model_pubkey")) {
    const fallbackRow = { ...insertRow };
    delete fallbackRow.client_pubkey;
    delete fallbackRow.model_pubkey;
    // Also fall back to plaintext messages so the provider can read the job.
    if (e2e && messages) {
      fallbackRow.input_spec = encryptJSON({ messages, max_tokens: maxTokens, temperature });
    }
    ({ data: job, error } = await supabase
      .from("jobs")
      .insert(fallbackRow)
      .select()
      .single());
  }

  if (error) throw error;

  const provider = p2pProvider ?? (nimAvailable ? nimVirtualProvider() : null);
  return { job, provider, source, requestedModel };
}

function firstUserPrompt(messages) {
  for (const m of messages ?? []) {
    if (m?.role === "user" && typeof m.content === "string") return m.content;
  }
  return "";
}

export async function getJobWithEvents(jobId, sinceId = 0) {
  const supabase = getSupabaseServerClient();
  const [{ data: job, error: jobErr }, { data: events, error: evErr }] = await Promise.all([
    supabase.from("jobs").select("*").eq("id", jobId).maybeSingle(),
    supabase
      .from("job_events")
      .select("id, event_type, data, created_at")
      .eq("job_id", jobId)
      .gt("id", sinceId)
      .order("id", { ascending: true })
  ]);
  if (jobErr) throw jobErr;
  if (evErr) throw evErr;

  const decryptedJob = job
    ? { ...job, input_spec: decryptJSON(job.input_spec), result: decryptJSON(job.result) }
    : null;
  const decryptedEvents = (events ?? []).map((ev) => ({ ...ev, data: decryptJSON(ev.data) }));

  return { job: decryptedJob, events: decryptedEvents };
}

/**
 * Models the playground can offer to clients = distinct
 * specs.served_models across providers that are online right now.
 * Falls back to the (manually curated) `models` table if no provider
 * is advertising anything yet. The fallback exists so the playground
 * isn't blank in dev when nothing is registered.
 */
export async function listChatModels() {
  const supabase = getSupabaseServerClient();
  const tenMinAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { data: provs, error: pErr } = await supabase
    .from("providers")
    .select("specs")
    .eq("status", "available")
    .gte("last_seen", tenMinAgo);
  if (pErr) throw pErr;

  const seen = new Set();
  for (const p of provs ?? []) {
    const served = Array.isArray(p?.specs?.served_models) ? p.specs.served_models : [];
    for (const m of served) {
      if (typeof m === "string" && m) seen.add(m);
    }
  }
  if (seen.size > 0) {
    return [...seen].sort().map((name) => ({ id: name, name, family: null, context_length: null }));
  }

  const { data: models, error: mErr } = await supabase
    .from("models")
    .select("id, name, family, context_length")
    .eq("visibility", "public")
    .order("name");
  if (mErr) throw mErr;
  return models ?? [];
}

/**
 * Names of the models live nodes serve right now, for the 503 a caller gets
 * when nothing serves what it asked for. Never throws: the error response
 * must not turn into a 500 because this lookup failed.
 */
export async function liveModelNames() {
  try {
    return (await listChatModels()).map((m) => m.name).filter(Boolean);
  } catch {
    return [];
  }
}
