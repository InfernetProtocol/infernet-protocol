/**
 * `infernet uncensored` — download and configure an uncensored LLM.
 *
 * Auto-detects available VRAM and picks the best-fitting uncensored model
 * from a curated list. Uses Ollama (dolphin3) for quick local inference,
 * or HuggingFace + vLLM/SGLang for full-GPU hosting on the Infernet network.
 *
 *   infernet uncensored                 auto-pick based on VRAM
 *   infernet uncensored --ollama        force Ollama backend (dolphin3)
 *   infernet uncensored --list          print the curated model table
 */

import { loadConfig, saveConfig, getConfigPath } from '../lib/config.js';
import { detectCapacity } from '../lib/model-fit.js';
import {
    resolveHfToken,
    fetchHfModelInfo,
    downloadHfModel,
} from '../lib/hf-model.js';
import { spawn } from 'node:child_process';

const HELP = `infernet uncensored — download an uncensored LLM onto this node

Usage:
  infernet uncensored [flags]

Flags:
  --ollama         Use Ollama backend (dolphin3 series) instead of HuggingFace
  --list           Show the curated uncensored model table and exit
  --force          Skip VRAM capacity check
  --help           Show this help

How it works:
  Detects your available VRAM and picks the best-fitting uncensored model.
  HuggingFace models are downloaded locally and served via vLLM or SGLang,
  making your node a paid provider for uncensored inference on Infernet.

Curated models (HuggingFace / vLLM):
  ≥ 8 GB VRAM   NousResearch/Hermes-3-Llama-3.1-8B   (Apache 2.0, ~5 GB @ 4-bit)
  ≥ 40 GB VRAM  munekazu/Huihui-Qwen3.8-27B-abliterated-FP8
  ≥ 256 GB      GLM-5.3 Flash / GLM-5.3 / DeepSeek V4.1 Flash abliterated
                (multi-GPU; see --list)

Curated models (Ollama):
  ≥ 4 GB VRAM   dolphin3:2b
  ≥ 6 GB VRAM   dolphin3:8b  (recommended)
  ≥ 24 GB VRAM  huihui_ai/Qwen3.8-abliterated:27b
`;

// HuggingFace models, ordered by VRAM requirement ascending
const HF_MODELS = [
    {
        repoId: 'NousResearch/Hermes-3-Llama-3.1-8B',
        sizeGb: 15.0,
        sizeGb4bit: 5.0,
        minVramGb: 8,
        description: 'Hermes 3 8B (Nous Research) — uncensored, instruction-tuned, Apache 2.0',
    },
    {
        repoId: 'DavidAU/Qwen3.5-9B-Claude-4.6-HighIQ-THINKING-HERETIC-UNCENSORED',
        sizeGb: 18.8,
        sizeGb4bit: 6.0,
        minVramGb: 24,
        description: 'Qwen3.5 9B Heretic (DavidAU) — uncensored, thinking + vision, bf16 via vLLM',
    },
    {
        repoId: 'cognitivecomputations/dolphin-2.9.4-llama3.1-70b',
        sizeGb: 140.0,
        sizeGb4bit: 40.0,
        minVramGb: 40,
        description: 'Dolphin 2.9.4 70B (Eric Hartford) — uncensored, Llama 3.1 base',
    },
    {
        // huihui-ai abliteration of Qwen3.8 27B, FP8 (~31 GB). Newest and
        // strongest single-GPU pick, so it outranks the 70B when both fit.
        repoId: 'munekazu/Huihui-Qwen3.8-27B-abliterated-FP8',
        sizeGb: 55.6,
        sizeGb4bit: 18.0,
        minVramGb: 40,
        description: 'Qwen3.8 27B abliterated (huihui-ai) — uncensored, FP8 via vLLM, Apache 2.0',
    },
    {
        // The open-weight abliterated models allmodels.io routes to. MoE
        // flagships: multi-GPU only. NVFP4 builds need Blackwell (B200/GB200).
        repoId: 'edp1096/Huihui-GLM-5.3-Flash-abliterated-NVFP4',
        sizeGb: 204.4,
        sizeGb4bit: 204.4,
        minVramGb: 256,
        description: 'GLM-5.3 Flash 321B abliterated (huihui-ai) — NVFP4, needs Blackwell GPUs (~256 GB VRAM)',
    },
    {
        repoId: 'dealignai/GLM-5.3-ABLITERATED-NVFP4',
        sizeGb: 464.8,
        sizeGb4bit: 464.8,
        minVramGb: 512,
        description: 'GLM-5.3 753B abliterated — NVFP4, needs Blackwell GPUs (~512 GB VRAM)',
    },
    {
        repoId: 'mrfakename/DeepSeek-V4.1-Flash-1017-abliterated',
        sizeGb: 510.3,
        sizeGb4bit: 510.3,
        minVramGb: 640,
        description: 'DeepSeek V4.1 Flash 763B abliterated — FP8, needs 8x80 GB GPUs',
    },
    {
        // 754B MoE, FP8 weights (~755 GB) — flagship uncensored model. Only
        // auto-selected on a cluster that can actually hold it (minVramGb set
        // so it never picks on a single GPU). Gated on HF: set HF_TOKEN to pull.
        repoId: 'zandenAI/GLM-5.2-FP8-Uncensored',
        sizeGb: 755.0,
        sizeGb4bit: 755.0,
        minVramGb: 768,
        gated: true,
        description: 'GLM-5.2 754B FP8 (abliterated) — uncensored flagship; needs a multi-GPU cluster (~768 GB VRAM) + HF token',
    },
];

