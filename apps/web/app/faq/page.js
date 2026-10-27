import Link from "next/link";

export const metadata = {
    title: "FAQ — Infernet Protocol",
    description:
        "What hardware does Infernet support? Which inference engines? How does distributed inference work? How does training work? Frequently asked questions about the Infernet Protocol stack."
};

const SECTIONS = [
    {
        id: "hardware",
        title: "Hardware support",
        items: [
            {
                q: "What GPUs does Infernet support?",
                a: (
                    <>
                        Anything Ollama or vLLM can drive. NVIDIA (CUDA), AMD (ROCm),
                        Apple Silicon (Metal), and CPU-only all work. The installer
                        auto-detects and provisions whichever engines fit your hardware:
                        on NVIDIA boxes it installs both Ollama and vLLM; on AMD / Apple
                        / CPU it installs Ollama (which natively handles those targets).
                    </>
                )
            },
            {
                q: "Does it work on Windows?",
                a: (
                    <>
                        Yes, via WSL2. The installer is POSIX shell, so Windows operators
                        run <code>wsl --install -d Ubuntu</code>, install the Windows-side
                        NVIDIA driver (gives WSL CUDA without a separate Linux driver),
                        and then run the same one-liner inside Ubuntu. Outbound paths
                        (chat, remote model commands) work as-is; direct P2P inbound on
                        :46337 needs a <code>netsh portproxy</code> rule on the Windows
                        host (optional — only matters if you want direct peer
                        connections).
                    </>
                )
            },
            {
                q: "What about Apple Silicon?",
                a: (
                    <>
                        Fully supported via Ollama on Metal. M1/M2/M3 with 16+ GB unified
                        memory runs 7B models comfortably; 32+ GB hits 13B-class models.
                        vLLM is NVIDIA-only and skips on Apple Silicon.
                    </>
                )
            },
            {
                q: "How much disk does the install need?",
                a: (
                    <>
                        With a deploy bearer (auto-bootstrap pulls a model): ~3 GB
                        without bearer; ~10 GB on non-NVIDIA; ~25 GB on NVIDIA (Ollama
                        CUDA libs + vLLM + a 7 GB model + headroom). The installer
                        auto-detects and bumps the threshold based on what it'll
                        provision; below the bar it bails loud instead of failing
                        mid-tar-extract.
                    </>
                )
            },
            {
                q: "I'm on RunPod / Vast.ai / Paperspace — does the install handle the volume mount?",
                a: (
                    <>
                        Yes, host-agnostic. install.sh scans <code>df</code>, finds the
                        biggest writable mount that isn't $HOME's filesystem, and
                        relocates everything (node_modules, mise data, vLLM venv, Ollama
                        CUDA libs, model blobs) onto it. Works for RunPod{" "}
                        <code>/workspace</code>, Vast.ai <code>/data</code>, Lambda
                        <code>/lambda</code>, bare metal <code>/mnt/*</code>, etc. — no
                        per-platform config needed.
                    </>
                )
            }
        ]
    },
    {
        id: "engines",
        title: "Inference engines",
        items: [
            {
                q: "Ollama or vLLM — when do I use which?",
                a: (
                    <>
                        Ollama is the easy default: works on every GPU vendor + CPU,
                        installs in ~30 s, manages model downloads. Use it for a single
                        GPU, mixed hardware, dev boxes, or if you just want it to work.
                        vLLM is the high-throughput choice for serious NVIDIA hardware:
                        PagedAttention, request batching, native tensor + pipeline
                        parallelism via Ray. Use it when you have multiple GPUs (or a
                        cluster), care about p99 latency under load, or need
                        OpenAI-compatible APIs in a busy production setup. The installer
                        provisions both on NVIDIA so you can switch by which one is
                        running. Auto-select picks vLLM ahead of Ollama if both are up.
                    </>
                )
            },
            {
                q: "What's a Ray cluster and do I need one?",
                a: (
                    <>
                        Ray is the orchestration layer vLLM uses internally for
                        multi-GPU and multi-node serving. Single-box multi-GPU works
                        without any Ray config — vLLM spawns it implicitly. You only
                        configure Ray explicitly when you have multiple machines and
                        want vLLM to span them: set{" "}
                        <code>INFERNET_RAY_MODE=head</code> on one box,{" "}
                        <code>INFERNET_RAY_MODE=worker</code> +{" "}
                        <code>INFERNET_RAY_HEAD=host:6379</code> on the others, then run{" "}
                        <code>vllm serve --tensor-parallel-size N --pipeline-parallel-size M</code>{" "}
                        on the head.
                    </>
                )
            },
            {
                q: "Does it support OpenAI-compatible APIs?",
                a: (
                    <>
                        Yes. vLLM serves the OpenAI chat-completions endpoint natively,
                        and the Infernet control plane exposes{" "}
                        <code>/v1/chat/completions</code> as an OpenAI-compatible
                        gateway that routes to live providers (or falls back to NVIDIA
                        NIM if the network is empty). Drop-in for any tool that already
                        speaks OpenAI.
                    </>
                )
            }
        ]
    },
    {
        id: "workloads",
        title: "Workload classes",
        items: [
            {
                q: "What are the workload classes?",
                a: (
                    <>
                        Defined in{" "}
                        <a
                            href="https://github.com/infernetprotocol/infernet-protocol/blob/master/ipips/ipip-0010.md"
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--accent)] hover:underline"
                        >
                            IPIP-0010
                        </a>
                        :
                        <ul className="mt-3 space-y-1.5">
                            <li>
                                <strong className="text-white">A</strong> — one model
                                fits one GPU; one request → one provider. Real-time chat.
                            </li>
                            <li>
                                <strong className="text-white">B</strong> — one model
                                fits one provider's cluster, sharded via tensor + pipeline
                                parallelism intra-LAN. Real-time chat.
                            </li>
                            <li>
                                <strong className="text-white">B.5</strong> — one model
                                spans multiple providers via pipeline-parallel relay over
                                WAN (Petals). Batch only — too slow for real-time.
                            </li>
                            <li>
                                <strong className="text-white">C</strong> — distributed
                                training across providers via async delta exchange
                                (OpenDiLoCo, Hivemind). Long-running.
                            </li>
                        </ul>
                    </>
                )
            },
            {
                q: "Can you shard one model across random P2P nodes for live chat?",
                a: (
                    <>
                        No, and don't trust anyone who says otherwise. Tensor parallelism
                        (the only way to make per-token latency reasonable for sharded
                        inference) needs sub-millisecond GPU-to-GPU bandwidth — the
                        public internet can't provide that. We support
                        pipeline-parallel sharding across providers (Class B.5 via
                        Petals), but it's batch-only at multi-second per-token latency.
                        Real-time chat for one model needs that model to fit in one
                        provider's hardware (Class A or B).
                    </>
                )
            },
            {
                q: "Does Infernet support distributed training?",
                a: (
                    <>
                        Scaffold is in via{" "}
                        <code>@infernetprotocol/training</code> with backends for
                        DeepSpeed (Class B trusted-cluster), OpenRLHF (Ray + vLLM +
                        DeepSpeed RLHF), OpenDiLoCo (Class C cross-provider async),
                        and Petals (Class B.5 fine-tunes). Today the stub backend
                        emits synthetic step events for end-to-end testing; the real
                        Python integrations land incrementally. See{" "}
                        <a
                            href="https://github.com/infernetprotocol/infernet-protocol/blob/master/ipips/ipip-0011.md"
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--accent)] hover:underline"
                        >
                            IPIP-0011
                        </a>
                        .
                    </>
                )
            },
            {
                q: "Can I submit batch jobs (embeddings, bulk classification)?",
                a: (
                    <>
                        Spec lands as{" "}
                        <a
                            href="https://github.com/infernetprotocol/infernet-protocol/blob/master/ipips/ipip-0013.md"
                            target="_blank"
                            rel="noreferrer"
                            className="text-[var(--accent)] hover:underline"
                        >
                            IPIP-0013
                        </a>
                        :{" "}
                        <code>POST /api/v1/jobs/batch</code> takes one logical job
                        (embed N docs, classify N items, summarize N texts), the
                        server splits it into independent chunks, BullMQ workers fan
                        chunks out to providers in parallel, results aggregate into a
                        manifest. Endpoint not yet live — IPIP defines the shape;
                        implementation in flight.
                    </>
                )
            }
        ]
    },
    {
        id: "privacy",
        title: "Privacy & security",
        items: [
            {
                q: "Who sees my prompts?",
                a: (
                    <>
                        For Class A and B (single-provider) jobs: only the provider
                        you got routed to, and only for the duration of that request.
                        The control plane stores job metadata (timing, model, who paid)
                        but not prompt content.
                        <br />
                        <br />
                        For Class B.5 (pipeline-parallel cross-provider): every provider
                        in the chain sees the intermediate hidden states, which leak
                        prompt content. Don't route privacy-sensitive prompts through
                        B.5 — pin to a single trusted provider instead. The dashboard
                        displays a "Visible to N relay peers" warning on B.5
                        submissions.
                    </>
                )
            },
            {
                q: "Does my GPU node need a public IP?",
                a: (
                    <>
                        No. The control-plane-mediated paths (chat, batch jobs, remote
                        model commands) all work outbound-only — your daemon polls and
                        posts. Direct provider-to-provider P2P features (libp2p
                        peering on :46337) need inbound, but if you only care about
                        earning via routed jobs, NAT is fine. Run with{" "}
                        <code>--no-advertise</code> to never publish your IP.
                    </>
                )
            },
            {
                q: "What credentials live on a node?",
                a: (
                    <>
                        A Nostr (secp256k1 / BIP-340) keypair, generated on first run
                        and stored at <code>~/.config/infernet/config.json</code> mode
                        0600. That's it — no database credentials, no service-role
                        keys. Every API call to the control plane carries an{" "}
                        <code>X-Infernet-Auth</code> envelope with a Schnorr signature
                        over method + path + timestamp + nonce + sha256(body). 60-second
                        replay window, per-process nonce cache, pubkey must match the
                        public_key on the target row.
                    </>
                )
            }
        ]
    },
    {
        id: "payments",
        title: "Payments",
        items: [
            {
                q: "Which coins / chains are supported?",
                a: (
                    <>
                        BTC, BCH, ETH, SOL, POL, BNB, XRP, ADA, DOGE; plus USDT on
                        ETH/Polygon/Solana; plus USDC on ETH/Polygon/Solana/Base. Gateway
                        is CoinPayPortal. Providers configure a payout address per coin
                        with <code>infernet payout set &lt;COIN&gt; &lt;ADDRESS&gt;</code>;
                        clients pay invoices in whichever coin they have. There is no
                        Infernet native token.
                    </>
                )
            },
            {
                q: "How does a provider get paid?",
                a: (
                    <>
                        Every completed job credits the node that served it in the earnings ledger. A paid job
                        earns your share of what the client paid (95%: the house fee is 5%), confirmed once CoinPay
                        confirms the client&apos;s payment. A free job (the /chat playground, most traffic in the
                        alpha) earns a house subsidy per 1,000 output tokens, shown as <em>pending approval</em>{" "}
                        until the rate is approved. Withdraw with <code>infernet payout request</code> or the
                        dashboard&apos;s Withdraw button; requests are approved and then sent through CoinPay. See{" "}
                        <Link href="/docs#earnings" className="text-[var(--accent)] hover:underline">
                            Earnings + payouts
                        </Link>
                        .
                    </>
                )
            },
            {
                q: "My node completed jobs but shows $0.00 earned. Were they paid?",
                a: (
                    <>
                        Almost certainly they were free jobs: playground and unpaid API traffic carry no client
                        payment. Since October 2026 those jobs earn a house subsidy per 1k output tokens, and jobs
                        completed before then were credited retroactively. Short chat replies earn fractions of a
                        cent, which the dashboard and <code>infernet payout list</code> now show to six decimals
                        instead of rounding to $0.00. They show as <em>pending approval</em> until the subsidy rate
                        is approved.
                    </>
                )
            },
            {
                q: "Do I need a payout address before I earn?",
                a: (
                    <>
                        No. Earnings accrue from your first completed job whether or not an address is set. You
                        need one only to withdraw: <code>infernet payout set &lt;COIN&gt; &lt;ADDRESS&gt;</code>{" "}
                        (add <code>--network polygon</code> etc. for stablecoins off Ethereum).
                    </>
                )
            },
            {
                q: "Can my hardware get paid jobs?",
                a: (
                    <>
                        Paid jobs are routed by model, not by GPU brand: any node that serves the requested model
                        and is online can be picked, including older cards like a P104-100 running small models.
                        Paid demand has not started yet in the alpha: so far every job has been a free one, earning the
                        subsidy. Serving popular small models (for example the qwen2.5 family your VRAM fits) and
                        staying online is what gets a node picked.
                    </>
                )
            }
        ]
    },
    {
        id: "deploy",
        title: "Deployment",
        items: [
            {
                q: "What's the fastest way to spin up a node?",
                a: (
                    <>
                        Mint a 24h deploy bearer at{" "}
                        <Link href="/deploy" className="text-[var(--accent)] hover:underline">
                            /deploy
                        </Link>{" "}
                        and paste the one-liner into your provider's user-data /
                        cloud-init / container start command. The script auto-detects
                        the platform's volume mount, picks the right engines for your
                        hardware, installs Node + pnpm + mise, clones the source, runs
                        the daemon, and registers with the control plane. No SSH
                        afterwards.
                    </>
                )
            },
            {
                q: "Can I run my own control plane (self-hosted)?",
                a: (
                    <>
                        Yes. Clone the repo, run{" "}
                        <code>pnpm supabase:start</code> +{" "}
                        <code>pnpm supabase:db:reset</code> +{" "}
                        <code>pnpm dev</code>, and you've got a local control plane on{" "}
                        <code>:3000</code>. Point CLI nodes at it with{" "}
                        <code>infernet init --url http://your-host:3000</code>. The same
                        codebase serves the cloud at infernetprotocol.com; nothing is
                        cloud-only.
                    </>
                )
            },
            {
                q: "How do I push a model update remotely without SSH?",
                a: (
                    <>
                        Owner-issued remote commands: from the dashboard's "Push model"
                        UI (or via{" "}
                        <code>POST /api/v1/user/nodes/&lt;pubkey&gt;/commands</code>),
                        you queue an{" "}
                        <code>{"{ command: \"model_install\", args: { model: \"...\" } }"}</code>{" "}
                        for your own node. The daemon picks it up on its next outbound
                        poll, runs <code>ollama pull &lt;model&gt;</code>, and reports
                        completion. Auth checks pubkey ownership — only you can issue
                        commands to your nodes.
                    </>
                )
            }
        ]
    }
];

export default function FaqPage() {
    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-16 lg:px-10">
            <header className="mb-10 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                    FAQ
                </p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    Frequently asked questions.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    What hardware works, which engines we support, how distributed
                    inference and training fit together, and what we explicitly
                    don&apos;t do. For deeper technical detail see{" "}
                    <Link href="/docs" className="text-[var(--accent)] hover:underline">
                        /docs
                    </Link>{" "}
                    or the{" "}
                    <a
                        href="https://github.com/infernetprotocol/infernet-protocol/tree/master/ipips"
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--accent)] hover:underline"
                    >
                        IPIPs
                    </a>
                    .
                </p>
            </header>

            <nav className="mb-12 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6">
                <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                    Jump to
                </p>
                <ul className="mt-3 grid gap-2 text-sm sm:grid-cols-2">
                    {SECTIONS.map((s) => (
                        <li key={s.id}>
                            <a
                                href={`#${s.id}`}
                                className="text-[var(--muted)] hover:text-white"
                            >
                                · {s.title}
                            </a>
                        </li>
                    ))}
                </ul>
            </nav>

            <div className="space-y-14">
                {SECTIONS.map((s) => (
                    <section key={s.id} id={s.id} className="scroll-mt-24">
                        <h2 className="mb-6 text-2xl font-semibold tracking-tight text-white">
                            {s.title}
                        </h2>
                        <div className="space-y-6">
                            {s.items.map((item, i) => (
                                <article
                                    key={i}
                                    className="rounded-[1.25rem] border border-white/10 bg-[var(--panel)] p-6 backdrop-blur"
                                >
                                    <h3 className="text-base font-semibold text-white">
                                        {item.q}
                                    </h3>
                                    <div className="mt-3 text-sm leading-7 text-[var(--muted)]">
                                        {item.a}
                                    </div>
                                </article>
                            ))}
                        </div>
                    </section>
                ))}
            </div>

            <section className="mt-14 rounded-[1.5rem] border border-white/10 bg-[var(--panel-strong)] p-6 text-sm text-[var(--muted)]">
                Didn&apos;t find your question? Email{" "}
                <a
                    href="mailto:hello@infernetprotocol.com?subject=FAQ%20question"
                    className="text-[var(--accent)] hover:underline"
                >
                    hello@infernetprotocol.com
                </a>{" "}
                or open an issue on{" "}
                <a
                    href="https://github.com/infernetprotocol/infernet-protocol/issues"
                    target="_blank"
                    rel="noreferrer"
                    className="text-[var(--accent)] hover:underline"
                >
                    GitHub
                </a>
                .
            </section>
        </main>
    );
}
