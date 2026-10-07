import { getSupabaseServerClient } from "@/lib/supabase/server";
import { getJobWithEvents } from "@/lib/data/chat";
import { streamChatCompletion, fallbackName } from "@infernetprotocol/nim-adapter";
import { MIN_RPC_PEERS, MAX_RPC_PEERS, ENGINE_ID as RPC_ENGINE_ID } from "@infernetprotocol/rpc-adapter/constants";
import { encryptJSON, decryptJSON } from "@/lib/encrypt";
import {
  selectRpcSlices,
  mergeRpcRouting,
  splitRpcReceiptShares
} from "@/lib/data/rpc-routing";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Server-Sent Events stream for a chat job.
 *
 * Two code paths depending on how the job was routed in createChatJob:
 *
 *   - `input_spec.fallback === 'nvidia-nim'`  →  stream directly from
 *     build.nvidia.com, relaying tokens to the client AND mirroring them
 *     into job_events for a uniform audit trail.
 *
 *   - otherwise (real P2P provider)  →  tail `job_events` via Supabase
 *     Realtime; the provider daemon is responsible for writing tokens.
 *
 * In both cases the client sees the same SSE event types:
 *   job | meta | token | done | error
 */
export async function GET(_request, { params }) {
  const { jobId } = await params;
  const encoder = new TextEncoder();

  function sseFrame(eventType, data, id) {
    let out = "";
    if (id != null) out += `id: ${id}\n`;
    out += `event: ${eventType}\n`;
    out += `data: ${JSON.stringify(data)}\n\n`;
    return encoder.encode(out);
  }

  const stream = new ReadableStream({
    async start(controller) {
      const supabase = getSupabaseServerClient();

      let closed = false;
      let lastId = 0;
      const safeEnqueue = (chunk) => {
        if (closed) return;
        try { controller.enqueue(chunk); } catch { closed = true; }
      };
      const safeClose = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* ignore */ }
      };

      // Initial payload: job row + any events already persisted.
      let job;
      try {
        const loaded = await getJobWithEvents(jobId, 0);
        job = loaded.job;
        if (!job) {
          safeEnqueue(sseFrame("error", { message: "job not found", jobId }));
          safeClose();
          return;
        }
        safeEnqueue(sseFrame("job", job));
        for (const ev of loaded.events) {
          lastId = Math.max(lastId, ev.id);
          safeEnqueue(sseFrame(ev.event_type, ev.data, ev.id));
          if (ev.event_type === "done" || ev.event_type === "error") {
            safeClose();
            return;
          }
        }
      } catch (e) {
        safeEnqueue(sseFrame("error", { message: e?.message ?? String(e) }));
        safeClose();
        return;
      }

      // Heartbeat keeps the connection alive through proxies in both paths.
      const hb = setInterval(() => safeEnqueue(encoder.encode(": ping\n\n")), 15_000);

      // IPIP-0033: distributed inference via llama.cpp RPC over
      // Hyperswarm-discovered peers. Replaces the Petals path
      // (IPIP-0031, Replaced) — the legacy proxy was removed.
      if (job?.input_spec?.distributed) {
        try {
          await runRpcProxy({ supabase, job, safeEnqueue, sseFrame });
        } catch (e) {
          safeEnqueue(sseFrame("error", { message: e?.message ?? String(e) }));
          await finalizeJob(supabase, job.id, { status: "failed", error: e?.message ?? String(e) }).catch(() => {});
        }
        clearInterval(hb);
        safeClose();
        return;
      }

      const fallback = job?.input_spec?.fallback;
      if (fallback === "nvidia-nim") {
        try {
          await runNimFallback({ supabase, job, safeEnqueue, sseFrame });
        } catch (e) {
          safeEnqueue(sseFrame("error", { message: e?.message ?? String(e) }));
        }
        clearInterval(hb);
        safeClose();
        return;
      }

      // Default P2P path — subscribe to Realtime inserts for this job_id.
      const channel = supabase.channel(`chat-${jobId}`).on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "job_events", filter: `job_id=eq.${jobId}` },
        (payload) => {
          const ev = payload?.new;
          if (!ev || ev.id <= lastId) return;
          lastId = ev.id;
          safeEnqueue(sseFrame(ev.event_type, decryptJSON(ev.data), ev.id));
          if (ev.event_type === "done" || ev.event_type === "error") {
            try { supabase.removeChannel(channel); } catch { /* ignore */ }
            clearInterval(hb);
            safeClose();
          }
        }
      );
      channel.subscribe();

      // Catch-up: events written between the initial load and the Realtime
      // subscription activating are not delivered by Realtime. One DB query
      // after subscribe closes that race window. The lastId dedup in the
      // Realtime callback above handles any overlap.
      try {
        const { data: catchup } = await supabase
          .from("job_events")
          .select("id, event_type, data, created_at")
          .eq("job_id", jobId)
          .gt("id", lastId)
          .order("id", { ascending: true });
        catchupDone = true;
        for (const ev of catchup ?? []) {
          if (ev.id <= lastId) continue;
          lastId = ev.id;
          safeEnqueue(sseFrame(ev.event_type, decryptJSON(ev.data), ev.id));
          if (ev.event_type === "done" || ev.event_type === "error") {
            try { supabase.removeChannel(channel); } catch { /* ignore */ }
            clearInterval(hb);
            safeClose();
            return;
          }
        }
      } catch {
        // non-fatal; Realtime will still deliver future events
      }

      // Cleanup: absolute upper bound so an abandoned connection can't
      // hold resources forever.
      const maxAlive = setTimeout(() => {
        try { supabase.removeChannel(channel); } catch { /* ignore */ }
        clearInterval(hb);
        safeClose();
      }, 10 * 60 * 1000);
      if (typeof maxAlive.unref === "function") maxAlive.unref();
    }
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      Connection: "keep-alive"
    }
  });
}