// Ollama models, ordered by VRAM requirement ascending
const OLLAMA_MODELS = [
    { name: 'dolphin3:2b',          sizeGb: 2.2,  minVramGb: 4,  description: 'Dolphin 3 2B — lightweight uncensored' },
    { name: 'dolphin3:8b',          sizeGb: 4.9,  minVramGb: 6,  description: 'Dolphin 3 8B — recommended uncensored (Llama 3.1)' },
    { name: 'dolphin-mixtral:8x7b', sizeGb: 26.1, minVramGb: 30, description: 'Dolphin Mixtral 8x7B — high-capacity uncensored' },
    // Last so it wins whenever it fits: newer and stronger than Mixtral.
    { name: 'huihui_ai/Qwen3.8-abliterated:27b', sizeGb: 18.0, minVramGb: 24, description: 'Qwen3.8 27B abliterated (huihui-ai) — recommended on 24 GB+' },
];

function pickHfModel(vramGb) {
    // Pick the largest model that fits
    const fits = HF_MODELS.filter(m => vramGb === 0 || vramGb >= m.minVramGb);
    return fits.length > 0 ? fits[fits.length - 1] : HF_MODELS[0];
}

function pickOllamaModel(vramGb) {
    const fits = OLLAMA_MODELS.filter(m => vramGb === 0 || vramGb >= m.minVramGb);
    return fits.length > 0 ? fits[fits.length - 1] : OLLAMA_MODELS[0];
}

function printModelTable() {
    process.stdout.write('\nHuggingFace / vLLM (for hosting on Infernet):\n');
    process.stdout.write(`  ${'MODEL'.padEnd(55)}  ${'VRAM'.padEnd(8)}  DESCRIPTION\n`);
    for (const m of HF_MODELS) {
        process.stdout.write(`  ${m.repoId.padEnd(55)}  ${('>= ' + m.minVramGb + ' GB').padEnd(8)}  ${m.description}\n`);
    }
    process.stdout.write('\nOllama (local inference, quick start):\n');
    process.stdout.write(`  ${'MODEL'.padEnd(30)}  ${'SIZE'.padEnd(8)}  ${'VRAM'.padEnd(8)}  DESCRIPTION\n`);
    for (const m of OLLAMA_MODELS) {
        process.stdout.write(`  ${m.name.padEnd(30)}  ${(m.sizeGb + ' GB').padEnd(8)}  ${('>= ' + m.minVramGb + ' GB').padEnd(8)}  ${m.description}\n`);
    }
    process.stdout.write('\n');
}

async function streamOllamaPull(name) {
    return new Promise((resolve, reject) => {
        const child = spawn('ollama', ['pull', name], { stdio: 'inherit' });
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`ollama pull exited ${code}`)));
        child.on('error', reject);
    });
}

async function setActiveModel(repoIdOrName, backend) {
    const cfg = (await loadConfig()) ?? {};
    await saveConfig({ ...cfg, engine: { ...(cfg.engine ?? {}), model: repoIdOrName, backend } });
    process.stdout.write(`engine.model = ${repoIdOrName}  (backend: ${backend})\n`);
    process.stdout.write(`Saved to ${getConfigPath()}\n`);
}

