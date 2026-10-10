/**
 * `infernet model` — model lifecycle (Ollama + HuggingFace).
 *
 * Distinct from the node-lifecycle `infernet update` / `infernet remove`:
 * those manage how this node is registered with the control plane.
 * This command manages which models the node has on disk and which one
 * the engine uses by default.
 *
 *   infernet model list
 *   infernet model list --node <id>      a remote node's advertised models
 *   infernet model pull <name>           Ollama name or hf:org/repo
 *   infernet model remove <name>
 *   infernet model use <name>
 *   infernet model show
 *
 * Ollama models go through the local Ollama daemon.
 * HuggingFace models (hf: prefix) are downloaded via huggingface-cli
 * and are intended for vLLM / SGLang serving.
 */

import { spawn } from "node:child_process";
import { loadConfig, saveConfig, getConfigPath } from "../lib/config.js";
import { checkModelFits, detectCapacity } from "../lib/model-fit.js";
import {
    resolveHfToken,
    fetchHfModelInfo,
    downloadHfModel,
} from "../lib/hf-model.js";
import { recommendModels } from "../lib/recommender.js";
import { resolveClientOptions } from "../lib/reservations-client.js";
import { fetchNodeModels, formatNodeModels } from "../lib/node-models.js";

const HELP = `infernet model — manage models served by this node

Usage:
  infernet model list                    List models pulled locally.
  infernet model list --node <id>        List the models a remote node advertises
                                         (node id or row id, public nodes only).
                                           --url <control-plane>   default infernetprotocol.com
  infernet model recommend [flags]       Recommend models for your hardware.
                                           --use-case <chat|coding|study|agents|uncensored|vision>
                                           --uncensored
                                           --install            install the top pick
                                           --install-all        install everything that fits on disk
  infernet model info hf:<org>/<repo>    Inspect a HuggingFace model — size,
                                         architecture, VRAM estimates — without
                                         downloading anything.
  infernet model pull <name>             Pull an Ollama model (e.g. qwen2.5:7b).
  infernet model pull hf:<org>/<repo>    Download a HuggingFace model (vLLM/SGLang).
  infernet model remove <name>           Delete a pulled model.
  infernet model use <name>              Set this as the default for the engine.
  infernet model show                    Show the engine default + Ollama host.

Examples:
  infernet model info hf:Qwen/Qwen2.5-32B-Instruct
  infernet model pull qwen2.5:7b
  infernet model pull hf:NousResearch/Hermes-3-Llama-3.1-8B
  infernet model use qwen2.5:7b
  infernet model list

Defaults are stored in ~/.config/infernet/config.json under engine.*
and consumed by the daemon and \`infernet chat\`.
`;

const DEFAULT_HOST = "http://localhost:11434";

function resolveHost(config) {
    return (
        config?.engine?.ollamaHost ??
        process.env.OLLAMA_HOST ??
        DEFAULT_HOST
    );
}

async function fetchTags(host) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
        const res = await fetch(new URL("/api/tags", host), { signal: ctrl.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);
        return await res.json();
    } catch (err) {
        clearTimeout(t);
        throw new Error(
            `Ollama not reachable at ${host} (${err?.message ?? err}). Run \`infernet setup\` first.`
        );
    }
}