/**
 * Stream a chat response from NVIDIA NIM. Tokens are enqueued to the
 * client (so the UI sees them live) AND inserted into `job_events` so
 * the job's audit trail looks identical to a real P2P provider run.
 */
/**
 * IPIP-0033 — federated inference via llama.cpp RPC. The control
 * plane:
 *
 *   1. picks a *primary* (a node whose specs.rpc_primary.models
 *      includes the requested model and whose llama-server can run
 *      it locally)
 *   2. picks up to MAX_RPC_PEERS *slices* (specs.rpc.models contains
 *      the model). Fails closed when fewer than MIN_RPC_PEERS are
 *      available — silent fallback was the credibility hole that made
 *      IPIP-0031 misleading
 *   3. POSTs to the primary's /v1/rpc/inference with the peer list
 *   4. proxies the resulting SSE stream back to the consumer
 *      (meta → routing → token... → done)
 */
async function runRpcProxy({ supabase, job, safeEnqueue, sseFrame }) {
  const ENGINE_ID = RPC_ENGINE_ID;
  const input = job.input_spec ?? {};
  const messages = input.messages ?? [];
  const model = job.model_name;
  if (!model) throw new Error("rpc inference: model name required");

  // Two-minute liveness window — same as pickChatProvider for the
  // single-node path. A primary that hasn't beaten in 2 min isn't
  // trusted to dispatch a multi-peer job.
  const twoMinAgo = new Date(Date.now() - 2 * 60 * 1000).toISOString();

  // Primary candidates — must advertise specs.rpc_primary.models and
  // be currently available + fresh.
  const { data: primaryRows, error: primaryErr } = await supabase
    .from("providers")
    .select("id, public_key, name, address, port, specs, status, trust_tier, reputation")
    .eq("status", "available")
    .gte("last_seen", twoMinAgo)
    .contains("specs", { rpc_primary: { models: [model] } })
    .limit(8);
  if (primaryErr) throw primaryErr;
  let primaries = (primaryRows ?? []).filter((p) => (p.trust_tier ?? "public") !== "private");
  if (input.min_trust_tier) {
    primaries = primaries.filter((p) => meetsRpcTier(p.trust_tier, input.min_trust_tier));
  }
  if (primaries.length === 0) {
    throw new Error(
      `No RPC primary available for ${model}. Operators host one via ` +
      `\`infernet inference primary --model ${model}\` (IPIP-0033).`
    );
  }
  const primary = primaries[Math.floor(Math.random() * primaries.length)];

  // Slice candidates — same filters, different specs sub-key.
  const { data: sliceRows, error: sliceErr } = await supabase
    .from("providers")
    .select("id, public_key, name, address, port, specs, status, trust_tier")
    .eq("status", "available")
    .gte("last_seen", twoMinAgo)
    .contains("specs", { rpc: { models: [model] } })
    .limit(MAX_RPC_PEERS * 2);
  if (sliceErr) throw sliceErr;
  const sliceCandidates = selectRpcSlices(sliceRows ?? [], {
    minTrustTier: input.min_trust_tier,
    excludeProviderId: primary.id
  });

  // Fail closed (IPIP-0033 §3). Silent fallback to single-node was
  // the bug that made IPIP-0031 a credibility hole — don't repeat it.
  if (sliceCandidates.length < MIN_RPC_PEERS) {
    safeEnqueue(sseFrame("routing", {
      engine: ENGINE_ID,
      primary: { id: primary.id, name: primary.name, pubkey: primary.public_key },
      peers: [],
      pending: false,
      shortfall: { available: sliceCandidates.length, required: MIN_RPC_PEERS },
      note: `Distributed mode requires at least ${MIN_RPC_PEERS} RPC slices for ${model}; only ${sliceCandidates.length} are live.`
    }));
    throw new Error(
      `Distributed inference requires at least ${MIN_RPC_PEERS} RPC slices for ${model}; ` +
      `only ${sliceCandidates.length} are currently available. Operators host a slice via ` +
      `\`infernet inference serve --backend rpc --model ${model}\` (IPIP-0033).`
    );
  }

  const chosen = sliceCandidates.slice(0, MAX_RPC_PEERS);
  const chosenSlices = chosen.map((c) => c.provider);
  const rpcPeers = chosen.map(({ host, port, pubkey }) => ({ host, port, pubkey }));

  // Persisted meta — same audit-trail shape every other path uses.
  const persistedMeta = await insertJobEvent(supabase, job.id, "meta", {
    provider_node_id: primary.id,
    provider_name: primary.name,
    model,
    backend: "rpc",
    distributed: true,
    started_at: new Date().toISOString(),
    rpc_peers: rpcPeers.map((p) => ({ host: p.host, port: p.port, pubkey: p.pubkey }))
  });
  if (persistedMeta) safeEnqueue(sseFrame("meta", persistedMeta.data, persistedMeta.id));

  // Initial routing frame — show the entry node immediately so the UI
  // doesn't sit on a placeholder.
  safeEnqueue(sseFrame("routing", {
    engine: ENGINE_ID,
    primary: { id: primary.id, name: primary.name, pubkey: primary.public_key },
    peers: rpcPeers.map((p) => ({
      host: p.host,
      port: p.port,
      pubkey: p.pubkey,
      name: chosenSlices.find((s) => s.public_key === p.pubkey)?.name ?? null,
      layers: null,
      status: "pending"
    })),
    pending: true,
    model
  }));

  const url = providerEndpoint(primary) + "/v1/rpc/inference";
  const upstream = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: input.max_tokens ?? 512,
      temperature: input.temperature ?? 0.7,
      rpc_peers: rpcPeers
    })
  });
  if (!upstream.ok || !upstream.body) {
    throw new Error(`upstream primary ${url} returned HTTP ${upstream.status}`);
  }

  // SSE-line parser: each daemon frame looks like
  // `event: <name>\ndata: {...json...}\n\n`.
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let lastEventName = "data";
  let layerByPeer = null;

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      let evName = lastEventName;
      let evData = null;
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) evName = line.slice(6).trim();
        else if (line.startsWith("data:")) {
          try { evData = JSON.parse(line.slice(5).trim()); } catch { /* skip */ }
        }
      }
      lastEventName = evName;
      if (!evData) continue;

      if (evName === "token") {
        const t = evData.text ?? "";
        fullText += t;
        safeEnqueue(sseFrame("token", { text: t }));
        insertJobEvent(supabase, job.id, "token", { text: t }).catch(() => {});
      } else if (evName === "routing") {
        // Daemon-side routing frame carries the per-peer layer
        // assignments parsed from llama-server's stderr (rpc-adapter's
        // aggregateLayerAssignments). Merge with our pubkey lookup so
        // the UI gets operator names alongside host:port.
        layerByPeer = Array.isArray(evData.peers) ? evData.peers : null;
        const enriched = mergeRpcRouting({ daemonPeers: layerByPeer, slices: chosenSlices });
        safeEnqueue(sseFrame("routing", {
          engine: ENGINE_ID,
          primary: { id: primary.id, name: primary.name, pubkey: primary.public_key },
          peers: enriched,
          pending: false,
          model
        }));
        insertJobEvent(supabase, job.id, "routing", { peers: enriched }).catch(() => {});
      } else if (evName === "log") {
        safeEnqueue(sseFrame("log", evData));
      } else if (evName === "done") {
        const data = { text: fullText, finished_at: new Date().toISOString() };
        const persisted = await insertJobEvent(supabase, job.id, "done", data);
        safeEnqueue(sseFrame("done", data, persisted?.id));
        await finalizeJob(supabase, job.id, {
          status: "completed",
          result: { type: "chat", text: fullText, source: "rpc", primary_id: primary.id }
        });
        await emitRpcReceipts({ supabase, job, primary, chosenSlices, layerByPeer });
        return;
      } else if (evName === "error") {
        const persisted = await insertJobEvent(supabase, job.id, "error", evData);
        safeEnqueue(sseFrame("error", evData, persisted?.id));
        await finalizeJob(supabase, job.id, { status: "failed", error: evData.message ?? "rpc primary error" });
        return;
      }
    }
  }

  // Stream ended without a `done` frame. Treat as graceful close.
  if (!fullText) {
    safeEnqueue(sseFrame("error", { message: "rpc primary closed stream before any tokens" }));
    await finalizeJob(supabase, job.id, { status: "failed", error: "rpc primary closed stream" }).catch(() => {});
  }
}

