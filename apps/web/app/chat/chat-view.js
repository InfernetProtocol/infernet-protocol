"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { getConversationKey, encrypt } from "@/lib/nip44";
import { CATALOG } from "@/lib/model-catalog";

// served_models carries raw ids (ollama tags like `dolphin3:8b`, or the full
// `hf:org/repo` pull name for vLLM). Map those to the catalog's friendly names
// so the dropdown is readable; fall back to the raw id.
const MODEL_LABELS = new Map(CATALOG.map((m) => [m.pull, m.name]));
function modelLabel(name) {
  return MODEL_LABELS.get(name) ?? name;
}

const EXAMPLE_PROMPTS = [
  "Explain how Infernet's P2P GPU network scales compared to a centralized data center.",
  "Write a Python function that streams tokens from a local llama.cpp server.",
  "Summarize the tradeoffs between tensor parallelism and pipeline parallelism."
];

/**
 * Chat playground UI.
 *
 * Talks to:
 *   POST /api/chat            → creates a chat job, returns { jobId, provider, streamUrl }
 *   GET  /api/chat/stream/:id → Server-Sent Events with tokens, then 'done' | 'error'
 *
 * State model:
 *   messages: [{ role: 'user'|'assistant'|'system', content, provider?, done? }]
 *   streaming: true while an assistant message is being assembled
 *   currentEventSource: the open EventSource, closed on unmount / done / error
 */
