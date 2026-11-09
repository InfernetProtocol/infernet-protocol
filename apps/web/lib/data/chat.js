import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";
import { isNimConfigured, nimVirtualProvider } from "@infernetprotocol/nim-adapter";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";
import { matchServedModel } from "@/lib/model-names";
import { getModelDenylist } from "@/lib/data/blocklists";
import { deniedModel } from "@/lib/moderation/blocklists";
import { smartPick, isSaturated, isOverloaded, countInflight } from "@/lib/routing/smart-pick";
import { estimateInputTokens } from "@/lib/billing/core";

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

export async function pickChatProvider({ modelName, minTrustTier, requireE2E = false, excludeProviderIds = [], requireFreeSlot = false } = {}) {
  const supabase = getSupabaseServerClient();
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  const { data, error } = await supabase
    .from("providers")
    .select("id, node_id, name, reputation, price, gpu_model, specs, public_key, trust_tier")
    .eq("status", "available")
    .is("disabled_at", null)
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
      return finishPick(fallback.data ?? [], { modelName, minTrustTier, requireE2E, excludeProviderIds, requireFreeSlot }, await inflightByProvider(supabase, fallback.data ?? []));
    }
    throw error;
  }

  return finishPick(data ?? [], { modelName, minTrustTier, requireE2E, excludeProviderIds, requireFreeSlot }, await inflightByProvider(supabase, data ?? []));
}

/**
 * Live assigned/running chat jobs per provider. Heartbeats report
 * active_jobs every minute or so; a burst of requests in between would all
 * land on the same "idle" node without this. Jobs older than 15 minutes
 * are ignored (the maintenance cron fails stuck ones). Never throws:
 * routing falls back to heartbeat load alone.
 */
async function inflightByProvider(supabase, rows) {
  const ids = rows.map((r) => r?.id).filter(Boolean);
  if (ids.length === 0) return {};
  try {
    const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const { data, error } = await supabase
      .from("jobs")
      .select("provider_id")
      .in("status", ["assigned", "running"])
      .in("provider_id", ids)
      .gte("created_at", since)
      .limit(5000);
    if (error) return {};
    return countInflight(data);
  } catch {
    return {};
  }
}

export function finishPick(rows, { modelName, minTrustTier, requireE2E = false, excludeProviderIds = [], requireFreeSlot = false } = {}, inflight = {}) {
  let candidates = rows;
  const excluded = new Set(Array.isArray(excludeProviderIds) ? excludeProviderIds : []);
  if (excluded.size > 0) candidates = candidates.filter((provider) => !excluded.has(provider?.id));

  if (requireE2E) {
    candidates = candidates.filter((provider) => {
      const specs = provider?.specs ?? {};
      const nodeKey = provider?.public_key;
      if (
        specs.e2e_capable !== true
        || specs.e2e_version !== "nip44-v2"
        || typeof nodeKey !== "string"
        || !/^(?:[0-9a-f]{64}|[0-9a-f]{66})$/i.test(nodeKey)
      ) return false;
      if (!modelName) return true;
      const servedName = matchServedModel(specs.served_models, modelName) ?? modelName;
      const modelKey = specs.model_keys?.[servedName];
      return typeof modelKey === "string" && /^(?:[0-9a-f]{64}|[0-9a-f]{66})$/i.test(modelKey);
    });
  }

  if (typeof modelName === "string" && modelName) {
    // Any name of the model counts: catalog id, Ollama tag, HF repo or the
    // allmodels.io id (lib/model-names.js).
    candidates = candidates.filter((p) => matchServedModel(p?.specs?.served_models, modelName) !== null);
  }

  // IPIP-0026 §2.2 — clients can require a minimum trust tier. Default
  // routing also drops `private` providers, which only accept jobs sent
  // by provider_id with an explicit allowlist.
  candidates = candidates.filter((p) => (p.trust_tier ?? "public") !== "private");
  if (minTrustTier) {
    candidates = candidates.filter((p) => meetsTrustTier(p, minTrustTier));
  }

  // Hard filter: drop saturated nodes, whose queue is full (active jobs at
  // the queue limit, max(concurrency cap, 4)) or whose GPU is pegged. Live
  // in-flight jobs count too: the daemon's heartbeat only reports the job it
  // is running, never the ones assigned behind it. Nodes with every slot
  // busy stay eligible but rank last (lib/routing/smart-pick.js), so a burst
  // queues on the node expected to finish first instead of failing over to
  // the paid fallback or a 503.
  candidates = candidates.filter((p) => !isSaturated(p, inflight));
  // Moving a queued job (lib/data/chat-rebalance.js) only helps if the new
  // node can start it now.
  if (requireFreeSlot) candidates = candidates.filter((p) => !isOverloaded(p, inflight));

  if (candidates.length === 0) return null;
  // Smart routing: the provider expected to finish the job first
  // (lib/routing/smart-pick.js).
  return smartPick(candidates, inflight);
}