async function deleteModel(host, name) {
    const res = await fetch(new URL("/api/delete", host), {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Ollama HTTP ${res.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`);
    }
}



function streamPull(name) {
    return new Promise((resolve, reject) => {
        // Use the local `ollama` CLI for the pull because it gives a much
        // nicer progress UI than streaming JSON from /api/pull. The
        // /api/pull endpoint is fine for programmatic use; for an
        // interactive operator, ollama's own bar is the right tool.
        const child = spawn("ollama", ["pull", name], { stdio: "inherit" });
        child.on("exit", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`ollama pull exited ${code}`));
        });
        child.on("error", reject);
    });
}

async function cmdList(host) {
    const cfg = await loadConfig();
    const active = cfg?.engine?.model ?? null;
    const hfModels = cfg?.engine?.hfModels ?? [];

    // Ollama models
    let ollamaModels = [];
    try {
        const tags = await fetchTags(host);
        ollamaModels = tags.models ?? [];
    } catch {
        // Ollama not running — still show HF models
    }

    const allEmpty = ollamaModels.length === 0 && hfModels.length === 0;
    if (allEmpty) {
        process.stdout.write("(no models pulled — try `infernet model pull qwen2.5:7b` or `infernet model pull hf:org/repo`)\n");
        return 0;
    }

    const allNames = [
        ...ollamaModels.map(m => m.name ?? ""),
        ...hfModels.map(m => m.repoId),
    ];
    const nameWidth = Math.max(4, ...allNames.map(n => n.length));
    process.stdout.write(`${"NAME".padEnd(nameWidth)}  SIZE        BACKEND   ACTIVE\n`);

    for (const m of ollamaModels) {
        const size = typeof m.size === "number"
            ? `${(m.size / 1024 / 1024 / 1024).toFixed(1)} GB`
            : "?";
        const isActive = m.name === active ? "  *" : "";
        process.stdout.write(`${(m.name ?? "").padEnd(nameWidth)}  ${size.padEnd(10)}  ollama  ${isActive}\n`);
    }

    for (const m of hfModels) {
        const size = m.sizeGb ? `${m.sizeGb} GB` : "?";
        const isActive = m.repoId === active ? "  *" : "";
        process.stdout.write(`${m.repoId.padEnd(nameWidth)}  ${size.padEnd(10)}  vllm    ${isActive}\n`);
    }

    if (active) {
        process.stdout.write(`\nactive: ${active}\n`);
    }
    return 0;
}

async function cmdListNode(nodeId, args) {
    if (!nodeId || nodeId === true) {
        process.stderr.write("error: --node needs a node id\n");
        return 2;
    }
    const { baseUrl } = await resolveClientOptions({ url: args.get("url") });
    const node = await fetchNodeModels({ baseUrl, nodeId: String(nodeId) });
    if (args.has("json")) {
        process.stdout.write(JSON.stringify(node, null, 2) + "\n");
    } else {
        process.stdout.write(formatNodeModels(node));
    }
    return 0;
}

async function cmdRecommend(args) {
    const useCase = args.get("use-case") ?? args.get("for") ?? null;
    const uncensoredOnly = args.has("uncensored");
    const limit = Number.parseInt(args.get("limit") ?? "5", 10);
    const wantInstall = args.has("install") || args.has("i");
    const wantInstallAll = args.has("install-all");

    const cap = await detectCapacity();
    const vramGb = cap.vram_gb;
    const ramGb = cap.ram_gb;

    process.stdout.write(`Detected: ${vramGb.toFixed(1)} GB VRAM, ${ramGb.toFixed(1)} GB RAM`);
    process.stdout.write(useCase ? `  (use case: ${useCase})` : "");
    process.stdout.write(uncensoredOnly ? `  (uncensored only)` : "");
    process.stdout.write("\n");

    const recs = recommendModels({ vramGb, ramGb, useCase, uncensoredOnly, limit });
    if (recs.length === 0) {
        process.stdout.write("No matching models in the catalog. Try without --use-case / --uncensored.\n");
        return 0;
    }

    process.stdout.write(`\nTop ${recs.length} for your hardware:\n\n`);
    recs.forEach((rec, i) => {
        const m = rec.model;
        const fits = rec.fits ? "✓" : "⚠ tight on VRAM";
        const sizeGb = m.paramsB * 0.6;  // rough Q4 disk size for catalog estimate
        process.stdout.write(`  ${i + 1}. ${m.name}  (${m.paramsB}B, ~${sizeGb.toFixed(1)} GB Q4 disk, needs ≥${m.vramMin} GB VRAM)  ${fits}\n`);
        if (m.notes) process.stdout.write(`     ${m.notes}\n`);
        process.stdout.write(`     pull:  infernet model pull ${m.pullName}\n\n`);
    });

    if (!wantInstall && !wantInstallAll) {
        process.stdout.write(`To install the top pick:           infernet model recommend --install\n`);
        process.stdout.write(`To install everything that fits:    infernet model recommend --install-all\n\n`);
        return 0;
    }

    // ---- auto-install path ----
    const fitsOnHardware = recs.filter((r) => r.fits);
    if (fitsOnHardware.length === 0) {
        process.stderr.write("No recommended models actually fit your hardware — refusing to install.\n");
        return 1;
    }

    let toInstall;
    if (wantInstallAll) {
        const diskFreeGb = await detectFreeDiskGb();
        const RESERVE_GB = 10; // leave headroom
        const budget = diskFreeGb - RESERVE_GB;
        process.stdout.write(`Disk free: ${diskFreeGb.toFixed(1)} GB (reserving ${RESERVE_GB} GB headroom → ${budget.toFixed(1)} GB budget)\n`);
        toInstall = [];
        let used = 0;
        for (const r of fitsOnHardware) {
            const sz = r.model.paramsB * 0.6;
            if (used + sz > budget) {
                process.stdout.write(`  skipping ${r.model.name} — would exceed disk budget\n`);
                continue;
            }
            toInstall.push(r);
            used += sz;
        }
        if (toInstall.length === 0) {
            process.stderr.write(`Disk budget too small for any recommended model.\n`);
            return 1;
        }
        process.stdout.write(`Will install ${toInstall.length} model(s), ~${used.toFixed(1)} GB total.\n\n`);
    } else {
        toInstall = [fitsOnHardware[0]];
    }

    let lastInstalled = null;
    for (const r of toInstall) {
        process.stdout.write(`\n→ Pulling ${r.model.name} (${r.model.pullName})…\n\n`);
        const code = r.model.pullName.startsWith("hf:")
            ? await cmdHfPull(r.model.pullName.slice(3))
            : await cmdPull(host_(), r.model.pullName, { force: true });
        if (code === 0) {
            lastInstalled = r.model;
        } else {
            process.stderr.write(`pull failed for ${r.model.pullName} (exit ${code}); continuing\n`);
        }
    }

    // Set the most recently-installed as the active model so chat works.
    if (lastInstalled) {
        const cfg = (await loadConfig()) ?? {};
        const updated = { ...cfg, engine: { ...(cfg.engine ?? {}), model: lastInstalled.pullName, backend: lastInstalled.backend } };
        await saveConfig(updated);
        process.stdout.write(`\n✓ engine.model = ${lastInstalled.pullName}  (${lastInstalled.backend})\n`);
        process.stdout.write(`Try it:  infernet chat "hello"\n\n`);
    }
    return 0;
}

/** Re-read config to grab the resolved Ollama host. cmdPull needs it. */
function host_() {
    return process.env.OLLAMA_HOST ?? DEFAULT_HOST;
}

/** Best-effort free-disk lookup (GB) on the partition holding $HOME. */
async function detectFreeDiskGb() {
    try {
        const { execFile } = await import("node:child_process");
        const { promisify } = await import("node:util");
        const pExec = promisify(execFile);
        const { stdout } = await pExec("df", ["-Pk", process.env.HOME ?? "/"], { timeout: 3000 });
        const parts = stdout.trim().split("\n").pop().split(/\s+/);
        const freeKb = Number.parseInt(parts[3], 10);
        return Number.isFinite(freeKb) ? freeKb / 1024 / 1024 : 0;
    } catch {
        return 0;
    }
}

async function cmdInfo(name) {
    if (!name) {
        process.stderr.write("error: info requires a model name (e.g. hf:Qwen/Qwen2.5-32B-Instruct)\n");
        return 2;
    }
    const repoId = name.startsWith('hf:') ? name.slice(3) : (name.includes('/') ? name : null);
    if (!repoId) {
        process.stderr.write(
            `info works on HuggingFace models only. Try:\n` +
            `  infernet model info hf:Qwen/Qwen2.5-32B-Instruct\n` +
            `  infernet model info NousResearch/Hermes-3-Llama-3.1-8B\n`
        );
        return 2;
    }

    const token = await resolveHfToken();
    process.stdout.write(`Fetching ${repoId} from HuggingFace…\n`);
    let info;
    try {
        info = await fetchHfModelInfo(repoId, token);
    } catch (err) {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        return 1;
    }

    const fmt = (v, suffix = "") => v == null ? "?" : `${v}${suffix}`;
    process.stdout.write(`\n${info.repoId}\n`);
    process.stdout.write(`${'─'.repeat(Math.min(70, info.repoId.length))}\n`);
    process.stdout.write(`  pipeline:        ${info.pipeline}\n`);
    process.stdout.write(`  architecture:    ${info.architectures?.join(", ") ?? info.modelType ?? "?"}\n`);
    process.stdout.write(`  model_type:      ${fmt(info.modelType)}\n`);
    if (info.isMoe) {
        process.stdout.write(`  MoE:             ${fmt(info.numExperts)} experts, ${fmt(info.expertsPerTok)} active per token\n`);
    }
    process.stdout.write(`  layers:          ${fmt(info.numLayers)}\n`);
    process.stdout.write(`  hidden_size:     ${fmt(info.hiddenSize)}\n`);
    if (info.numHeads) {
        const gqa = info.numKvHeads && info.numKvHeads !== info.numHeads ? ` (GQA, ${info.numKvHeads} kv)` : "";
        process.stdout.write(`  attention:       ${info.numHeads} heads${gqa}\n`);
    }
    process.stdout.write(`  context length:  ${info.contextLen ? info.contextLen.toLocaleString() : "?"}\n`);
    process.stdout.write(`  vocab:           ${info.vocabSize ? info.vocabSize.toLocaleString() : "?"}\n`);
    process.stdout.write(`  dtype:           ${fmt(info.torchDtype)}\n`);
    if (info.isQuantized) {
        process.stdout.write(`  quantized:       yes (${info.quantMethod ?? "unknown method"})\n`);
    }
    process.stdout.write(`\n  total weights:   ${fmt(info.sizeGb, " GB")}  (${fmt(info.shardCount)} shards)\n`);
    process.stdout.write(`  param count:     ~${fmt(info.paramsB, "B")}\n`);

    if (info.vramEstimateGb) {
        process.stdout.write(`\n  VRAM estimate (weights + ~15% overhead, no KV cache):\n`);
        process.stdout.write(`    bf16/fp16:     ~${info.vramEstimateGb.fp16} GB\n`);
        process.stdout.write(`    int8:          ~${info.vramEstimateGb.int8} GB\n`);
        process.stdout.write(`    int4 (AWQ/GPTQ): ~${info.vramEstimateGb.int4} GB\n`);
    }

    process.stdout.write(`\n  recommended backend: ${info.recommendedBackend === 'vllm_or_sglang' ? 'vLLM or SGLang (Ollama not supported)' : 'Ollama or vLLM'}\n`);
    process.stdout.write(`  license:             ${fmt(info.license)}\n`);
    if (info.downloads) process.stdout.write(`  downloads (30d):     ${info.downloads.toLocaleString()}\n`);

    // Single-GPU verdict for common SKUs.
    if (info.vramEstimateGb) {
        process.stdout.write(`\n  Fits a single GPU?\n`);
        const skus = [
            { name: "RTX 4090 24GB", vram: 24 },
            { name: "L40S / A6000 48GB", vram: 48 },
            { name: "A100 80GB / H100 80GB", vram: 80 },
            { name: "H200 141GB", vram: 141 }
        ];
        for (const sku of skus) {
            const fp16 = info.vramEstimateGb.fp16 <= sku.vram ? "✓ fp16" : "";
            const int8 = info.vramEstimateGb.int8 <= sku.vram ? (fp16 ? "" : "✓ int8") : "";
            const int4 = info.vramEstimateGb.int4 <= sku.vram ? (fp16 || int8 ? "" : "✓ int4") : "";
            const verdict = fp16 || int8 || int4 || "✗ requires multi-GPU";
            process.stdout.write(`    ${sku.name.padEnd(24)}  ${verdict}\n`);
        }
    }

    process.stdout.write(`\n  To download: infernet model pull hf:${info.repoId}\n\n`);
    return 0;
}

async function cmdHfPull(repoId, opts = {}) {
    const token = await resolveHfToken();

    process.stdout.write(`\nFetching metadata for ${repoId}…\n`);
    let info;
    try {
        info = await fetchHfModelInfo(repoId, token);
    } catch (err) {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        return 1;
    }

    process.stdout.write(`\n  repo:      ${info.repoId}\n`);
    process.stdout.write(`  type:      ${info.modelType ?? 'unknown'}\n`);
    process.stdout.write(`  size:      ${info.sizeGb != null ? info.sizeGb + ' GB' : 'unknown'}\n`);
    process.stdout.write(`  pipeline:  ${info.pipeline}\n`);
    process.stdout.write(`  backend:   ${info.recommendedBackend === 'vllm_or_sglang' ? 'vLLM / SGLang (Ollama not supported)' : 'Ollama or vLLM'}\n`);
    if (info.isMoe) process.stdout.write(`  ⚠  MoE model — requires vLLM or SGLang (not Ollama)\n`);
    process.stdout.write('\n');

    let localPath;
    try {
        localPath = await downloadHfModel(repoId, token, {});
    } catch (err) {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        return 1;
    }

    // Save to config under engine.hfModels
    const cfg = (await loadConfig()) ?? {};
    const hfModels = cfg.engine?.hfModels ?? [];
    const existing = hfModels.findIndex(m => m.repoId === repoId);
    const entry = { repoId, localPath, sizeGb: info.sizeGb, pulledAt: new Date().toISOString() };
    if (existing >= 0) hfModels[existing] = entry;
    else hfModels.push(entry);
    await saveConfig({ ...cfg, engine: { ...(cfg.engine ?? {}), hfModels } });

    process.stdout.write(`\nSaved to config. To serve with vLLM:\n`);
    process.stdout.write(`  vllm serve ${repoId} --host 0.0.0.0 --port 8000\n`);
    process.stdout.write(`\nThen set as active:\n`);
    process.stdout.write(`  infernet model use ${repoId}\n\n`);
    return 0;
}

async function cmdPull(host, name, opts = {}) {
    if (!name) {
        process.stderr.write("error: pull requires a model name (e.g. qwen2.5:7b or hf:org/repo)\n");
        return 2;
    }

    // HuggingFace path
    if (name.startsWith('hf:')) {
        return cmdHfPull(name.slice(3), opts);
    }

    // Looks like "Org/Repo" — almost certainly a HuggingFace name. Ollama
    // would just 404 with "pull model manifest: file does not exist", so
    // catch it here and point the operator at the right verb.
    if (name.includes('/') && !name.startsWith('hf:')) {
        process.stderr.write(
            `error: "${name}" looks like a HuggingFace repo, not an Ollama model.\n` +
            `\nOllama can only pull from ollama.com. For HuggingFace, use the hf: prefix:\n` +
            `  infernet model pull hf:${name}\n` +
            `\nFor Ollama models, browse https://ollama.com/library — names look like\n` +
            `qwen2.5:7b, llama3.1:8b, dolphin3:8b (no slash, with optional tag).\n`
        );
        return 1;
    }

    // Quick reachability check before spawning ollama, so we get a friendly
    // error rather than a confusing CLI-not-found if Ollama isn't installed.
    await fetchTags(host);

    // Capacity check — always enforced unless --force is passed.
    if (!opts.force) {
        const fits = await checkModelFits(name);
        if (fits && !fits.ok) {
            process.stderr.write(
                `\n${name} (≈${fits.size_gb} GB) likely won't fit on this host:\n` +
                `  detected: ${fits.mode} with ${fits.have_gb} GB available\n` +
                `  ceiling:  ~${fits.ceiling_gb} GB (${fits.mode === "gpu" ? "85% of VRAM" : "60% of RAM"})\n` +
                `\nRefusing to pull. To override:\n` +
                `  infernet model pull ${name} --force\n` +
                `\nOr pick a smaller model — see https://ollama.com/library\n`
            );
            return 1;
        }
    }

    try {
        await streamPull(name);
    } catch (err) {
        const msg = err?.message ?? String(err);
        process.stderr.write(`error: ${msg}\n`);
        // "pull model manifest: file does not exist" is Ollama-speak for
        // "registry returned 404 for that name+tag". Surface that clearly.
        if (/manifest.*does not exist|manifest.*not found/i.test(msg)) {
            process.stderr.write(
                `\nThat model + tag combination doesn't exist in the Ollama registry.\n` +
                `Browse exact names at https://ollama.com/library\n` +
                `\nCommon gotchas:\n` +
                `  - qwen2.5 only has :0.5b :1.5b :3b :7b :14b :32b :72b (no :8b)\n` +
                `  - llama3.1 has :8b and :70b (no :7b)\n` +
                `  - dolphin3 has :2b and :8b (no :7b)\n` +
                `  - HuggingFace models need the hf: prefix: \`infernet model pull hf:org/repo\`\n`
            );
        } else {
            process.stderr.write(
                `\nNothing pulled. Common causes:\n` +
                `  - typo in the model spec (try \`ollama list\` on the registry: https://ollama.com/library)\n` +
                `  - missing tag — try the bare model name (e.g. qwen2.5 → qwen2.5:latest)\n` +
                `  - private / gated model — pull manually with \`ollama pull ${name}\` to see the raw error\n`
            );
        }
        return 1;
    }
    return 0;
}

async function cmdRemove(host, name) {
    if (!name) {
        process.stderr.write("error: remove requires a model name\n");
        return 2;
    }
    await deleteModel(host, name);
    process.stdout.write(`removed ${name}\n`);

    // If the removed one was the active default, clear it so the daemon
    // doesn't keep pointing at a missing model.
    const cfg = (await loadConfig()) ?? {};
    if (cfg.engine?.model === name) {
        const updated = { ...cfg, engine: { ...cfg.engine, model: null } };
        delete updated.engine.model;
        await saveConfig(updated);
        process.stdout.write(`(cleared engine.model in ${getConfigPath()} — set a new one with \`infernet model use <name>\`)\n`);
    }
    return 0;
}

async function cmdUse(host, name) {
    if (!name) {
        process.stderr.write("error: use requires a model name\n");
        return 2;
    }
    const cfg = (await loadConfig()) ?? {};

    // HuggingFace model path — verify it's in config
    if (name.includes('/') || name.startsWith('hf:')) {
        const repoId = name.startsWith('hf:') ? name.slice(3) : name;
        const hfModels = cfg.engine?.hfModels ?? [];
        if (!hfModels.some(m => m.repoId === repoId)) {
            process.stderr.write(
                `error: ${repoId} not found in local HF models. Pull it first:\n` +
                `  infernet model pull hf:${repoId}\n`
            );
            return 1;
        }
        await saveConfig({ ...cfg, engine: { ...(cfg.engine ?? {}), model: repoId, backend: 'vllm' } });
        process.stdout.write(`engine.model = ${repoId}  (backend: vllm)\n`);
        process.stdout.write(`Serve it with: vllm serve ${repoId} --host 0.0.0.0 --port 8000\n`);
        return 0;
    }

    // Ollama model — verify it's actually pulled
    const tags = await fetchTags(host);
    const have = (tags.models ?? []).map((m) => m.name).includes(name);
    if (!have) {
        process.stderr.write(
            `error: ${name} is not pulled locally. Pull it first: infernet model pull ${name}\n`
        );
        return 1;
    }
    const updated = {
        ...cfg,
        engine: { ...(cfg.engine ?? {}), model: name, backend: 'ollama' }
    };
    await saveConfig(updated);
    process.stdout.write(`engine.model = ${name}  (saved to ${getConfigPath()})\n`);
    return 0;
}

async function cmdShow(host) {
    const cfg = (await loadConfig()) ?? {};
    const model = cfg.engine?.model ?? null;
    const backend = cfg.engine?.backend ?? "auto";
    process.stdout.write(`backend:     ${backend}\n`);
    process.stdout.write(`ollama host: ${host}\n`);
    process.stdout.write(`model:       ${model ?? "(unset — use \`infernet model use <name>\`)"}\n`);
    return 0;
}

export default async function model(args) {
    if (args.has("help") || args.has("h")) {
        process.stdout.write(HELP);
        return 0;
    }
    const positional = args.positional ?? [];
    const sub = positional[0];
    const arg = positional[1];

    const cfg = (await loadConfig()) ?? {};
    const host = resolveHost(cfg);

    try {
        switch (sub) {
            case "list":
            case "ls":
                if (args.has("node")) return await cmdListNode(args.get("node"), args);
                return await cmdList(host);
            case "info":
            case "inspect":
                return await cmdInfo(arg);
            case "recommend":
            case "suggest":
                return await cmdRecommend(args);
            case "pull":
            case "add":
                return await cmdPull(host, arg, {
                    force: args.has("force") || args.has("f"),
                    yes: args.has("yes") || args.has("y") || process.env.INFERNET_NONINTERACTIVE === "1"
                });
            case "remove":
            case "rm":
            case "delete":
                return await cmdRemove(host, arg);
            case "use":
            case "set":
                return await cmdUse(host, arg);
            case "show":
            case "current":
                return await cmdShow(host);
            default:
                process.stderr.write(
                    sub
                        ? `unknown subcommand: ${sub}\n\n`
                        : "error: missing subcommand\n\n"
                );
                process.stderr.write(HELP);
                return 2;
        }
    } catch (err) {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        return 1;
    }
}
