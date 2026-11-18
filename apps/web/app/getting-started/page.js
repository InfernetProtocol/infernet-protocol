import Link from "next/link";
import CopyButton from "@/components/copy-button";

export const metadata = {
    title: "Getting started",
    description:
        "Pick your path: use the network for inference, run a node and earn, train a custom model on your own data, or publish a model to HuggingFace and Ollama. Copy-pasteable commands."
};

const TRACKS = [
    {
        id: "use",
        kicker: "Track 1",
        title: "Use the network",
        body:
            "Send OpenAI-compatible chat requests. No account required for the public playground; bring your own API key for production.",
        href: "#use"
    },
    {
        id: "operate",
        kicker: "Track 2",
        title: "Run a node",
        body:
            "Install the CLI on a GPU box, register, and start earning crypto for every job your hardware completes.",
        href: "#operate"
    },
    {
        id: "train",
        kicker: "Track 3",
        title: "Train a model",
        body:
            "Crawl a search query into a dataset, fine-tune locally with Unsloth or distribute across your fleet via federated LoRA.",
        href: "#train"
    },
    {
        id: "publish",
        kicker: "Track 4",
        title: "Publish a model",
        body:
            "Push your fine-tune to HuggingFace, convert to GGUF, and publish to ollama.com so anyone can pull it.",
        href: "#publish"
    }
];

function Code({ lang = "bash", children }) {
    const code = String(children).trim();
    return (
        <div className="relative my-3 rounded-lg border border-white/10 bg-[var(--panel-strong)] text-sm">
            <CopyButton text={code} className="absolute right-2 top-2 z-10" />
            <pre className="overflow-x-auto px-4 py-3 pr-12 text-[13px] leading-6 text-white"><code>{code}</code></pre>
        </div>
    );
}

function Section({ id, kicker, title, children }) {
    return (
        <section id={id} className="mt-16 scroll-mt-24">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--accent)]">
                {kicker}
            </p>
            <h2 className="mt-1 text-2xl font-semibold text-white sm:text-3xl">{title}</h2>
            <div className="mt-6 space-y-5 text-sm leading-7 text-[var(--muted)]">{children}</div>
        </section>
    );
}