/**
 * IPIP-0033 §6 — split a CPR receipt across the primary + the layer-
 * contributing slices. Primary gets a `1 / (n + 1)` base share for
 * orchestration + embedding + final-layer compute; the rest is
 * weighted by `(layers.end - layers.start)` per slice.
 *
 * If the daemon never reported per-peer layer ranges (older builds /
 * llama-server stderr format we don't recognize), credit the primary
 * for the full job.
 */
async function emitRpcReceipts({ supabase, job, primary, chosenSlices, layerByPeer }) {
  try {
    const { buildReceiptBody } = await import("@/lib/cpr/receipts");
    const { enqueueAndFlush } = await import("@/lib/cpr/queue");

    const baseJob = {
      id: job.id, type: "inference", status: "completed",
      payment_offer: job.payment_offer ?? 0
    };
    const totalOffer = baseJob.payment_offer ?? 0;
    const shares = splitRpcReceiptShares({
      primary,
      slices: chosenSlices,
      daemonPeers: layerByPeer
    });

    for (const { provider, share, role } of shares) {
      if (!provider?.public_key) continue;
      const receipt = buildReceiptBody({
        job: { ...baseJob, payment_offer: totalOffer * share },
        provider: { public_key: provider.public_key, id: provider.id }
      });
      await enqueueAndFlush({ receipt, jobId: job.id }).catch((err) =>
        console.warn(`CPR enqueueAndFlush (rpc ${role}): ${err?.message ?? err}`)
      );
    }
  } catch (err) {
    console.warn(`CPR rpc attribution failed: ${err?.message ?? err}`);
  }
}