export default async function uncensored(args) {
    if (args.has('help') || args.has('h')) {
        process.stdout.write(HELP);
        return 0;
    }

    if (args.has('list')) {
        printModelTable();
        return 0;
    }

    const useOllama = args.has('ollama');
    const force = args.has('force') || args.has('f');

    // Detect VRAM
    const cap = await detectCapacity();
    const vramGb = cap.vram_gb;

    if (vramGb > 0) {
        process.stdout.write(`Detected ${vramGb.toFixed(1)} GB VRAM\n`);
    } else if (cap.ram_gb > 0) {
        process.stdout.write(`No GPU detected — ${cap.ram_gb.toFixed(1)} GB RAM available (CPU inference only)\n`);
    }

    if (useOllama) {
        const m = pickOllamaModel(vramGb);
        process.stdout.write(`\nSelected: ${m.name}\n`);
        process.stdout.write(`  ${m.description}\n`);
        process.stdout.write(`  size: ${m.sizeGb} GB\n\n`);

        if (!force && vramGb > 0 && vramGb < m.minVramGb) {
            process.stderr.write(
                `warning: ${m.name} needs ~${m.minVramGb} GB VRAM but only ${vramGb.toFixed(1)} GB detected.\n` +
                `Add --force to pull anyway.\n`
            );
            return 1;
        }

        try {
            await streamOllamaPull(m.name);
        } catch (err) {
            process.stderr.write(`error: ${err?.message ?? err}\n`);
            return 1;
        }

        await setActiveModel(m.name, 'ollama');
        process.stdout.write(`\nReady. Start chatting:\n  infernet chat\n\n`);
        return 0;
    }

    // HuggingFace / vLLM path
    const m = pickHfModel(vramGb);
    process.stdout.write(`\nSelected: ${m.repoId}\n`);
    process.stdout.write(`  ${m.description}\n`);
    process.stdout.write(`  size:          ~${m.sizeGb} GB (fp16) / ~${m.sizeGb4bit} GB (4-bit)\n`);
    process.stdout.write(`  min VRAM:      ${m.minVramGb} GB\n\n`);

    if (!force && vramGb > 0 && vramGb < m.minVramGb) {
        process.stderr.write(
            `warning: ${m.repoId} needs ~${m.minVramGb} GB VRAM but only ${vramGb.toFixed(1)} GB detected.\n` +
            `  Use --force to download anyway, or --ollama for a smaller Ollama model.\n`
        );
        return 1;
    }

    const token = await resolveHfToken();

    // Fetch metadata
    process.stdout.write(`Fetching metadata from HuggingFace…\n`);
    let info;
    try {
        info = await fetchHfModelInfo(m.repoId, token);
    } catch (err) {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        return 1;
    }

    process.stdout.write(`  pipeline:  ${info.pipeline}\n`);
    process.stdout.write(`  license:   ${info.license ?? 'unknown'}\n`);
    if (info.downloads) process.stdout.write(`  downloads: ${info.downloads.toLocaleString()}\n`);
    process.stdout.write('\n');

    // Download
    let localPath;
    try {
        localPath = await downloadHfModel(m.repoId, token, {});
    } catch (err) {
        process.stderr.write(`error: ${err?.message ?? err}\n`);
        return 1;
    }

    // Save to config
    const cfg = (await loadConfig()) ?? {};
    const hfModels = cfg.engine?.hfModels ?? [];
    const existing = hfModels.findIndex(e => e.repoId === m.repoId);
    const entry = { repoId: m.repoId, localPath, sizeGb: info.sizeGb, pulledAt: new Date().toISOString() };
    if (existing >= 0) hfModels[existing] = entry;
    else hfModels.push(entry);
    await saveConfig({ ...cfg, engine: { ...(cfg.engine ?? {}), hfModels, model: m.repoId, backend: 'vllm' } });

    process.stdout.write(`\nDownloaded to: ${localPath}\n\n`);
    process.stdout.write(`To serve this model (earn Infernet rewards):\n`);
    process.stdout.write(`  vllm serve ${m.repoId} --host 0.0.0.0 --port 8000\n\n`);
    process.stdout.write(`Then register your node and start the daemon:\n`);
    process.stdout.write(`  infernet register\n`);
    process.stdout.write(`  infernet start\n\n`);
    return 0;
}

export { HELP };