export default function ChatView({ initialModels = [] }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [modelName, setModelName] = useState(initialModels[0]?.name ?? "");
  const [distributed, setDistributed] = useState(false);
  // Web search (lib/web-search.js): the server searches and reads the top
  // pages through TronBrowser; we prepend the result as a system message.
  const [webSearch, setWebSearch] = useState(false);
  useEffect(() => {
    try { setWebSearch(localStorage.getItem("infernet.chat.web") === "1"); } catch { /* storage blocked */ }
  }, []);
  function toggleWebSearch(on) {
    setWebSearch(on);
    try { localStorage.setItem("infernet.chat.web", on ? "1" : "0"); } catch { /* storage blocked */ }
  }
  const [error, setError] = useState(null);
  const [voiceMode, setVoiceMode] = useState(false);
  const [voiceCatalog, setVoiceCatalog] = useState(null);
  const [voiceEngine, setVoiceEngine] = useState("kokoro");
  const [voiceId, setVoiceId] = useState("af_sarah");
  const [voiceLocale, setVoiceLocale] = useState("en-US");
  const [voiceAccent, setVoiceAccent] = useState("");
  const [voiceProfile, setVoiceProfile] = useState("custom");
  const [voicePersona, setVoicePersona] = useState("");
  const [voiceListening, setVoiceListening] = useState(false);
  const [voicePlaying, setVoicePlaying] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("");
  const [voiceError, setVoiceError] = useState(null);
  const [provider, setProvider] = useState(null);
  const [e2eActive, setE2eActive] = useState(false);
  // IPIP-0027 §7: provider's advertised E2E capability, learned from
  // /api/chat/provider before we even POST the job. Drives the warning
  // banner on legacy providers that can't decrypt NIP-44.
  const [providerE2eCapable, setProviderE2eCapable] = useState(true);
  // IPIP-0033: when distributed mode is on, the daemon publishes a
  // `routing` SSE event listing the RPC slices that contributed
  // layers. Persist so the footer can show "Used these N nodes".
  const [routingPeers, setRoutingPeers] = useState(null);
  const [routingProxy, setRoutingProxy] = useState(null);
  const [routingPending, setRoutingPending] = useState(false);
  const [routingNote, setRoutingNote] = useState(null);
  const [daemonLogs, setDaemonLogs] = useState([]);
  // IPIP-0033 Phase 4: per-model RPC census drives whether the
  // "Distribute across all nodes" checkbox is enabled.
  const [rpcCensus, setRpcCensus] = useState(null);

  // IPIP-0033 Phase 4: census the network for live RPC primaries +
  // slices on the picked model. The checkbox is gated on this — we
  // only enable distributed mode when a job submitted right now
  // wouldn't fail-closed on shortfall (matches runRpcProxy's filter).
  useEffect(() => {
    if (!modelName) {
      setRpcCensus(null);
      setDistributed(false);
      return undefined;
    }
    let cancelled = false;
    const url = `/api/v1/rpc/census?model=${encodeURIComponent(modelName)}`;
    fetch(url)
      .then((r) => (r.ok ? r.json() : null))
      .then((b) => {
        if (cancelled || !b) return;
        setRpcCensus(b);
        if (!b.ready) setDistributed(false);
      })
      .catch(() => {
        if (!cancelled) {
          setRpcCensus(null);
          setDistributed(false);
        }
      });
    return () => { cancelled = true; };
  }, [modelName]);

  const esRef = useRef(null);
  const scrollRef = useRef(null);
  const composerRef = useRef(null);
  // Ephemeral secp256k1 keypair generated once per component mount (per session).
  // Generated lazily on first send so the import stays off the critical render path.
  const ephemeralRef = useRef(null);
  // Per-job conversation key: Map<jobId, Uint8Array>
  const convKeysRef = useRef(new Map());
  const streamedTextRef = useRef("");
  const recorderRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const audioRef = useRef(null);
  const audioUrlRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/chat/voice/catalog")
      .then(async (response) => {
        const body = await response.json().catch(() => null);
        if (!response.ok) throw new Error(body?.error ?? "Voice service is unavailable");
        return body;
      })
      .then((catalog) => {
        if (cancelled) return;
        setVoiceCatalog(catalog);
        const firstEngine = catalog?.engines?.[0];
        const firstVoice = firstEngine?.voices?.[0];
        if (firstEngine && firstVoice) {
          setVoiceEngine(firstEngine.id);
          setVoiceId(firstVoice.id);
        }
        setVoiceError(null);
      })
      .catch((err) => {
        if (!cancelled) setVoiceError(err?.message ?? "Voice service is unavailable");
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    return () => {
      if (esRef.current) {
        try { esRef.current.close(); } catch { /* ignore */ }
      }
      if (recorderRef.current?.state === "recording") {
        try { recorderRef.current.stop(); } catch { /* ignore */ }
      }
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      if (audioRef.current) {
        try { audioRef.current.pause(); } catch { /* ignore */ }
      }
      if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    };
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

  async function getOrCreateEphemeralKey() {
    if (!ephemeralRef.current) {
      // Dynamic import keeps noble off the initial bundle chunk.
      const { generateKeyPair } = await import("@infernetprotocol/auth");
      ephemeralRef.current = generateKeyPair();
    }
    return ephemeralRef.current;
  }

  function stopVoicePlayback() {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }
    if (audioUrlRef.current) {
      URL.revokeObjectURL(audioUrlRef.current);
      audioUrlRef.current = null;
    }
    setVoicePlaying(false);
  }

  async function speakAssistant(text) {
    if (!text || !voiceMode) return;
    setVoiceError(null);
    setVoiceStatus("Generating speech on c0mpute CPU nodes…");
    try {
      const response = await fetch("/api/chat/voice/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          engine: voiceEngine,
          voice: voiceId,
          locale: voiceLocale,
          speed: 1,
          persona: voicePersona
        })
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail || body.error || "Speech synthesis failed");
      }
      const blob = await response.blob();
      stopVoicePlayback();
      const url = URL.createObjectURL(blob);
      const player = new Audio(url);
      audioUrlRef.current = url;
      audioRef.current = player;
      player.onended = () => {
        if (audioUrlRef.current === url) stopVoicePlayback();
      };
      player.onerror = () => {
        if (audioUrlRef.current === url) {
          stopVoicePlayback();
          setVoiceError("The returned audio could not be played.");
        }
      };
      await player.play();
      setVoicePlaying(true);
      const worker = response.headers.get("x-c0mpute-worker-peer-id");
      setVoiceStatus(worker ? `Speaking from c0mpute worker ${worker.slice(0, 12)}…` : "Speaking from a c0mpute worker");
    } catch (err) {
      setVoiceStatus("");
      setVoiceError(err?.message ?? "Speech synthesis failed");
    }
  }

  async function toggleVoiceRecording() {
    if (recorderRef.current?.state === "recording") {
      recorderRef.current.stop();
      return;
    }
    setVoiceError(null);
    setVoiceStatus("Waiting for microphone…");
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
        throw new Error("This browser does not support microphone recording.");
      }
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;
      const mimeType = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus"]
        .find((candidate) => MediaRecorder.isTypeSupported(candidate));
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      recorder.ondataavailable = (event) => {
        if (event.data?.size) chunks.push(event.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        recorderRef.current = null;
        setVoiceListening(false);
        const audio = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
        if (!audio.size) {
          setVoiceStatus("");
          setVoiceError("No audio was recorded.");
          return;
        }
        setVoiceStatus("Transcribing on c0mpute CPU nodes…");
        try {
          const response = await fetch("/api/chat/voice/stt", {
            method: "POST",
            headers: { "Content-Type": audio.type || "audio/webm" },
            body: audio
          });
          const body = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(body.detail || body.error || "Speech recognition failed");
          if (!body.text?.trim()) throw new Error("No speech was recognized. Try recording again.");
          setInput((previous) => `${previous}${previous.trim() ? "\n" : ""}${body.text.trim()}`);
          const transcribedBy = body.worker_peer_id
            ? `Transcribed by c0mpute worker ${body.worker_peer_id.slice(0, 12)}…`
            : "Transcription added to the composer.";
          setVoiceStatus(`${transcribedBy} Review the text and press Send for a reply.`);
        } catch (err) {
          setVoiceStatus("");
          setVoiceError(err?.message ?? "Speech recognition failed");
        }
      };
      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        mediaStreamRef.current = null;
        setVoiceListening(false);
        setVoiceStatus("");
        setVoiceError("Microphone recording failed.");
      };
      recorderRef.current = recorder;
      recorder.start();
      setVoiceListening(true);
      setVoiceStatus("Listening — select Stop recording when you’re done.");
    } catch (err) {
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      setVoiceStatus("");
      setVoiceError(err?.message ?? "Could not start microphone recording");
    }
  }

  async function sendMessage() {
    const text = input.trim();
    if (!text || streaming) return;

    setError(null);
    setInput("");
    setRoutingPeers(null);
    setRoutingProxy(null);
    setRoutingPending(false);
    setRoutingNote(null);
    setDaemonLogs([]);
    streamedTextRef.current = "";
    setVoiceError(null);
    setVoiceStatus("");
    const nextUser = { role: "user", content: text };
    // Assistant placeholder we'll append tokens into.
    const pendingAssistant = { role: "assistant", content: "", provider: null, pending: true };
    setMessages((prev) => [...prev, nextUser, pendingAssistant]);
    setStreaming(true);

    let webContext = null;
    if (webSearch) {
      setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, status: "Searching the web…" })));
      try {
        const wr = await fetch("/api/chat/web", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: text })
        });
        const wd = await wr.json().catch(() => null);
        if (wr.ok && wd?.context) {
          webContext = wd.context;
          setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, status: null, sources: wd.sources ?? [] })));
        } else {
          setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, status: null, webNote: wd?.error ?? "Web search failed; answering without it." })));
        }
      } catch {
        setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, status: null, webNote: "Web search failed; answering without it." })));
      }
    }

    const history = [...messages, nextUser].map((m) => ({ role: m.role, content: m.content }));
    // Web results and the selected OpenProfile persona apply to this turn only.
    const turnContext = [];
    if (voiceMode && voicePersona) {
      turnContext.push({
        role: "system",
        content: `Use this speaking persona for the current answer: ${voicePersona} Keep the same facts and answer the user's request directly.`
      });
    }
    if (webContext) turnContext.push({ role: "system", content: webContext });
    const outgoingMessages = [
      ...history.slice(0, -1),
      ...turnContext,
      history[history.length - 1]
    ];

    // Attempt E2E encryption: pre-select a provider and get their pubkey.
    let postBody = { messages: outgoingMessages, modelName, maxTokens: 512, temperature: 0.7, distributed };
    let currentJobConvKey = null;
    try {
      const provRes = await fetch(`/api/chat/provider${modelName ? `?modelName=${encodeURIComponent(modelName)}` : ""}`);
      if (provRes.ok) {
        const provData = await provRes.json();
        setProviderE2eCapable(provData.e2eCapable !== false);
        // IPIP-0028: prefer model key over node key when available.
        const pubkeyToUse = provData.modelPubkey ?? provData.providerPubkey ?? null;
        if (pubkeyToUse) {
          const { privateKey, publicKey } = await getOrCreateEphemeralKey();
          const convKey = getConversationKey(privateKey, pubkeyToUse);
          currentJobConvKey = convKey;
          const encryptedMessages = encrypt(convKey, JSON.stringify(outgoingMessages));
          postBody = {
            encryptedMessages,
            clientPubkey: publicKey,
            providerId: provData.providerId,
            ...(provData.modelPubkey ? { modelPubkey: provData.modelPubkey } : {}),
            modelName,
            maxTokens: 512,
            temperature: 0.7
          };
        }
      }
    } catch {
      // E2E setup failed — fall back to plaintext (no-op, postBody already set)
    }

    let res;
    try {
      res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(postBody)
      });
    } catch (e) {
      failPending(`Network error: ${e?.message ?? e}`);
      return;
    }

    if (!res.ok) {
      let detail = "";
      try { detail = (await res.json())?.error ?? ""; } catch { /* ignore */ }
      failPending(`Server returned ${res.status}${detail ? `: ${detail}` : ""}`);
      return;
    }

    const { jobId, streamUrl, provider: pickedProvider } = await res.json();
    setProvider(pickedProvider);

    // Store conversation key for this job so the SSE handlers can decrypt.
    if (currentJobConvKey) {
      convKeysRef.current.set(jobId, currentJobConvKey);
      setE2eActive(true);
    } else {
      setE2eActive(false);
    }

    const es = new EventSource(streamUrl);
    esRef.current = es;

    es.addEventListener("meta", (e) => {
      try {
        const data = JSON.parse(e.data);
        setMessages((prev) => updateLastAssistant(prev, (m) => ({
          ...m,
          provider: {
            nodeId: data.provider_node_id,
            name: data.provider_name,
            model: data.model
          }
        })));
      } catch { /* ignore */ }
    });

    es.addEventListener("routing", (e) => {
      try {
        const data = JSON.parse(e.data);
        if (Array.isArray(data?.peers)) setRoutingPeers(data.peers);
        if (data?.proxy) setRoutingProxy(data.proxy);
        setRoutingPending(Boolean(data?.pending));
        setRoutingNote(typeof data?.note === "string" ? data.note : null);
      } catch { /* ignore */ }
    });

    es.addEventListener("log", (e) => {
      try {
        const data = JSON.parse(e.data);
        const line = formatDaemonLogLine(data);
        if (line) setDaemonLogs((prev) => prev.concat([{ at: Date.now(), text: line }]).slice(-50));
      } catch { /* ignore */ }
    });

    es.addEventListener("token", (e) => {
      try {
        const data = JSON.parse(e.data);
        const text = data.text ?? "";
        if (text) {
          streamedTextRef.current += text;
          setMessages((prev) => updateLastAssistant(prev, (m) => ({
            ...m,
            content: (m.content ?? "") + text
          })));
        }
      } catch { /* ignore */ }
    });

    es.addEventListener("done", () => {
      setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, pending: false, done: true })));
      setStreaming(false);
      if (voiceMode) void speakAssistant(streamedTextRef.current.trim());
      convKeysRef.current.delete(jobId);
      try { es.close(); } catch { /* ignore */ }
      esRef.current = null;
    });

    es.addEventListener("error", (e) => {
      let msg = null;
      try {
        const data = JSON.parse(e.data);
        msg = data?.message ?? null;
      } catch { /* native EventSource error has no .data — we'll fetch */ }
      if (msg) {
        failPending(msg);
      } else {
        // Typed "error" event with no payload — pull persisted reason.
        fetchPersistedFailure(jobId, "Stream error");
      }
    });

    // If the browser closes the EventSource on network loss, surface
    // whatever the daemon recorded server-side. Without this fetch,
    // the playground used to show "Connection to the provider was
    // lost" even when the daemon had already written a specific
    // error to job_events.
    es.onerror = () => {
      if (streaming && esRef.current === es) {
        fetchPersistedFailure(jobId, "Connection to the provider was lost.");
      }
    };
  }

  async function fetchPersistedFailure(jobId, fallback) {
    try {
      const res = await fetch(`/api/chat/${encodeURIComponent(jobId)}/status`);
      if (res.ok) {
        const body = await res.json();
        // Job completed successfully — connection dropped after done was written
        // but before the browser received it. Mark done instead of failing.
        if (body?.status === "completed") {
          setStreaming(false);
          setMessages((prev) => updateLastAssistant(prev, (m) => ({ ...m, pending: false, done: true })));
          if (esRef.current) {
            try { esRef.current.close(); } catch { /* ignore */ }
            esRef.current = null;
          }
          return;
        }
        const real = body?.latest_error_message ?? body?.error ?? null;
        if (real) {
          // Append diagnostic context so the user sees WHICH node/model + how
          // far the stream got, instead of just a one-liner. Folded into the
          // error display so it's also copy-pasteable into a bug report.
          const ctx = [];
          if (body.provider_id) ctx.push(`node ${String(body.provider_id).slice(0, 8)}`);
          if (body.model_name) ctx.push(body.model_name);
          if (body.token_count) ctx.push(`${body.token_count} tokens streamed`);
          ctx.push(`job ${String(jobId).slice(0, 8)}`);
          failPending(`${real}\n(${ctx.join(" · ")})`);
          return;
        }
      }
    } catch { /* ignore */ }
    failPending(fallback);
  }

  function failPending(message) {
    setError(message);
    setStreaming(false);
    setMessages((prev) => updateLastAssistant(prev, (m) => ({
      ...m,
      pending: false,
      failed: true,
      content: m.content || `⚠️ ${message}`
    })));
    if (esRef.current) {
      try { esRef.current.close(); } catch { /* ignore */ }
      esRef.current = null;
    }
  }

  function onComposerKey(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  }

  function clearConversation() {
    stopVoicePlayback();
    setMessages([]);
    setError(null);
    setProvider(null);
    setE2eActive(false);
    setProviderE2eCapable(true);
    setRoutingPeers(null);
    setRoutingProxy(null);
    setRoutingPending(false);
    setRoutingNote(null);
    setDaemonLogs([]);
    ephemeralRef.current = null; // fresh keypair for next session
    convKeysRef.current.clear();
  }

  const latestAssistantText = [...messages].reverse()
    .find((message) => message.role === "assistant" && message.done && !message.failed)?.content ?? "";

  return (
    <main className="min-h-screen px-4 py-6 sm:px-6 lg:px-10">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-4">
        <header className="flex flex-col gap-3 rounded-[2rem] border border-white/10 bg-[var(--panel)] p-6 shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur sm:flex-row sm:items-end sm:justify-between">
          <div>
            <p className="text-xs uppercase tracking-[0.35em] text-[var(--accent)]">Infernet Playground</p>
            <h1 className="mt-1 text-3xl font-semibold tracking-tight text-white">Chat on the P2P GPU network</h1>
            <p className="mt-2 max-w-2xl text-sm text-[var(--muted)]">
              Every message you send is routed to a random live GPU node running the <code>infernet</code> CLI. No data center in the middle — the network scales as providers come online.
            </p>
          </div>
          <div className="flex flex-col items-end gap-2">
            <label className="text-xs uppercase tracking-[0.25em] text-[var(--muted)]">Model</label>
            <select
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              disabled={streaming}
              className="rounded-full border border-[var(--line)] bg-[var(--panel-strong)] px-4 py-2 text-sm text-white outline-none disabled:opacity-50"
            >
              <option value="">(any available)</option>
              {initialModels.map((m) => (
                <option key={m.id} value={m.name} title={m.name}>
                  {modelLabel(m.name)}
                </option>
              ))}
            </select>
            <DistributedCheckbox
              modelName={modelName}
              streaming={streaming}
              checked={distributed}
              onChange={(v) => setDistributed(v)}
              census={rpcCensus}
            />
            <label
              className="flex items-center gap-2 text-xs text-[var(--muted)]"
              title="Searches the web and reads the top pages with TronBrowser, then gives the results to the model with numbered sources. Only your question is sent to the search, never the rest of the chat."
            >
              <input
                type="checkbox"
                checked={webSearch}
                disabled={streaming}
                onChange={(e) => toggleWebSearch(e.target.checked)}
                className="accent-[var(--accent)]"
              />
              Search the web
            </label>
          </div>
        </header>

        <section
          ref={scrollRef}
          className="flex-1 min-h-[50vh] max-h-[65vh] overflow-y-auto rounded-[2rem] border border-white/10 bg-[var(--panel)] p-6 shadow-inner"
        >
          {messages.length === 0 ? (
            <EmptyState onPick={(t) => setInput(t)} />
          ) : (
            <div className="flex flex-col gap-5">
              {messages.map((m, i) => (
                <Bubble key={i} message={m} />
              ))}
            </div>
          )}
        </section>

        {error ? (
          <div className="rounded-2xl border border-[var(--warn)]/40 bg-[var(--warn)]/10 px-4 py-3 text-sm text-[var(--warn)]">
            {error}
          </div>
        ) : null}

        <E2eIndicator active={e2eActive} provider={provider} capable={providerE2eCapable} streaming={streaming} />
        <DistributedRouting
          active={distributed}
          peers={routingPeers}
          proxy={routingProxy}
          pending={routingPending}
          note={routingNote}
          logs={daemonLogs}
          streaming={streaming}
        />

        <div role="group" aria-label="Chat composer" className="rounded-[2rem] border border-white/10 bg-[var(--panel)] p-4 shadow-[0_20px_80px_rgba(0,0,0,0.25)]">
          <textarea
            ref={composerRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onComposerKey}
            placeholder={streaming ? "Streaming from a provider…" : "Ask anything. Shift+Enter for a newline."}
            rows={2}
            disabled={streaming}
            className="w-full resize-none rounded-xl border border-[var(--line)] bg-[var(--panel-strong)] px-4 py-3 text-sm text-white outline-none placeholder:text-[var(--muted)]/70 disabled:opacity-60"
          />
          <div className="mt-3 rounded-xl border border-white/10 bg-black/15 px-3 py-2">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <label className="flex items-center gap-2 text-xs text-[var(--muted)]">
                <input
                  type="checkbox"
                  checked={voiceMode}
                  onChange={(event) => {
                    setVoiceMode(event.target.checked);
                    if (!event.target.checked) stopVoicePlayback();
                  }}
                  className="accent-[var(--accent)]"
                />
                Voice mode
              </label>
              {voiceMode ? (
                <>
                  <select
                    aria-label="Agent voice profile"
                    value={voiceProfile}
                    onChange={(event) => {
                      const selected = event.target.value;
                      setVoiceProfile(selected);
                      const profile = voiceCatalog?.agent_profiles?.find((item) => item.slug === selected);
                      if (profile) {
                        setVoiceEngine(profile.engine);
                        setVoiceId(profile.voice);
                        setVoiceLocale(profile.locale || "en-US");
                        setVoiceAccent(profile.accent || "");
                        setVoicePersona(profile.persona);
                      } else {
                        setVoiceLocale("en-US");
                        setVoiceAccent("");
                        setVoicePersona("");
                      }
                    }}
                    disabled={!voiceCatalog || streaming || voiceListening}
                    className="rounded-full border border-[var(--line)] bg-[var(--panel-strong)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
                  >
                    <option value="custom">Custom voice</option>
                    {(voiceCatalog?.agent_profiles ?? []).map((profile) => (
                      <option key={profile.slug} value={profile.slug}>@{profile.slug} · {profile.voice_gender} · {profile.locale}</option>
                    ))}
                  </select>
                  <select
                    aria-label="TTS engine"
                    value={voiceEngine}
                    onChange={(event) => {
                      const nextEngine = event.target.value;
                      const voices = voiceCatalog?.engines?.find((item) => item.id === nextEngine)?.voices ?? [];
                      setVoiceEngine(nextEngine);
                      setVoiceId(voices[0]?.id ?? "");
                      setVoiceProfile("custom");
                      setVoiceLocale("en-US");
                      setVoiceAccent("");
                      setVoicePersona("");
                    }}
                    disabled={!voiceCatalog || streaming || voiceListening}
                    className="rounded-full border border-[var(--line)] bg-[var(--panel-strong)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
                  >
                    {(voiceCatalog?.engines ?? []).map((engine) => (
                      <option key={engine.id} value={engine.id}>{engine.id}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Voice"
                    value={voiceId}
                    onChange={(event) => {
                      setVoiceId(event.target.value);
                      setVoiceProfile("custom");
                      setVoiceLocale("en-US");
                      setVoiceAccent("");
                      setVoicePersona("");
                    }}
                    disabled={!voiceCatalog || streaming || voiceListening}
                    className="rounded-full border border-[var(--line)] bg-[var(--panel-strong)] px-3 py-1.5 text-xs text-white disabled:opacity-50"
                  >
                    {(voiceCatalog?.engines?.find((item) => item.id === voiceEngine)?.voices ?? []).map((voice) => (
                      <option key={voice.id} value={voice.id}>{voice.label} · {voice.presentation}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={toggleVoiceRecording}
                    disabled={!voiceCatalog || streaming}
                    className={`rounded-full border px-3 py-1.5 text-xs transition disabled:opacity-40 ${voiceListening ? "border-amber-300/50 text-amber-200" : "border-[var(--line)] text-white hover:border-[var(--accent)]"}`}
                    title="Your recording is transcribed by a c0mpute CPU worker and added to the composer for review."
                  >
                    {voiceListening ? "Stop recording" : "Speak input"}
                  </button>
                  <button
                    type="button"
                    onClick={() => speakAssistant(latestAssistantText)}
                    disabled={!voiceCatalog || !latestAssistantText || streaming || voiceListening || voicePlaying}
                    className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs text-white transition hover:border-[var(--accent)] disabled:opacity-40"
                  >
                    Play last answer
                  </button>
                  {voicePlaying ? (
                    <button
                      type="button"
                      onClick={stopVoicePlayback}
                      className="rounded-full border border-[var(--line)] px-3 py-1.5 text-xs text-white transition hover:border-[var(--accent)]"
                    >
                      Stop audio
                    </button>
                  ) : null}
                </>
              ) : null}
            </div>
            {voiceMode ? (
              <>
                <p className="mt-2 text-[10px] text-[var(--muted)]">
                  Assistant replies use the selected persona and are spoken automatically. Microphone input is transcribed into the composer; review it before sending.
                  {voicePersona ? ` Persona: ${voicePersona}` : ""}
                  {voiceAccent ? ` Accent: ${voiceAccent}` : ""}
                </p>
                {voiceStatus ? <p aria-live="polite" className="mt-1 text-[10px] text-emerald-200">{voiceStatus}</p> : null}
                {voiceError ? <p role="status" className="mt-1 text-[10px] text-amber-200">{voiceError}</p> : null}
              </>
            ) : null}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <div className="text-xs text-[var(--muted)]">
              {provider ? (
                <>
                  {e2eActive && <span className="mr-1 text-green-400" title="End-to-end encrypted">&#128274;</span>}
                  Running on <span className="text-white">{provider.name ?? provider.nodeId}</span>{provider.gpuModel ? ` · ${provider.gpuModel}` : ""}.
                </>
              ) : (
                <>Public playground — rate limited per IP. No sign-in required.</>
              )}
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={clearConversation}
                disabled={streaming || messages.length === 0}
                className="rounded-full border border-[var(--line)] px-4 py-2 text-xs uppercase tracking-[0.2em] text-white transition hover:border-[var(--accent)] hover:bg-white/5 disabled:opacity-40"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={sendMessage}
                disabled={streaming || voiceListening || input.trim() === ""}
                className="rounded-full bg-[var(--accent-strong)] px-5 py-2 text-xs font-semibold uppercase tracking-[0.2em] text-black transition hover:brightness-110 disabled:opacity-40"
              >
                {streaming ? "…" : "Send"}
              </button>
            </div>
          </div>
        </div>
      </div>
    </main>
  );
}

/**
 * IPIP-0033 Phase 4 — "Distribute across all nodes" checkbox driven
 * by /api/v1/rpc/census. Three states:
 *
 *   1. census loading → disabled, "checking…" hint
 *   2. census ready → enabled, normal toggle
 *   3. census not ready → disabled, shortfall hint with live counts
 */
function DistributedCheckbox({ modelName, streaming, checked, onChange, census }) {
  const loaded = census && census.model === modelName;
  const ready = !!loaded && census.ready === true;

  let label;
  let title;
  if (!modelName) {
    label = "Pick a model first";
    title = "Pick a specific model from the dropdown to see if distributed mode is available.";
  } else if (!loaded) {
    label = <span className="text-[10px] text-[var(--muted)]">checking…</span>;
    title = "Querying the network for active RPC primaries + slices…";
  } else if (ready) {
    label = (
      <span className="text-[10px] text-emerald-300">
        {census.primaries} primary · {census.slices} slices live
      </span>
    );
    title = "Splits the inference across multiple llama.cpp RPC slices (IPIP-0033). Higher latency, but lets you run models too big for any single node.";
  } else {
    const need = census.min_slices ?? 2;
    label = (
      <span className="text-[10px] text-amber-300">
        {census.primaries} primary · {census.slices}/{need} slices
      </span>
    );
    title = `Distributed mode needs ≥1 primary and ≥${need} live RPC slices for ${modelName}. Operators host slices via \`infernet inference serve --backend rpc --model ${modelName}\` (IPIP-0033).`;
  }

  const disabled = streaming || !ready;

  return (
    <label
      className={`flex items-center gap-2 text-xs ${disabled ? "cursor-not-allowed text-[var(--muted)] opacity-60" : "cursor-pointer text-[var(--muted)] hover:text-white"}`}
      title={title}
    >
      <input
        type="checkbox"
        checked={ready ? checked : false}
        onChange={(e) => ready && onChange(e.target.checked)}
        disabled={disabled}
        className="h-3.5 w-3.5 rounded border-white/30 bg-transparent text-[var(--accent)] disabled:opacity-50"
      />
      <span>Distribute across all nodes {label}</span>
    </label>
  );
}

/**
 * IPIP-0027 §8 — E2E status indicator. Three states:
 *   1. active   → green "🔒 End-to-end encrypted · Provider: <name>"
 *   2. capable  → silent (no banner needed; the lock will appear on send)
 *   3. !capable → amber warning explaining the prompt is server-readable
 */
function E2eIndicator({ active, provider, capable, streaming }) {
  if (active && provider) {
    const name = provider.name ?? provider.nodeId ?? "node";
    return (
      <div className="flex items-center gap-2 rounded-2xl border border-emerald-400/30 bg-emerald-400/10 px-4 py-2 text-xs text-emerald-200">
        <span aria-hidden="true">&#128274;</span>
        <span>
          End-to-end encrypted · Provider: <span className="font-semibold text-white">{name}</span>
        </span>
      </div>
    );
  }
  if (!capable && (streaming || provider)) {
    return (
      <div className="rounded-2xl border border-amber-400/30 bg-amber-400/10 px-4 py-2 text-xs text-amber-100">
        <span className="mr-1" aria-hidden="true">&#9888;</span>
        This provider does not support E2E encryption. Your prompt is readable by Infernet's control plane.
      </div>
    );
  }
  return null;
}

/**
 * IPIP-0031 — verification panel for distributed mode. Lets the user
 * confirm the job is actually fanning out across operators rather
 * than running on a single proxy. States:
 *
 *   1. inactive (checkbox off, no proxy known) → don't render
 *   2. proxy known, peers pending → show entry node + "awaiting…"
 *   3. proxy known, no peers reported → entry node + explanatory note
 *   4. peers received → list each contributing operator
 *
 * Also surfaces a rolling daemon log (last 50 lines of stderr +
 * diagnostics) so the user can see what the entry node is doing.
 */
function DistributedRouting({ active, peers, proxy, pending, note, logs, streaming }) {
  if (!active) return null;
  const hasPeers = Array.isArray(peers) && peers.length > 0;
  const showStreamingPlaceholder = !proxy && streaming;
  if (!proxy && !showStreamingPlaceholder && !hasPeers) return null;

  const headline = hasPeers
    ? `Distributed across ${peers.length} node${peers.length === 1 ? "" : "s"}`
    : pending
      ? "Connecting to swarm…"
      : "Distributed mode";

  return (
    <div className="rounded-2xl border border-[var(--accent)]/30 bg-[var(--accent)]/5 px-4 py-3 text-xs text-[var(--muted)]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">
          {headline}
        </span>
        {proxy ? (
          <span>
            entry: <span className="font-mono text-white">{proxy.name ?? shortPubkey(proxy.pubkey) ?? "node"}</span>
            {proxy.pubkey ? <span className="ml-1 opacity-60">· {shortPubkey(proxy.pubkey)}</span> : null}
          </span>
        ) : null}
      </div>

      {hasPeers ? (
        <ul className="mt-2 grid gap-1 sm:grid-cols-2">
          {peers.map((p, i) => (
            <li key={(p.peer_id ?? "") + i} className="flex items-baseline justify-between gap-3">
              <span className="text-white">
                {p.name ? p.name : p.pubkey ? shortPubkey(p.pubkey) : (p.peer_id ? p.peer_id.slice(0, 12) + "…" : "(unknown peer)")}
              </span>
              <span>
                {p.blocks ? `${p.blocks} layer${p.blocks === 1 ? "" : "s"}` : "—"}
                {p.peer_id ? <span className="ml-2 font-mono text-[10px] opacity-60">{p.peer_id.slice(0, 8)}…</span> : null}
              </span>
            </li>
          ))}
        </ul>
      ) : pending ? (
        <p className="mt-2">Awaiting layer routing from the entry node…</p>
      ) : note ? (
        <p className="mt-2 text-amber-200">{note}</p>
      ) : null}

      {logs && logs.length > 0 ? (
        <details className="mt-3" open>
          <summary className="cursor-pointer text-[10px] uppercase tracking-[0.2em] text-[var(--muted)] hover:text-white">
            Daemon log ({logs.length})
          </summary>
          <pre className="mt-2 max-h-40 overflow-y-auto rounded-md border border-white/10 bg-black/40 p-2 font-mono text-[10px] leading-snug text-[var(--muted)]">
            {logs.map((l, i) => (
              <div key={i}>{l.text}</div>
            ))}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

/**
 * Squash a daemon log frame into a single human-readable line. The
 * llama.cpp RPC primary emits stderr text plus structured
 * `{ event: "log", warn: "..." }` and per-peer lifecycle frames;
 * the daemon HTTP wrapper also emits `{ exit_code }` on child exit.
 * Normalize all of those into a single line.
 */
function formatDaemonLogLine(data) {
  if (!data || typeof data !== "object") return null;
  if (typeof data.stderr === "string") return data.stderr.trimEnd();
  if (typeof data.raw === "string") return data.raw;
  if (typeof data.warn === "string") return `WARN ${data.warn}`;
  if (typeof data.message === "string") return data.message;
  if (typeof data.exit_code === "number") return `daemon child exited (code=${data.exit_code})`;
  // Unknown shape — render as compact JSON so something useful surfaces.
  try { return JSON.stringify(data); } catch { return null; }
}

function shortPubkey(k) {
  if (!k || typeof k !== "string") return null;
  if (k.length <= 14) return k;
  return `${k.slice(0, 8)}…${k.slice(-4)}`;
}

function updateLastAssistant(list, mutator) {
  const next = list.slice();
  for (let i = next.length - 1; i >= 0; i -= 1) {
    if (next[i].role === "assistant") {
      next[i] = mutator(next[i]);
      return next;
    }
  }
  return next;
}

const MARKDOWN_COMPONENTS = {
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent)] underline decoration-white/30 underline-offset-2 hover:decoration-current">
      {children}
    </a>
  ),
  h1: ({ children }) => <h1 className="mb-3 mt-5 text-2xl font-semibold leading-tight first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-5 text-xl font-semibold leading-tight first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-lg font-semibold leading-tight first:mt-0">{children}</h3>,
  h4: ({ children }) => <h4 className="mb-2 mt-4 font-semibold leading-tight first:mt-0">{children}</h4>,
  p: ({ children }) => <p className="my-2 whitespace-normal leading-6 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-3 list-disc space-y-1 pl-6">{children}</ul>,
  ol: ({ children }) => <ol className="my-3 list-decimal space-y-1 pl-6">{children}</ol>,
  li: ({ children }) => <li className="pl-1">{children}</li>,
  blockquote: ({ children }) => <blockquote className="my-3 border-l-2 border-[var(--accent)]/60 pl-4 text-[var(--muted)]">{children}</blockquote>,
  hr: () => <hr className="my-4 border-white/15" />,
  pre: ({ children }) => <pre className="my-3 max-w-full overflow-x-auto rounded-xl border border-white/10 bg-black/30 p-4 text-xs leading-5">{children}</pre>,
  code: ({ className, children }) => (
    <code className={className ? "font-mono text-[0.9em]" : "rounded bg-black/30 px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--accent)]"}>
      {children}
    </code>
  ),
  table: ({ children }) => (
    <div className="my-3 max-w-full overflow-x-auto">
      <table className="w-full border-collapse text-left text-xs">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="border-b border-white/20">{children}</thead>,
  th: ({ children }) => <th className="px-3 py-2 font-semibold">{children}</th>,
  td: ({ children }) => <td className="border-b border-white/10 px-3 py-2 align-top">{children}</td>
};

function MarkdownContent({ text }) {
  return (
    <div className="break-words text-sm leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

function CopyButton({ text, label = "Copy Markdown" }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available (non-HTTPS context)
    }
  }, [text]);

  return (
    <button
      type="button"
      onClick={handleCopy}
      title={label}
      aria-label={copied ? "Copied to clipboard" : label}
      className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-white"
    >
      {copied ? "Copied" : label}
    </button>
  );
}

function Readm3Button({ text }) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const openReadm3 = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    let tab = null;
    try {
      // Open synchronously so popup blockers do not treat the eventual API
      // response as an unsolicited window. Keep the WindowProxy so it can be
      // navigated after the paste API replies, then drop its opener reference.
      tab = window.open("about:blank", "_blank");
      if (tab) tab.opener = null;
      const res = await fetch("/api/chat/readm3", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ source: text, title: "infernet-answer.md" })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || typeof body.url !== "string") {
        throw new Error(body.error ?? "Readm3 could not create the document");
      }
      const pasteUrl = new URL(body.url);
      if (pasteUrl.protocol !== "https:" || pasteUrl.hostname !== "readm3.com") {
        throw new Error("Readm3 returned an invalid pastie URL");
      }
      setUrl(pasteUrl.href);
      if (tab && !tab.closed) tab.location.replace(pasteUrl.href);
    } catch (err) {
      if (tab && !tab.closed) tab.close();
      setError(err?.message ?? "Readm3 could not create the pastie");
    } finally {
      setBusy(false);
    }
  }, [busy, text]);

  return (
    <span className="inline-flex items-center gap-2">
      {url ? (
        <a href={url} target="_blank" rel="noopener noreferrer" title="Open this Markdown pastie in readm3.com" className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-white">
          Readm3 ↗
        </a>
      ) : (
        <button
          type="button"
          onClick={openReadm3}
          disabled={busy}
          title="Create and open a Markdown pastie in readm3.com"
          className="rounded-md border border-[var(--line)] bg-[var(--panel)] px-2 py-0.5 text-[10px] uppercase tracking-[0.15em] text-[var(--muted)] transition hover:border-[var(--accent)] hover:text-white disabled:opacity-60"
        >
          {busy ? "Opening…" : "Readm3 ↗"}
        </button>
      )}
      {error ? <span role="status" className="text-[10px] text-[var(--warn)]">{error}</span> : null}
    </span>
  );
}

function Bubble({ message }) {
  const { role, content, provider, pending, failed, status, sources, webNote } = message;
  const isUser = role === "user";
  return (
    <div className={`flex ${isUser ? "justify-end" : "justify-start"}`}>
      <div
        className={[
          "max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-4 py-3 text-sm leading-6",
          isUser
            ? "bg-[var(--accent-strong)] text-black shadow-[0_8px_24px_rgba(20,184,166,0.25)]"
            : "border border-[var(--line)] bg-[var(--panel-strong)] text-white"
        ].join(" ")}
      >
        {!isUser && provider ? (
          <p className="mb-2 text-[10px] uppercase tracking-[0.2em] text-[var(--muted)]">
            {provider.name ?? provider.nodeId}{provider.model ? ` · ${provider.model}` : ""}
          </p>
        ) : null}
        {content ? (
          isUser ? content : <MarkdownContent text={content} />
        ) : pending ? (status ? <span className="text-xs text-[var(--muted)]">{status}</span> : <TypingDots />) : null}
        {failed ? <span className="ml-2 text-xs text-[var(--warn)]">failed</span> : null}
        {!isUser && webNote ? <p className="mt-2 text-xs text-[var(--warn)]">{webNote}</p> : null}
        {!isUser && sources?.length ? (
          <ol className="mt-3 space-y-1 border-t border-white/10 pt-2 text-xs text-[var(--muted)]">
            {sources.map((s) => (
              <li key={s.n} className="truncate">
                [{s.n}]{" "}
                <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" className="text-[var(--accent)] hover:underline">
                  {s.title}
                </a>
                {s.read ? null : <span title="Only the search snippet was used"> · snippet</span>}
              </li>
            ))}
          </ol>
        ) : null}
        {!isUser && content && !pending ? (
          <div className="mt-2 flex justify-end gap-2">
            <CopyButton text={content} />
            <Readm3Button text={content} />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function TypingDots() {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--muted)]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--muted)] [animation-delay:120ms]" />
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-[var(--muted)] [animation-delay:240ms]" />
    </span>
  );
}

function EmptyState({ onPick }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 py-10 text-center">
      <div>
        <p className="text-sm uppercase tracking-[0.35em] text-[var(--accent)]">Decentralized inference</p>
        <h2 className="mt-3 text-2xl font-semibold text-white">Ask the network anything</h2>
        <p className="mt-2 max-w-md text-sm text-[var(--muted)]">
          Your prompt hits a live <code>infernet</code> provider over Supabase + Server-Sent Events, and tokens stream back as they're generated.
        </p>
      </div>
      <div className="grid w-full max-w-2xl gap-2 sm:grid-cols-1">
        {EXAMPLE_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            onClick={() => onPick(prompt)}
            className="rounded-2xl border border-[var(--line)] bg-[var(--panel-strong)] px-4 py-3 text-left text-sm text-white transition hover:border-[var(--accent)] hover:bg-white/5"
          >
            {prompt}
          </button>
        ))}
      </div>
    </div>
  );
}