function providerEndpoint(provider) {
  if (!provider?.address) throw new Error("provider has no advertised address");
  const port = provider.port ?? 8080;
  return `http://${provider.address}:${port}`;
}


async function runNimFallback({ supabase, job, safeEnqueue, sseFrame }) {
  const input = job.input_spec ?? {};
  const messages = input.messages ?? [];
  const model = input.nim_model ?? job.model_name ?? undefined;

  let fullText = "";
  let finalPersisted = false;
  const persistedMeta = await insertJobEvent(supabase, job.id, "meta", {
    provider_node_id: "nvidia-nim",
    provider_name: fallbackName(),
    model: model ?? null,
    started_at: new Date().toISOString()
  });
  if (persistedMeta) safeEnqueue(sseFrame("meta", persistedMeta.data, persistedMeta.id));

  for await (const ev of streamChatCompletion({
    messages,
    model,
    maxTokens: input.max_tokens,
    temperature: input.temperature
  })) {
    if (ev.type === "meta") continue; // we already emitted our own meta above
    if (ev.type === "token") {
      fullText += ev.data?.text ?? "";
      // Enqueue to client immediately; DB insert is audit-only so fire-and-forget.
      safeEnqueue(sseFrame("token", ev.data));
      insertJobEvent(supabase, job.id, "token", ev.data).catch(() => {});
    } else if (ev.type === "done") {
      const data = { text: fullText, finished_at: ev.data?.finished_at ?? new Date().toISOString() };
      const persisted = await insertJobEvent(supabase, job.id, "done", data);
      safeEnqueue(sseFrame("done", data, persisted?.id));
      await finalizeJob(supabase, job.id, { status: "completed", result: { type: "chat", text: fullText, source: "nvidia-nim" } });
      finalPersisted = true;
    } else if (ev.type === "error") {
      const persisted = await insertJobEvent(supabase, job.id, "error", ev.data);
      safeEnqueue(sseFrame("error", ev.data, persisted?.id));
      await finalizeJob(supabase, job.id, { status: "failed", error: ev.data?.message ?? "nim error" });
      finalPersisted = true;
      break;
    }
  }

  // Defensive: if NIM closed without a 'done' frame, still mark the job completed.
  if (!finalPersisted) {
    await finalizeJob(supabase, job.id, { status: "completed", result: { type: "chat", text: fullText, source: "nvidia-nim", incomplete: true } });
  }
}

async function insertJobEvent(supabase, jobId, eventType, data) {
  try {
    const { data: row, error } = await supabase
      .from("job_events")
      .insert({ job_id: jobId, event_type: eventType, data: encryptJSON(data) })
      .select("id, event_type, data, created_at")
      .single();
    if (error) return null;
    // Return with data decrypted so callers can use it directly.
    return row ? { ...row, data: decryptJSON(row.data) } : null;
  } catch {
    return null;
  }
}

async function finalizeJob(supabase, jobId, { status, result, error }) {
  const now = new Date().toISOString();
  const patch = { status, updated_at: now, completed_at: now };
  if (result !== undefined) patch.result = encryptJSON(result);
  if (error !== undefined) patch.error = error;
  try {
    await supabase.from("jobs").update(patch).eq("id", jobId);
  } catch {
    // best-effort
  }
}