export default function GettingStartedPage() {
    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-16 lg:px-10">
            <header className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                    Getting started
                </p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    Pick your path
                </h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    Four ways to use Infernet Protocol. Each track is a copy-paste sequence;
                    most flows finish in five minutes. Need depth? See the{" "}
                    <Link href="/docs" className="text-[var(--accent)] hover:underline">full docs</Link> or the{" "}
                    <Link href="/book" className="text-[var(--accent)] hover:underline">book</Link>.
                </p>
            </header>

            <div className="mt-10 grid gap-4 sm:grid-cols-2">
                {TRACKS.map((t) => (
                    <a
                        key={t.id}
                        href={t.href}
                        className="block rounded-lg border border-white/10 bg-white/[0.02] p-5 transition hover:border-[var(--accent)] hover:bg-white/[0.04]"
                    >
                        <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--accent)]">
                            {t.kicker}
                        </p>
                        <h3 className="mt-1 text-lg font-semibold text-white">{t.title}</h3>
                        <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{t.body}</p>
                    </a>
                ))}
            </div>

            {/* ── Track 1: USE ──────────────────────────────────────────── */}
            <Section id="use" kicker="Track 1" title="Use the network — chat / completions">
                <p>
                    The public endpoint is OpenAI-compatible. If you've ever called
                    OpenAI's API, you already know how to use it. Without a key you get a
                    few free queries a day; for real use{" "}
                    <Link href="/auth/signup" className="text-[var(--accent)] hover:underline">sign up</Link>, top up and
                    create an API key on{" "}
                    <Link href="/dashboard/billing" className="text-[var(--accent)] hover:underline">Billing</Link>.
                    The featured model is <strong className="text-white">Uncensored Qwen3.8 9B · GPU</strong>{" "}
                    (<code>eriktonon/qwen3.8-uncensored:9b</code>, about $0.005 a typical chat:{" "}
                    <Link href="/pricing" className="text-[var(--accent)] hover:underline">pricing</Link>):
                </p>

                <h3 className="mt-6 text-base font-semibold text-white">curl</h3>
                <Code>{`curl https://infernetprotocol.com/v1/chat/completions \\
    -H "Authorization: Bearer $INFERNET_API_KEY" \\
    -H "Content-Type: application/json" \\
    -d '{
        "model": "eriktonon/qwen3.8-uncensored:9b",
        "messages": [{"role": "user", "content": "What is Bitcoin?"}],
        "stream": false
    }'`}</Code>

                <h3 className="mt-6 text-base font-semibold text-white">JavaScript / Node</h3>
                <Code lang="js">{`import OpenAI from "openai";

const client = new OpenAI({
    baseURL: "https://infernetprotocol.com/v1",
    apiKey: process.env.INFERNET_API_KEY ?? "no-key-needed-for-playground"
});

const res = await client.chat.completions.create({
    model: "eriktonon/qwen3.8-uncensored:9b",
    messages: [{ role: "user", content: "Explain Schnorr signatures in 3 lines." }]
});
console.log(res.choices[0].message.content);`}</Code>

                <h3 className="mt-6 text-base font-semibold text-white">Python</h3>
                <Code lang="py">{`from openai import OpenAI

client = OpenAI(
    base_url="https://infernetprotocol.com/v1",
    api_key="no-key-needed-for-playground"
)

stream = client.chat.completions.create(
    model="eriktonon/qwen3.8-uncensored:9b",
    messages=[{"role": "user", "content": "Who built Linux?"}],
    stream=True,
)
for chunk in stream:
    print(chunk.choices[0].delta.content or "", end="", flush=True)`}</Code>

                <p className="mt-6">
                    The browser-friendly version is at{" "}
                    <Link href="/chat" className="text-[var(--accent)] hover:underline">/chat</Link>.
                    For the full route + parameter reference see{" "}
                    <Link href="/docs#api" className="text-[var(--accent)] hover:underline">docs → API</Link>.
                </p>
            </Section>

            {/* ── Track 2: OPERATE ──────────────────────────────────────── */}
            <Section id="operate" kicker="Track 2" title="Run a node and earn">
                <p>
                    Infernet runs as a workload plugin on top of{" "}
                    <Link href="https://c0mpute.com" className="text-[var(--accent)] hover:underline">c0mpute</Link>{" "}
                    (the p2p substrate — peer discovery, gossipsub auctions, shared
                    toolchain). Two commands install both: the c0mpute installer brings
                    in mise + bun + ffmpeg and lays down the c0mpute binary; the plugin
                    installer drops the infernet CLI, sets up Ollama, opens the firewall
                    port, and registers your node. Works on any Linux GPU box (RunPod,
                    Vast, bare metal, or your home tower).
                </p>

                <Code>{`curl -fsSL https://c0mpute.com/install.sh | sh
c0mpute plugin install infernet`}</Code>

                <p>Then:</p>
                <Code>{`infernet init             # generates a Nostr keypair, picks defaults
infernet setup            # installs Ollama + a starter model + opens the firewall port
infernet register         # signs and announces your node to the network
infernet start            # starts the daemon (or use \`infernet service enable\`)`}</Code>

                <p>
                    Your node is now live. The dashboard at{" "}
                    <Link href="/dashboard" className="text-[var(--accent)] hover:underline">/dashboard</Link>{" "}
                    shows real-time status; configure where to send earnings:
                </p>

                <Code>{`infernet payout set --coin BTC --address bc1q...
infernet payout set --coin USDC --address 0x... --network arbitrum
infernet payout list`}</Code>

                <p className="mt-4">
                    Quality-of-life commands:
                </p>
                <Code>{`infernet status                          # daemon health + last-seen
infernet model recommend --install-all   # auto-install the best models for your VRAM
infernet uncensored                      # one-shot install of Hermes 3 / Dolphin
infernet logs -f                         # tail the daemon log
infernet upgrade                         # pull the latest CLI`}</Code>

                <p>
                    Full operator guide:{" "}
                    <Link href="/book/02-node-operators/index.html" className="text-[var(--accent)] hover:underline">
                        Chapter 2 of the book
                    </Link>.
                </p>
            </Section>

            {/* ── Track 3: TRAIN ────────────────────────────────────────── */}
            <Section id="train" kicker="Track 3" title="Train a custom model">
                <p>
                    Same shape as{" "}
                    <a href="https://ollama.com/rockypod/svelte-coder" target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">
                        rockypod/svelte-coder
                    </a>{" "}— pick a topic, crawl the web, fine-tune, ship. Either run it on your
                    one GPU or fan out across all nodes you own.
                </p>

                <h3 className="mt-6 text-base font-semibold text-white">1. Crawl a query into a dataset</h3>
                <Code>{`infernet train data \\
    --query "svelte 5 framework documentation" \\
    --domains svelte.dev,kit.svelte.dev,github.com \\
    --num 30 \\
    --out ./data/svelte5.jsonl`}</Code>
                <p className="text-xs">
                    No search API key needed — the network proxies the crawl and
                    enforces a per-node daily quota. Self-hosting? Pass{" "}
                    <code className="text-[var(--accent)]">--direct</code> with a{" "}
                    <code className="text-[var(--accent)]">VALUESERP_API_KEY</code> to bypass.
                </p>

                <h3 className="mt-6 text-base font-semibold text-white">2. Scaffold a config</h3>
                <Code>{`infernet train init --output ./run`}</Code>

                <p>Edit <code className="text-[var(--accent)]">run/infernet.train.yml</code> — at minimum set:</p>
                <Code lang="yaml">{`name: svelte5-coder
base_model: unsloth/Qwen2.5-Coder-7B-Instruct
method: qlora
runtime: unsloth
workload_class: C1            # C1 local · C2 sweep · C3 federated

input:
  dataset: ./data/svelte5.jsonl
  format: chatml

training:
  epochs: 3
  learning_rate: 2.0e-4
  batch_size: 4
  max_seq_len: 4096

lora:
  rank: 16
  alpha: 32
  target_modules: [q_proj, k_proj, v_proj, o_proj]

resources:
  min_vram_gb: 24`}</Code>

                <h3 className="mt-6 text-base font-semibold text-white">3a. Train locally (single GPU)</h3>
                <Code>{`infernet train run --local --config ./run/infernet.train.yml`}</Code>
                <p className="text-xs">
                    Needs Python 3.10+ with <code className="text-[var(--accent)]">unsloth</code>,
                    {" "}<code className="text-[var(--accent)]">datasets</code>,
                    {" "}<code className="text-[var(--accent)]">trl</code>. Install once:
                </p>
                <Code>{`pip install unsloth datasets trl`}</Code>

                <h3 className="mt-6 text-base font-semibold text-white">3b. Train on the open network (federated LoRA)</h3>
                <p>
                    Pay any opted-in operator on the network — not just your own
                    nodes — to train shards. Your local <code className="text-[var(--accent)]">infernet</code>{" "}
                    daemon hosts the shards directly over its existing reachable port; no S3, no
                    HuggingFace dataset, no IPFS, no third-party storage anywhere.
                </p>
                <Code>{`infernet train run --open-market \\
    --config ./run/infernet.train.yml \\
    --budget 5.00 \\
    --max-nodes 8`}</Code>
                <p>
                    What happens: the CLI splits the dataset into 8 shards under{" "}
                    <code className="text-[var(--accent)]">~/.infernet/training-runs/&lt;run_id&gt;/shards/</code>{" "}
                    and posts a job with your daemon's URL. Operators across the network with{" "}
                    <code className="text-[var(--accent)]">INFERNET_ACCEPT_TRAINING=1</code>{" "}
                    poll the market every 60s, race-claim shards, fetch directly from your daemon, run
                    Unsloth, and PUT the resulting adapter back. You FedAvg the 8 adapters when all
                    shards report.
                </p>
                <p className="text-xs">
                    If your machine is behind NAT, run{" "}
                    <code className="text-[var(--accent)]">cloudflared tunnel --url http://localhost:8080</code>{" "}
                    and set <code className="text-[var(--accent)]">INFERNET_DAEMON_ENDPOINT</code> to the cloudflared URL.
                    Status: <span className="text-amber-200">experimental</span> — single-GPU local mode
                    is the well-trodden path right now.
                </p>

                <p className="mt-4">
                    Output: <code className="text-[var(--accent)]">./run/checkpoint-final/</code>
                    {" "}— a HuggingFace-shape directory ready to publish.
                </p>
            </Section>

            {/* ── Track 4: PUBLISH ──────────────────────────────────────── */}
            <Section id="publish" kicker="Track 4" title="Publish to HuggingFace and Ollama">
                <p>
                    One command, two destinations. The fine-tune lands at{" "}
                    <code className="text-[var(--accent)]">huggingface.co/&lt;org&gt;/&lt;name&gt;</code>{" "}
                    AND <code className="text-[var(--accent)]">ollama.com/&lt;user&gt;/&lt;name&gt;</code>.
                </p>

                <Code>{`infernet publish ./run/checkpoint-final \\
    --hf InfernetProtocol/svelte5-coder \\
    --ollama infernet/svelte5-coder \\
    --quant q4_k_m`}</Code>

                <p>What this runs under the hood:</p>
                <ol className="ml-5 list-decimal space-y-1">
                    <li><code className="text-[var(--accent)]">huggingface-cli upload</code> — pushes safetensors to HF</li>
                    <li><code className="text-[var(--accent)]">convert_hf_to_gguf.py</code> — converts to f16 GGUF (needs llama.cpp at <code className="text-[var(--accent)]">~/llama.cpp</code>)</li>
                    <li><code className="text-[var(--accent)]">llama-quantize</code> — quantizes to Q4_K_M (or your <code className="text-[var(--accent)]">--quant</code>)</li>
                    <li>Auto-generated <code className="text-[var(--accent)]">Modelfile</code> with the ChatML template</li>
                    <li><code className="text-[var(--accent)]">ollama create</code> + <code className="text-[var(--accent)]">ollama push</code></li>
                </ol>

                <p>One-time prereqs:</p>
                <Code>{`# llama.cpp for the GGUF convert
git clone https://github.com/ggml-org/llama.cpp ~/llama.cpp
cd ~/llama.cpp && cmake -B build && cmake --build build -j

# HF token with write scope
export HUGGINGFACE_TOKEN=hf_...

# Ollama signin (one time)
ollama signin`}</Code>

                <p>
                    After publish, anyone with Ollama installed can pull your model:
                </p>
                <Code>{`ollama pull infernet/svelte5-coder
ollama run infernet/svelte5-coder "How do runes work in Svelte 5?"`}</Code>

                <h3 className="mt-6 text-base font-semibold text-white">Variants</h3>
                <ul className="ml-5 list-disc space-y-1">
                    <li><code className="text-[var(--accent)]">--skip-hf</code> — Ollama only</li>
                    <li><code className="text-[var(--accent)]">--skip-ollama</code> — HuggingFace only</li>
                    <li><code className="text-[var(--accent)]">--modelfile-only</code> — generate the Modelfile + GGUF locally, don't push anywhere</li>
                </ul>
            </Section>

            <footer className="mt-20 rounded-lg border border-white/10 bg-white/[0.02] p-6 text-sm text-[var(--muted)]">
                <p className="font-semibold text-white">Stuck?</p>
                <p className="mt-2">
                    <Link href="/docs#troubleshoot" className="text-[var(--accent)] hover:underline">Troubleshooting</Link>{" "}·{" "}
                    <Link href="/contact" className="text-[var(--accent)] hover:underline">Email us</Link>{" "}·{" "}
                    <a href="https://discord.gg/w5nHdzpQ29" target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">Discord</a>{" "}·{" "}
                    <a href="https://github.com/infernetprotocol/infernet-protocol/issues" target="_blank" rel="noreferrer" className="text-[var(--accent)] hover:underline">File a GitHub issue</a>
                </p>
            </footer>
        </main>
    );
}