/** False when routing must not add work to this node (heartbeat load only). */
export function notSaturated(p) {
  return !isSaturated(p, {});
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
// Plain chat models that answer well at small sizes. Reasoning models come
// last: a client that sent gpt-4o-mini with max_tokens 16 expects an answer,
// and qwen3 spent the whole budget thinking, so the reply was empty (seen
// live on 2026-10-07; the same prompt on gemma3:4b answered at once).
const ALIAS_PREFERENCE = [
  "qwen2.5:7b", "llama3.1:8b", "gemma3:4b",
  "llama3.2:3b", "llama-3.2-3b:latest", "qwen2.5:3b",
  "llama3.2:1b", "llama-3.2-1b:latest", "qwen2.5:1.5b", "qwen2.5:0.5b"
];
const REASONING_MODEL_RE = /^(?:qwen3|deepseek-r1|qwq|phi4-reasoning|magistral)|think/i;

export function aliasTargetFor(provider) {
  const served = Array.isArray(provider?.specs?.served_models)
    ? provider.specs.served_models.filter((m) => typeof m === "string" && m)
    : [];
  if (served.length === 0) return null;
  for (const m of ALIAS_PREFERENCE) if (served.includes(m)) return m;
  return served.find((m) => !REASONING_MODEL_RE.test(m)) ?? served[0];
}

// Hosted fallback requests per UTC day. The fallback is a paid API once its
// free allowance runs out, and the public chat endpoints are anonymous, so the
// spend has a ceiling: past it, requests get the usual "no live node" 503.
// 0 turns the fallback off; unset means 300.
const DEFAULT_FALLBACK_DAILY_LIMIT = 300;

export function hostedFallbackDailyLimit(env = process.env) {
  const raw = env.HOSTED_FALLBACK_DAILY_LIMIT;
  if (raw === undefined || raw === "") return DEFAULT_FALLBACK_DAILY_LIMIT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_FALLBACK_DAILY_LIMIT;
}

/**
 * True while today's hosted-fallback jobs are under the cap. A fallback job is
 * one with no provider that was still assigned (no_provider failures are never
 * assigned). A failed count query means no fallback: an unbounded bill is worse
 * than a 503.
 */
export async function hostedFallbackUnderDailyCap(now = new Date()) {
  const limit = hostedFallbackDailyLimit();
  if (limit === 0) return false;
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
  const supabase = getSupabaseServerClient();
  const { count, error } = await supabase
    .from("jobs")
    .select("id", { count: "exact", head: true })
    .is("provider_id", null)
    .not("assigned_at", "is", null)
    .gte("created_at", midnight);
  if (error || typeof count !== "number") return false;
  return count < limit;
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
  minTrustTier,
  // Managed reservations: serve on providerId or not at all. No re-pick, no
  // alias rewrite, no hosted fallback (docs/prd/16-managed-endpoints.md).
  pinned = false,
  // The reservation this job serves: tagged on the job so it earns no
  // subsidy (the operator is paid from the reservation order instead).
  reservationId = null,
  // Paid batch inference (lib/data/batches.js): the item this job serves.
  // Billed from the customer's prepaid hold, never a subsidy.
  batchItemId = null,
  // The caller asked for peer nodes only (p2p_only): never the hosted
  // fallback, which is billed. No node free answers 503 like any other miss.
  noFallback = false,
  // Interactive pay-as-you-go: whose compute balance this job is charged to
  // when it finishes (lib/data/interactive-billing.js). Null for the
  // anonymous, IP-rate-limited free tier, which bills nobody. A batch item is
  // billed from its own prepaid hold and never sets this.
  billedUserId = null
}) {
  const supabase = getSupabaseServerClient();
  const now = new Date().toISOString();

  // Admin kill switch: settings row 'model_denylist'.
  const denylist = await getModelDenylist();
  if (deniedModel(denylist, modelName)) {
    throw withStatus(`model "${modelName}" is not available on Infernet`, 403);
  }

  const e2e = Boolean(encryptedMessages && clientPubkey);
  if (encryptedMessages && (!providerId || !clientPubkey)) {
    throw withStatus("E2E chat requires an explicitly selected provider and client key", 400);
  }

  let p2pProvider = null;
  if (providerId) {
    // Client pre-selected a provider (E2E encryption / IPIP-0026 §2.3).
    const { data } = await supabase
      .from("providers")
      .select("id, node_id, name, reputation, price, gpu_model, specs, public_key, trust_tier")
      .eq("id", providerId)
      .eq("status", "available")
      .is("disabled_at", null)
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

  if (!p2pProvider && !pinned && !providerId) {
    p2pProvider = await pickChatProvider({ modelName, minTrustTier });
    // Asked by another name of the model: run it under the name the node serves.
    const servedName = p2pProvider && modelName ? matchServedModel(p2pProvider.specs?.served_models, modelName) : null;
    if (servedName && servedName !== modelName) {
      servedModel = servedName;
      requestedModel = modelName;
    }
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

  // A preselected provider may serve the request under a canonical model
  // name (for example, a model alias). Persist that canonical name so the
  // daemon selects the same per-model key the client used for encryption.
  if (p2pProvider && modelName) {
    const servedName = matchServedModel(p2pProvider.specs?.served_models, modelName);
    if (servedName && servedName !== modelName) {
      servedModel = servedName;
      requestedModel = modelName;
    }
  }

  if (p2pProvider && e2e) {
    const specs = p2pProvider.specs ?? {};
    const servedName = modelName ? (matchServedModel(specs.served_models, modelName) ?? modelName) : null;
    const expectedKey = servedName ? specs.model_keys?.[servedName] : p2pProvider.public_key;
    const suppliedKey = modelPubkey ?? p2pProvider.public_key;
    if (
      specs.e2e_capable !== true
      || specs.e2e_version !== "nip44-v2"
      || typeof expectedKey !== "string"
      || expectedKey !== suppliedKey
    ) {
      p2pProvider = null;
    }
  }

  const nimAvailable = !p2pProvider && !providerId && !e2e && !pinned && !noFallback
    && isNimConfigured() && (await hostedFallbackUnderDailyCap());
  const source = p2pProvider ? "p2p" : nimAvailable ? "nim" : "none";
  if (nimAvailable) {
    // The hosted fallback serves one configured model. Forwarding the name the
    // caller asked for ("gpt-4o-mini", "qwen2.5:7b") only earned a 404 there.
    const fallbackModel = nimVirtualProvider().model;
    if (modelName && modelName !== fallbackModel) requestedModel = modelName;
    servedModel = fallbackModel;
  }

  // The name the job really runs under (alias or fallback model) counts too.
  if (servedModel && servedModel !== modelName && deniedModel(denylist, servedModel)) {
    throw withStatus(`model "${servedModel}" is not available on Infernet`, 403);
  }

  const inputSpec = {
    ...(e2e
      ? { encrypted_messages: encryptedMessages }
      : { messages }),
    max_tokens: maxTokens,
    temperature,
    ...(requestedModel ? { requested_model: requestedModel } : {}),
    ...(nimAvailable ? { fallback: "nvidia-nim" } : {}),
    ...(distributed ? { distributed: true } : {}),
    ...(batchItemId ? { billing: "prepaid_batch" } : {}),
    // Stored so the charge at completion prices the same input the caller
    // sent, without decrypting an E2E payload it cannot read.
    ...(billedUserId && !batchItemId
      ? { billing: "interactive_balance", input_tokens: estimateInputTokens(messages ?? []) }
      : {})
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
    updated_at: now,
    ...(billedUserId && !batchItemId ? { billed_user_id: billedUserId } : {})
  };
  if (source === "none") {
    insertRow.error = noProviderError(modelName);
    insertRow.completed_at = now;
  }

  if (reservationId) insertRow.reservation_id = reservationId;
  if (batchItemId) insertRow.batch_item_id = batchItemId;
  if (e2e && clientPubkey) insertRow.client_pubkey = clientPubkey;
  if (e2e && modelPubkey) insertRow.model_pubkey = modelPubkey;

  let { data: job, error } = await supabase
    .from("jobs")
    .insert(insertRow)
    .select()
    .single();

  // Legacy plaintext clients can continue without the optional E2E columns.
  // An encrypted job cannot: retrying without its client key would make it
  // undecryptable, and must never turn into a plaintext fallback.
  if (error?.message?.includes("client_pubkey") || error?.message?.includes("model_pubkey")) {
    if (e2e) throw error;
    const fallbackRow = { ...insertRow };
    delete fallbackRow.client_pubkey;
    delete fallbackRow.model_pubkey;
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
    .is("disabled_at", null)
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
 * Models the browser's encrypted playground can actually route right now.
 * A model is shown only when a live provider advertises NIP-44 v2 support,
 * a valid node key, and a valid model-specific key. This keeps the picker
 * aligned with pickChatProvider({ requireE2E: true }) and avoids offering
 * plaintext-only or stale model listings to browser chat.
 */
export function e2EChatModelNames(providers, inflight = {}) {
  const models = new Set();
  for (const provider of providers) {
    const specs = provider?.specs ?? {};
    if (
      specs.e2e_capable !== true
      || specs.e2e_version !== "nip44-v2"
      || (provider.trust_tier ?? "public") === "private"
      || !/^(?:[0-9a-f]{64}|[0-9a-f]{66})$/i.test(provider.public_key ?? "")
    ) continue;

    const keys = specs.model_keys ?? {};
    for (const name of Array.isArray(specs.served_models) ? specs.served_models : []) {
      if (
        typeof name === "string"
        && name.length > 0
        && /^(?:[0-9a-f]{64}|[0-9a-f]{66})$/i.test(keys[name] ?? "")
        && finishPick(providers, { modelName: name, requireE2E: true }, inflight)
      ) models.add(name);
    }
  }

  const lightFirst = ["qwen2.5:0.5b", "qwen2.5:1.5b"];
  return [...models]
    .sort((a, b) => {
      const aRank = lightFirst.indexOf(a);
      const bRank = lightFirst.indexOf(b);
      if (aRank >= 0 || bRank >= 0) {
        return (aRank < 0 ? lightFirst.length : aRank) - (bRank < 0 ? lightFirst.length : bRank);
      }
      return a.localeCompare(b);
    });
}

export async function listE2EChatModels() {
  const supabase = getSupabaseServerClient();
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();
  let query = await supabase
    .from("providers")
    .select("id, reputation, specs, public_key, trust_tier")
    .eq("status", "available")
    .is("disabled_at", null)
    .gte("last_seen", twoMinAgo);

  // Older deployments may not have trust_tier yet. They behave as public in
  // pickChatProvider, so retry with the same default here.
  if (query.error && /trust_tier/.test(query.error.message ?? "")) {
    query = await supabase
      .from("providers")
      .select("id, reputation, specs, public_key")
      .eq("status", "available")
      .is("disabled_at", null)
      .gte("last_seen", twoMinAgo);
  }
  if (query.error) throw query.error;

  const providers = query.data ?? [];
  const inflight = await inflightByProvider(supabase, providers);
  return e2EChatModelNames(providers, inflight)
    .map((name) => ({ id: name, name, family: null, context_length: null }));
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

function withStatus(message, status) {
  return Object.assign(new Error(message), { status });
}
