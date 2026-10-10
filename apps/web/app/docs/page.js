import Link from "next/link";
import CopyButton from "@/components/copy-button";

export const metadata = {
    title: "Documentation",
    description:
        "Install the Infernet CLI, run a node, configure payouts, integrate the API. Full documentation with copy-pasteable examples."
};

const TOC = [
    { id: "quick-start",   label: "Quick start" },
    { id: "cli-overview",  label: "CLI overview" },
    { id: "cli-setup",     label: "infernet setup" },
    { id: "cli-chat",      label: "infernet (chat)" },
    { id: "cli-model",     label: "infernet model" },
    { id: "cli-init",      label: "infernet init" },
    { id: "cli-start",     label: "infernet start" },
    { id: "cli-doctor",    label: "infernet doctor" },
    { id: "cli-payout",    label: "infernet payout" },
    { id: "cli-tui",       label: "infernet tui" },
    { id: "cli-service",   label: "infernet service (systemd)" },
    { id: "auth",          label: "Sign up / sign in / reset" },
    { id: "dashboard",     label: "Dashboard" },
    { id: "interconnects", label: "Interconnects (NVLink / xGMI / IB / EFA)" },
    { id: "api",           label: "Public API endpoints" },
    { id: "self-host",     label: "Self-host the control plane" },
    { id: "architecture",  label: "Architecture" },
    { id: "troubleshoot",  label: "Troubleshooting" }
];

export default function DocsPage() {
    return (
        <>
        <main className="mx-auto w-full max-w-5xl px-6 py-16 lg:px-10">
            <header className="mb-12 space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
                    Documentation
                </p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    Run a node. Submit jobs. Self-host.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    Everything an operator or client needs to use the network. If you're
                    looking for protocol-level design decisions, see the{" "}
                    <Link
                        href="https://github.com/infernetprotocol/infernet-protocol/tree/master/ipips"
                        className="text-[var(--accent)] hover:underline"
                        target="_blank"
                        rel="noreferrer"
                    >
                        IPIPs
                    </Link>{" "}
                    on GitHub.
                </p>
                <p className="max-w-2xl text-sm leading-6 text-[var(--muted)]">
                    Workload note: Infernet targets single-GPU inference (7B–70B), embarrassingly
                    parallel batch, LoRA fine-tunes, and async / federated distributed training.
                    Tight-sync NVLink-bound training of 100B+ models stays on hyperscaler fleets —
                    by design, not by accident. See the homepage{" "}
                    <Link href="/#how-it-competes" className="text-[var(--accent)] hover:underline">
                        positioning section
                    </Link>{" "}
                    for the full reasoning.
                </p>
            </header>

            {/* TOC */}
            <nav className="mb-16 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6 backdrop-blur">
                <p className="mb-4 text-xs font-semibold uppercase tracking-[0.3em] text-[var(--muted)]">
                    Contents
                </p>
                <ol className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
                    {TOC.map((entry, i) => (
                        <li key={entry.id}>
                            <a
                                href={`#${entry.id}`}
                                className="block text-[var(--muted)] hover:text-[var(--accent)]"
                            >
                                <span className="mr-2 text-[var(--accent)]">{String(i + 1).padStart(2, "0")}.</span>
                                {entry.label}
                            </a>
                        </li>
                    ))}
                </ol>
            </nav>

            {/* QUICK START */}
            <Section id="quick-start" title="Quick start">
                <p>
                    On Linux, macOS, or Windows (WSL2), two lines get you the{" "}
                    <code>infernet</code> CLI plus everything it needs. The
                    first installs <Link href="https://c0mpute.com" className="text-[var(--accent)] hover:underline">c0mpute</Link>{" "}
                    (the p2p substrate infernet runs on); the second adds the
                    infernet plugin:
                </p>
                <CodeBlock>
{`curl -fsSL https://c0mpute.com/install.sh | sh
c0mpute plugin install infernet`}
                </CodeBlock>
                <p>
                    Then bootstrap your environment (Ollama, model, firewall, identity,
                    register with the control plane, start the daemon — all in one
                    interactive walk-through):
                </p>
                <CodeBlock>
{`infernet setup`}
                </CodeBlock>
                <p>Once setup is green, try inference end-to-end:</p>
                <CodeBlock>
{`infernet "what is 2+2?"
# or pipe input
echo "summarize: water is wet" | infernet`}
                </CodeBlock>
                <Aside type="note">
                    The CLI defaults to chat. <code>infernet "..."</code> is shorthand for{" "}
                    <code>infernet chat "..."</code>. Subcommands like <code>setup</code>,{" "}
                    <code>model</code>, <code>tui</code>, etc. take precedence when present.
                </Aside>
                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Windows (WSL2)</h4>
                <p>
                    The installer is POSIX shell, so Windows operators run it inside
                    WSL2 and the daemon picks up the GPU through Microsoft&apos;s WSL CUDA path:
                </p>
                <CodeBlock>
{`# 1. From PowerShell, install WSL + Ubuntu (reboot when prompted)
wsl --install -d Ubuntu

# 2. Install the Windows NVIDIA driver — gives WSL CUDA without
#    needing a separate driver inside Ubuntu.
#    https://www.nvidia.com/Download/index.aspx

# 3. Open Ubuntu, then run the same two-liner:
curl -fsSL https://c0mpute.com/install.sh | sh
c0mpute plugin install infernet
infernet setup`}
                </CodeBlock>
                <Aside type="note">
                    Outbound paths (chat, remote model commands) work out of the box.
                    Direct P2P inbound on <code>:46337</code> needs a{" "}
                    <code>netsh interface portproxy</code> rule on the Windows host —
                    skip it if you only care about earning via routed jobs.
                </Aside>
                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">How Node gets installed</h4>
                <p>
                    The installer uses{" "}
                    <a href="https://mise.jdx.dev" target="_blank" rel="noreferrer" className="text-[var(--accent)] underline">mise</a>{" "}
                    to install Node 20 — single static binary under <code>$HOME/.local/share/mise</code>,
                    no apt-repo dance, no conflict with whatever Node a base image already shipped
                    (e.g. RunPod&apos;s vllm-workspace ships Node 12). The wrapper at{" "}
                    <code>~/.local/bin/infernet</code> prepends mise&apos;s shims dir so the
                    right Node is picked regardless of whether your shell has activated mise yet.
                </p>
            </Section>

            {/* CLI OVERVIEW */}
            <Section id="cli-overview" title="CLI overview">
                <p>The <code>infernet</code> binary groups commands into four buckets:</p>
                <Table
                    columns={["Group", "Commands", "Purpose"]}
                    rows={[
                        ["Setup",         "setup, model",                                "Bootstrap the runtime + manage what models you serve"],
                        ["Node lifecycle","init, login, register, update, remove",       "Configure node identity + (de)register with a control plane"],
                        ["Daemon",        "start, stop, status, stats, logs, service",   "Run the long-lived process and inspect it"],
                        ["Diagnostics",   "gpu, firewall, chat, tui, doctor",            "Probe the local box + interact with the network"],
                        ["Payments",      "payout, payments",                            "Configure your payout addresses + view earnings"]
                    ]}
                />
                <p>
                    Run <code>infernet help</code> for the live list. Every subcommand
                    accepts <code>--help</code>.
                </p>
            </Section>

            {/* SETUP */}
            <Section id="cli-setup" title="infernet setup">
                <p>
                    The full bootstrap. Idempotent — re-run anytime to fix or update.
                    Walks through each step and asks before doing anything privileged
                    (sudo prompts use your terminal directly).
                </p>
                <CodeBlock>
{`infernet setup

[1/8] Node.js                ✓ v22.21.1
[2/8] Ollama                 ✗ Ollama not installed
                              Will run: curl -fsSL https://ollama.com/install.sh | sh
                              Install Ollama now (will sudo)? [Y/n] y
                              ...
                              ✓ done
[3/8] Model                  Which model should this node serve?
                                1) qwen2.5:0.5b   ≈400 MB  smoke test, runs on CPU
                                3) qwen2.5:7b     ≈4.4 GB  fits 8 GB+ GPU — recommended
                              Choice [3]:
                              → pulling qwen2.5:7b via the ollama CLI...
                              ✓ verified: ollama can serve qwen2.5:7b
[4/8] Firewall (port 46337)  ✓ rule applied via ufw
[5/8] Config                 ✓ saved to ~/.config/infernet/config.json
[6/8] Identity & control plane
                              ! no identity yet — running init
                              ...
                              ✓ identity: 5d0de683…
[7/8] Provider registration  ✓ registered
[8/8] Daemon                 ✓ daemon running

✓ setup complete`}
                </CodeBlock>
                <p>Useful flags:</p>
                <CodeBlock>
{`infernet setup --confirm                # auto-yes every prompt
infernet setup --model qwen2.5:7b       # preselect the model
infernet setup --no-firewall            # skip firewall step (e.g. inside containers)
infernet setup --skip-pull              # leave models alone
infernet setup --backend stub           # use canned tokens (no real GPU)`}
                </CodeBlock>
            </Section>

            {/* CHAT */}
            <Section id="cli-chat" title="infernet (chat)">
                <p>
                    Default verb. <code>infernet "&lt;prompt&gt;"</code> sends a chat job;
                    if a control plane is configured, it routes through the P2P network,
                    otherwise falls back to your local engine.
                </p>
                <CodeBlock>
{`# Network (default when controlPlane.url is set)
infernet "what is 2+2?"

# Force the local engine — useful for smoke testing without a network
infernet --local "ping"

# Force network — error if no control plane configured
infernet --remote "what is the capital of France?"

# Pipe input
echo "summarize this paragraph" | infernet

# Pin a specific model (overrides config)
infernet --model qwen2.5:7b "tell me a joke"

# JSON event stream — one event per line (meta, token, done)
infernet --json "ping"`}
                </CodeBlock>
                <p>Common flags:</p>
                <Table
                    columns={["Flag", "Effect"]}
                    rows={[
                        ["--remote / --local",   "Force routing path"],
                        ["--url <url>",          "Override control-plane URL (network mode)"],
                        ["--model <name>",       "Pin a model id (e.g. qwen2.5:7b)"],
                        ["--system <text>",      "Prepend a system message"],
                        ["--temperature <n>",    "Sampling temperature"],
                        ["--max-tokens <n>",     "Cap on generated tokens"],
                        ["--json",               "Emit raw NDJSON events instead of token stream"],
                        ["--backend <kind>",     "Local: ollama | mojo | stub"]
                    ]}
                />
            </Section>

            {/* MODEL */}
            <Section id="cli-model" title="infernet model">
                <p>Manage the models your node has on disk and which one is the active default.</p>
                <CodeBlock>
{`infernet model list                  # show pulled models + which is active
infernet model list --node <id>      # models a remote public node advertises
infernet model pull qwen2.5:7b       # pull (Ollama progress bar inline)
infernet model use qwen2.5:7b        # set as engine.model in config
infernet model show                  # current backend, host, active model
infernet model remove qwen2.5:0.5b   # delete from disk (clears active if it was)`}
                </CodeBlock>
                <Aside type="note">
                    Distinct from <code>infernet update</code> / <code>remove</code>, which
                    are about your node's <em>registration</em> on the control plane —
                    not about local models on disk.
                </Aside>
            </Section>

            {/* INIT */}
            <Section id="cli-init" title="infernet init">
                <p>
                    Configure node identity (Nostr keypair) and the control plane to talk to.
                    Idempotent — re-run to finish a partial config without losing engine
                    settings written by <code>setup</code>.
                </p>
                <CodeBlock>
{`infernet init

Control-plane URL [https://infernetprotocol.com]:        ← Enter to accept
Node role (provider|aggregator|client) [provider]:        ← Enter to accept
Human-readable node name [provider@hostname]: my-vps-1
... auto-generates Nostr keypair, detects address, asks about firewall ...
Wrote /home/ubuntu/.config/infernet/config.json
Pubkey: 5d0de683a5f22aa1d5a8927a431d86601277aad61fc7cdce126ac8c012e2c84d`}
                </CodeBlock>
                <p>Non-interactive flags:</p>
                <CodeBlock>
{`infernet init --url https://infernetprotocol.com \\
              --role provider \\
              --name my-vps-1 \\
              --p2p-port 46337 \\
              --no-advertise          # outbound-only mode (Tor-friendly)`}
                </CodeBlock>
            </Section>

            {/* START */}
            <Section id="cli-start" title="infernet start">
                <p>
                    Boot the long-running daemon. Detaches by default; use{" "}
                    <code>--foreground</code> for systemd / process supervisors.
                </p>
                <CodeBlock>
{`infernet start                    # detach to background, return shell prompt
infernet start --foreground       # for systemd (Type=simple) or PM2

# Inspect state
infernet status                   # remote row + local stats
infernet stats                    # live in-memory snapshot via IPC
infernet logs                     # tail ~/.config/infernet/daemon.log
infernet stop                     # graceful shutdown via IPC, signal fallback`}
                </CodeBlock>
                <Aside type="note">
                    For boot-persistence with auto-restart, prefer{" "}
                    <code>infernet service install</code> (systemd userland unit) —
                    see the dedicated section below.
                </Aside>
            </Section>

            {/* DOCTOR */}
            <Section id="cli-doctor" title="infernet doctor">
                <p>
                    Six independent checks across local config, engine, control plane,
                    daemon, registration row, and an end-to-end test inference. Useful
                    on a fresh box and after every config change.
                </p>
                <CodeBlock>
{`infernet doctor

[1/6] Local config           ✓ provider/my-vps-1, key=5d0de683a5f2…
[2/6] Engine                 ✓ Ollama up @ http://localhost:11434, model qwen2.5:7b pulled
[3/6] Control plane          ✓ https://infernetprotocol.com (HTTP 200, 124ms)
[4/6] Daemon                 ✓ pid=12345, last heartbeat 4s ago, jobs 12/13
[5/6] Provider row           ✓ registered as 5d0de683…, status=available, gpu=A100
[6/6] End-to-end             ✓ routed via=p2p, provider=self, first token 740ms, total 1280ms

All checks passed.`}
                </CodeBlock>
                <p>Skip the e2e test (which submits a real tiny job):</p>
                <CodeBlock>{`infernet doctor --skip-e2e`}</CodeBlock>
            </Section>

            {/* PAYOUT */}
            <Section id="cli-payout" title="infernet payout">
                <p>
                    Configure where you want to be paid for served jobs. CoinPayPortal
                    sends payouts to whatever addresses you set here. Operators who already
                    have wallets paste their addresses; operators who don't can have a
                    non-custodial BIP39 wallet generated and the encrypted seed phrase
                    delivered to their PGP key.
                </p>
                <CodeBlock>
{`# Bring your own wallet (recommended — non-custodial)
infernet payout set BTC mainnet bc1q9h6zcv4fp9kx5n0jq5qf3w2yxz4z3y2w5
infernet payout set ETH mainnet 0x742d35Cc6634C0532925a3b844Bc9e7595f8B59f
infernet payout set SOL mainnet 5RaBwVPRBfpz9MRBnGRcQAPfvKxcUVtxL2ANe9XJ
infernet payout set USDC solana 5RaBwVPRBfpz9MRBnGRcQAPfvKxcUVtxL2ANe9XJ
infernet payout set USDC polygon 0x742d35Cc6634C0532925a3b844Bc9e7595f8B59f

# Lightning — paste your bolt12 (recommended) or LNURL-pay address
infernet payout set BTC ln lno1qsgqmqvgm96frzdg8m0gc6nz...

# Don't have an LN node? Opt-in to a CoinPay-custodial channel:
infernet payout set BTC ln --provision

# Inspect
infernet payout list
infernet payout remove ETH mainnet
infernet payments                    # recent transactions (signed read)`}
                </CodeBlock>
                <Aside type="warn">
                    Lightning is the single custodial exception. All other coins are
                    fully non-custodial — CoinPay generates the BIP39 seed if you ask
                    it to, delivers it GPG-encrypted, and never holds the keys.
                </Aside>
            </Section>

            {/* TUI */}
            <Section id="cli-tui" title="infernet tui">
                <p>
                    Live terminal dashboard. Polls the daemon IPC + local Ollama; renders
                    system / jobs / engine / peers panels. <code>q</code> to quit,{" "}
                    <code>r</code> to refresh, <code>--refresh &lt;ms&gt;</code> to tune.
                </p>
                <CodeBlock>
{`infernet tui                # default 2s poll
infernet tui --refresh 1000 # 1s — for live debugging`}
                </CodeBlock>
            </Section>

            {/* SERVICE */}
            <Section id="cli-service" title="infernet service (systemd)">
                <p>
                    Optional boot-persistent runner via a userland systemd unit. No sudo,
                    no system-wide changes, lives under <code>~/.config/systemd/user/</code>.
                    Linux only.
                </p>
                <CodeBlock>
{`# Install the unit (writes ~/.config/systemd/user/infernet.service)
infernet service install
infernet service enable          # systemctl --user enable --now infernet

# Inspect
infernet service status
infernet service logs            # journalctl --user -u infernet -f

# (Optional) make it survive logout / reboot when not logged in:
loginctl enable-linger $USER

# Tear down
infernet service disable
infernet service uninstall`}
                </CodeBlock>
                <p>
                    Preview the unit file without writing anything:
                </p>
                <CodeBlock>{`infernet service unit`}</CodeBlock>
            </Section>

            {/* AUTH */}
            <Section id="auth" title="Sign up / sign in / reset password">
                <p>
                    Browser-side auth lives at <code>/auth/*</code> on the control plane.
                    All flows are server-side cookie-based via{" "}
                    <code>@supabase/ssr</code> — the browser never sees a Supabase URL or
                    key directly.
                </p>
                <Table
                    columns={["Page", "What it does"]}
                    rows={[
                        ["/auth/signup",          "Email + password. Sends a confirmation link."],
                        ["/auth/login",           "Email + password, OR leave password blank for a magic link."],
                        ["/auth/reset-password",  "Email a recovery link."],
                        ["/auth/update-password", "Set a new password (you land here from the recovery email)."],
                        ["/auth/check-email",     "\"We sent you a link\" success screen."]
                    ]}
                />
                <p>
                    SDK / CLI consumers use the same routes with{" "}
                    <code>Content-Type: application/json</code>:
                </p>
                <CodeBlock>
{`# Send a magic link
curl -sS -X POST https://infernetprotocol.com/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com"}'

# Or password
curl -sS -X POST https://infernetprotocol.com/api/auth/login \\
  -H "Content-Type: application/json" \\
  -d '{"email":"you@example.com","password":"hunter22"}' \\
  -c cookies.txt

# Use the resulting cookie for /api/admin/* (when those land — IPIP-0003 phase 4)`}
                </CodeBlock>
                <Aside type="note">
                    Branded transactional emails ship from the Supabase SMTP setup with the
                    HTML templates in{" "}
                    <Link
                        href="https://github.com/infernetprotocol/infernet-protocol/blob/master/docs/AUTH_EMAIL_TEMPLATES.md"
                        className="text-[var(--accent)] hover:underline"
                        target="_blank"
                        rel="noreferrer"
                    >
                        docs/AUTH_EMAIL_TEMPLATES.md
                    </Link>
                    . Operators self-hosting paste those into their own Supabase dashboard.
                </Aside>
            </Section>

            {/* DASHBOARD */}
            <Section id="dashboard" title="Dashboard">
                <p>
                    Signing in lands you on <code>/dashboard</code>. It&apos;s your private, per-user
                    view of the network: only resources linked to your account show up here.
                    Network-wide stats live on{" "}
                    <Link href="/status" className="text-[var(--accent)] hover:underline">
                        /status
                    </Link>{" "}
                    instead.
                </p>
                <p>The dashboard surfaces, all queried server-side:</p>
                <ul className="ml-5 list-disc space-y-1">
                    <li>
                        <strong>Earnings</strong> (last 30d / all-time / # confirmed payments) —
                        sum of inbound <code>payment_transactions</code> joined to your providers.
                    </li>
                    <li>
                        <strong>Spend</strong> on the same shape, joined to your clients.
                    </li>
                    <li>
                        <strong>GPUs in use + models served</strong> — totals across the
                        <code> providers.specs.gpus</code> /<code> .models</code> jsonb of every
                        provider you operate.
                    </li>
                    <li>
                        <strong>Provider-node table</strong> with status pills + last-seen timestamps.
                    </li>
                    <li>
                        <strong>CPU pool</strong> — host CPU groups across your nodes.
                    </li>
                    <li>
                        <strong>Interconnect summary</strong> — NVLink / xGMI / InfiniBand / EFA
                        / RDMA capability across your providers (see the interconnects section
                        below for what gets detected).
                    </li>
                    <li>
                        <strong>Linked Nostr identities</strong> — which pubkeys you&apos;ve claimed
                        for which roles (<code>provider</code>, <code>client</code>,
                        <code>aggregator</code>).
                    </li>
                    <li>
                        <strong>Recent jobs</strong> you submitted (best-effort match by client
                        label until the jobs table grows a <code>client_id</code> FK).
                    </li>
                </ul>
                <p>
                    Empty cards print the exact CLI command that would populate them — e.g.{" "}
                    <code>infernet register</code> for a node, <code>infernet pubkey link</code> for
                    an identity. No fake numbers.
                </p>
                <p>
                    The user-scoped joins go through <code>pubkey_links</code> (per IPIP-0003):
                    <code> auth.users.id → pubkey_links.user_id → providers.public_key</code> /
                    <code> clients.public_key</code>. Routes that need the current user import
                    <code> getCurrentUser()</code> from{" "}
                    <code>apps/web/lib/supabase/auth-server.js</code>; unauth&apos;d hits redirect
                    to <code>/auth/login?next=/dashboard</code>.
                </p>
            </Section>

            {/* INTERCONNECTS */}
            <Section id="interconnects" title="Interconnects (NVLink / xGMI / InfiniBand / EFA)">
                <p>
                    Infernet auto-detects GPU-to-GPU and host-to-host fabric on every{" "}
                    <code>infernet setup</code> and <code>infernet gpu</code> run, advertises a
                    coarse capability summary at registration time, and emits the right
                    environment variables when spawning an engine subprocess so NCCL / RCCL /
                    libfabric actually use the fabric instead of silently falling back to TCP.
                </p>

                <h3 className="mt-6 text-lg font-semibold text-white">What gets detected</h3>
                <table className="my-4 w-full border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-white/15 text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                            <th className="py-2 pr-3 font-medium">Fabric</th>
                            <th className="py-2 pr-3 font-medium">Hardware</th>
                            <th className="py-2 pr-3 font-medium">Detection source</th>
                        </tr>
                    </thead>
                    <tbody className="text-[var(--muted)]">
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">NVLink</td>
                            <td className="py-2 pr-3">NVIDIA datacenter + consumer multi-GPU</td>
                            <td className="py-2 pr-3"><code>nvidia-smi topo -m</code></td>
                        </tr>
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">xGMI / Infinity Fabric</td>
                            <td className="py-2 pr-3">AMD MI200 / MI300 series</td>
                            <td className="py-2 pr-3"><code>rocm-smi --showtopo</code></td>
                        </tr>
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">InfiniBand / RoCE</td>
                            <td className="py-2 pr-3">Mellanox / Nvidia ConnectX, RoCE NICs</td>
                            <td className="py-2 pr-3"><code>/sys/class/infiniband/*</code> (Linux)</td>
                        </tr>
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">AWS EFA</td>
                            <td className="py-2 pr-3">AWS p4d / p5 / Trainium instances</td>
                            <td className="py-2 pr-3"><code>lspci -d 1d0f:</code> (Linux)</td>
                        </tr>
                    </tbody>
                </table>
                <p>
                    Detection is best-effort: any vendor command that&apos;s missing or fails is
                    silently skipped — running on a CPU-only laptop or an AMD-only host doesn&apos;t
                    error, the relevant detector just returns an empty result. Topology is
                    classified <code>pair</code>, <code>mesh</code>, or <code>all-to-all</code> by
                    counting deduped GPU-pair edges against the complete-graph upper bound.
                </p>
                <p>See it on your hardware:</p>
                <CodeBlock>
{`infernet gpu                           # human summary
infernet gpu --json | jq .interconnects # raw detected shape`}
                </CodeBlock>

                <h3 className="mt-6 text-lg font-semibold text-white">What gets advertised</h3>
                <p>
                    <code>infernet register</code> includes a <em>coarsened</em> capability block
                    in <code>specs.interconnects</code> — no device names, no board IDs, no PCI
                    BDFs. Just enough for the matchmaker to route, not enough to fingerprint your
                    hardware:
                </p>
                <CodeBlock>
{`{
  "specs": {
    "interconnects": {
      "nvlink":     { "available": true,  "topology": "all-to-all", "link_count": 6 },
      "xgmi":       { "available": false, "topology": "none",       "link_count": 0 },
      "infiniband": { "available": true,  "active_port_count": 2 },
      "efa":        { "available": false, "adapter_count": 0 },
      "rdma_capable": true
    }
  }
}`}
                </CodeBlock>

                <h3 className="mt-6 text-lg font-semibold text-white">Engine-spawn env vars</h3>
                <p>
                    When the daemon launches an engine for a job, it merges the output of{" "}
                    <code>interconnectEnv(capability)</code> into the child&apos;s environment.
                    These are the standards downstream toolkits already honor — setting them is
                    the difference between NCCL using IB at 200 Gbit/s and NCCL falling back to
                    TCP at 10 Gbit/s.
                </p>
                <table className="my-4 w-full border-collapse text-sm">
                    <thead>
                        <tr className="border-b border-white/15 text-left text-xs uppercase tracking-[0.2em] text-[var(--muted)]">
                            <th className="py-2 pr-3 font-medium">When</th>
                            <th className="py-2 pr-3 font-medium">Env vars set</th>
                        </tr>
                    </thead>
                    <tbody className="text-[var(--muted)]">
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">NVLink available</td>
                            <td className="py-2 pr-3"><code>INFERNET_NVLINK=1</code>, <code>INFERNET_NVLINK_TOPOLOGY=&lt;topo&gt;</code></td>
                        </tr>
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">xGMI available</td>
                            <td className="py-2 pr-3"><code>INFERNET_XGMI=1</code>, <code>INFERNET_XGMI_TOPOLOGY=&lt;topo&gt;</code></td>
                        </tr>
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">≥1 active IB port with a name</td>
                            <td className="py-2 pr-3"><code>NCCL_IB_DISABLE=0</code>, <code>NCCL_IB_HCA=mlx5_0:1,mlx5_1:1,…</code></td>
                        </tr>
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">EFA adapter present</td>
                            <td className="py-2 pr-3"><code>FI_PROVIDER=efa</code>, <code>NCCL_PROTO=simple</code>, <code>INFERNET_EFA=1</code></td>
                        </tr>
                        <tr className="border-b border-white/5">
                            <td className="py-2 pr-3 text-white">RDMA-capable (any of IB / EFA active)</td>
                            <td className="py-2 pr-3"><code>INFERNET_RDMA=1</code></td>
                        </tr>
                    </tbody>
                </table>
                <p>
                    The <code>INFERNET_*</code> markers are advisory — useful for our adapters
                    that branch on fabric (e.g. opting into tensor-parallel inference modes). The{" "}
                    <code>NCCL_*</code> and <code>FI_*</code> are the load-bearing standards every
                    distributed-training framework already reads. Job-level launch profiles can
                    override any of these; the daemon won&apos;t clobber an explicit caller value.
                </p>
                <Aside>
                    Full normative spec, including the client-side
                    <code> requires.interconnects</code> matchmaking shape, lives in{" "}
                    <Link
                        href="https://github.com/infernetprotocol/infernet-protocol/blob/master/ipips/ipip-0008.md"
                        className="text-[var(--accent)] hover:underline"
                        target="_blank"
                        rel="noreferrer"
                    >
                        IPIP-0008
                    </Link>
                    .
                </Aside>
            </Section>

            {/* API */}
            <Section id="api" title="Public API endpoints">
                <p>
                    These are the wire surfaces. Two auth tiers — the protocol (Nostr-signed) and the dashboard
                    (cookie session) — plus a small public-read surface that's IP-rate-limited.
                </p>
                <Table
                    columns={["Endpoint", "Method", "Auth", "What"]}
                    rows={[
                        ["/api/health",                    "GET",  "none",            "Liveness probe (no DB)"],
                        ["/api/peers?limit=N",             "GET",  "none",            "Bootstrap seed peers (IPIP-0006)"],
                        ["/.well-known/did.json",          "GET",  "none",            "Platform DID document (IPIP-0007)"],
                        ["/api/overview",                  "GET",  "none",            "Aggregate network stats"],
                        ["/api/chat",                      "POST", "none + IP-rate",  "Submit a chat job (legacy alias for /api/jobs/submit)"],
                        ["/api/chat/stream/[jobId]",       "GET (SSE)", "none",       "Stream tokens + events"],
                        ["/api/v1/node/register",          "POST", "X-Infernet-Auth", "Provider registration (signed)"],
                        ["/api/v1/node/heartbeat",         "POST", "X-Infernet-Auth", "Liveness ping"],
                        ["/api/v1/node/jobs/poll",         "POST", "X-Infernet-Auth", "Pull assigned jobs"],
                        ["/api/v1/node/jobs/[id]/events",  "POST", "X-Infernet-Auth", "Stream tokens back"],
                        ["/api/v1/node/jobs/[id]/complete","POST", "X-Infernet-Auth", "Mark completed; triggers receipt"],
                        ["/api/v1/reservations/*",         "admin / buyer token", "Managed endpoints: reservations, keys, availability report, invoice data"],
                        ["/v1/chat/completions (ifr_res_ key)", "POST", "reservation key", "Inference pinned to one operator + exact model"],
                        ["/api/auth/{signup,login,callback,logout,reset-password,update-password}",
                                                          "POST/GET", "cookie session", "Dashboard auth flows"]
                    ]}
                />
                <p>
                    Reselling capacity? A reservation pins one identified operator and exact models for whole hours,
                    with your own keys, agreed limits and a per-minute availability record. See{" "}
                    <Link href="/docs/managed-endpoints" className="text-[var(--accent)] hover:underline">
                        Managed endpoints
                    </Link>.
                </p>
                <p>Submit a chat job (anonymous, IP-rate-limited):</p>
                <CodeBlock>
{`curl -sS -X POST https://infernetprotocol.com/api/chat \\
  -H "Content-Type: application/json" \\
  -d '{
    "messages":[{"role":"user","content":"hello"}],
    "modelName":"qwen2.5:7b",
    "maxTokens":256
  }'

# → { "jobId":"...", "streamUrl":"/api/chat/stream/..." }
# Then SSE-tail streamUrl for tokens.`}
                </CodeBlock>
                <p>Bootstrap seed peers:</p>
                <CodeBlock>
{`curl -sS https://infernetprotocol.com/api/peers?limit=10 | jq .

# → {
#   "data":[
#     {
#       "pubkey":"5d0de683…",
#       "multiaddr":"/ip4/162.250.189.114/tcp/46337",
#       "last_seen":"2026-04-26T12:00:00Z",
#       "served_models":["qwen2.5:7b"],
#       "gpu_model":"A100"
#     }
#   ]
# }`}
                </CodeBlock>
                <p>Verify a CPR Receipt issued by the platform:</p>
                <CodeBlock>
{`curl -sS https://infernetprotocol.com/.well-known/did.json | jq .verificationMethod

# Use the publicKeyMultibase to verify any Receipt signed by
# did:web:infernetprotocol.com.`}
                </CodeBlock>
            </Section>

            {/* SELF-HOST */}
            <Section id="self-host" title="Self-host the control plane">
                <p>
                    Infernet&apos;s control plane is open-source (MIT) and Docker-shippable. Self-hosting
                    means you run your own Next.js app + Supabase (cloud or self-hosted) and point
                    your operators at <em>your</em> URL via{" "}
                    <code>infernet init --url https://your-infernet.example</code>. The protocol
                    itself is permissionless — your operators can keep speaking to other control
                    planes too.
                </p>

                <h3 className="mt-6 text-lg font-semibold text-white">When to self-host</h3>
                <ul className="ml-5 list-disc space-y-1 text-[var(--muted)]">
                    <li>You run a private GPU pool for one organization and don&apos;t want jobs leaving it.</li>
                    <li>You need data residency in a specific region.</li>
                    <li>You want to fork the dashboard, ship a different model catalog, or run an internal billing layer.</li>
                    <li>You&apos;re building on top of the protocol and want a sandbox to break.</li>
                </ul>

                <h3 className="mt-6 text-lg font-semibold text-white">1. Clone, configure, build</h3>
                <CodeBlock>
{`git clone https://github.com/infernetprotocol/infernet-protocol.git
cd infernet-protocol
cp sample.env .env
node tooling/generate-secrets.mjs >> .env       # CLI session, cron, DID keys
$EDITOR .env                                    # fill SUPABASE_*, RESEND, CoinPay, etc.

pnpm install
pnpm --filter @infernetprotocol/web build`}
                </CodeBlock>

                <h3 className="mt-6 text-lg font-semibold text-white">2. Provision Supabase</h3>
                <p>Either flavor works:</p>
                <ul className="ml-5 list-disc space-y-1 text-[var(--muted)]">
                    <li>
                        <strong>Supabase Cloud</strong> — fastest path. Create a project, copy the
                        URL + anon key + service-role key into <code>.env</code>, then run{" "}
                        <code>supabase db push</code> from this repo to apply migrations.
                    </li>
                    <li>
                        <strong>Self-hosted Supabase</strong> — boot the official Docker stack, then
                        in this repo run <code>supabase start &amp;&amp; supabase db reset</code>{" "}
                        for local Postgres + Auth + Realtime + migrations applied.
                    </li>
                </ul>

                <h3 className="mt-6 text-lg font-semibold text-white">3. Required environment variables</h3>
                <CodeBlock>
{`# --- Supabase ---------------------------------------------------------------
NEXT_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...                  # server-only, never browser

# --- Public-facing URL (used by every redirect, OG card, install.sh) -------
NEXT_PUBLIC_APP_URL=https://your-infernet.example

# --- Auth (CLI bearer JWTs, cron auth, DID:web platform identity) ----------
INFERNET_CLI_SESSION_SECRET=...                   # generate-secrets.mjs fills these
INFERNET_CRON_SECRET=...
INFERNET_PLATFORM_DID_PRIVATE_KEY=...

# --- Email (sign-up confirmation, password reset, /contact) ----------------
RESEND_API_KEY=re_...

# --- Optional: NIM fallback for the public /chat playground ----------------
NVIDIA_NIM_API_KEY=nvapi-...

# --- Payments (CoinPayPortal — non-custodial except Lightning) -------------
COINPAY_ISSUER_API_KEY=cprt_...

# --- Web server -------------------------------------------------------------
PORT=8080`}
                </CodeBlock>

                <h3 className="mt-6 text-lg font-semibold text-white">4. Run it</h3>
                <p>Pick a hosting target:</p>

                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Docker</h4>
                <CodeBlock>
{`# Multi-stage build — preserves the pnpm workspace topology.
docker build -t infernet-control-plane -f docker/Dockerfile .

# Run with your .env mounted in
docker run --env-file .env -p 8080:8080 infernet-control-plane`}
                </CodeBlock>

                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Railway / Fly / Render</h4>
                <p>
                    Point the platform at <code>docker/Dockerfile</code> as the builder and copy
                    the env vars from your <code>.env</code> into the platform&apos;s secret manager.
                    Railway specifically: set the build command to nothing (Dockerfile handles it),
                    healthcheck path to <code>/api/health</code>, and PORT to <code>8080</code>{" "}
                    (or leave <code>$PORT</code> auto-injection alone — <code>next start</code>{" "}
                    honors it). Add your custom domain at the platform; in your DNS, the apex
                    record points at the platform&apos;s edge.
                </p>

                <h4 className="mt-4 text-sm font-semibold uppercase tracking-[0.2em] text-[var(--accent)]">Bare Linux + systemd</h4>
                <CodeBlock>
{`pnpm --filter @infernetprotocol/web start       # http://localhost:8080
# Front it with nginx/Caddy + Let's Encrypt for TLS, then bind a systemd
# unit so it restarts on crash. apps/cli/commands/service.js generates a
# matching unit for the GPU node side.`}
                </CodeBlock>

                <h3 className="mt-6 text-lg font-semibold text-white">5. Verify the deploy</h3>
                <CodeBlock>
{`curl -fsS https://your-infernet.example/api/health
# {"ok":true,"uptime_s":...,"node_env":"production","commit":"<sha>"}

# Round-trip the device-code login from a workstation:
infernet init --url https://your-infernet.example
infernet login                                  # opens browser → polls
infernet "ping"                                 # default verb is chat`}
                </CodeBlock>
                <p>
                    If <code>/api/health</code> returns 502, the container is down — most often a
                    missing env var at boot. Check the platform&apos;s deploy logs first, before
                    debugging anything in the app.
                </p>

                <h3 className="mt-6 text-lg font-semibold text-white">6. Operators on your deployment</h3>
                <CodeBlock>
{`infernet init --url https://your-infernet.example
infernet setup                                  # installs Ollama, pulls a model, opens firewall
infernet register                               # advertises the node on your control plane
infernet start                                  # daemon takes paying jobs`}
                </CodeBlock>
            </Section>

            {/* ARCHITECTURE */}
            <Section id="architecture" title="Architecture">
                <p>Three components, two trust tiers:</p>
                <CodeBlock>
{`┌────────────────────────────────────────────────────────┐
│  Control plane (Next.js + Supabase)                    │
│   /api/v1/node/*      provider tier  (Nostr-signed)    │
│   /api/admin/*        dashboard tier (cookie session)  │
│   /api/chat, /api/peers, /.well-known/did.json         │
│                                                        │
│   Writes CPR Receipts to coinpayportal.com on every    │
│   completed job — operator reputation accumulates      │
│   automatically.                                       │
└─────────────────────────────────────┬──────────────────┘
                                      │  (server-side only)
                                      ▼
                              Supabase / Postgres
                                      ▲
        Nostr-signed HTTP             │           anon SSE / cookie
        (BIP-340 Schnorr)             │
   ┌────────────┐   ┌──────────┐   ┌────────────────────┐
   │ infernet   │…  │ Browsers │   │ NVIDIA NIM         │
   │ daemon     │   │ /chat    │   │ (fallback only)    │
   │ Ollama     │   │ /status  │   │                    │
   │ TCP 46337  │   │ /docs    │   └────────────────────┘
   └────────────┘   └──────────┘`}
                </CodeBlock>
                <p>
                    Read the{" "}
                    <Link
                        href="https://github.com/infernetprotocol/infernet-protocol/tree/master/ipips"
                        className="text-[var(--accent)] hover:underline"
                        target="_blank"
                        rel="noreferrer"
                    >
                        IPIPs
                    </Link>{" "}
                    for the locked-in design decisions:
                </p>
                <ul className="list-disc space-y-1 pl-6 text-[var(--muted)]">
                    <li>IPIP-0001 — v1.0 launch criteria</li>
                    <li>IPIP-0002 — operator P2P chat (Nostr DMs + rooms)</li>
                    <li>IPIP-0003 — auth + account model (two-tier, pubkey linking)</li>
                    <li>IPIP-0004 — multi-currency payments via CoinPayPortal</li>
                    <li>IPIP-0005 — data access architecture (no DB clients in browsers/CLI/SDK)</li>
                    <li>IPIP-0006 — peer discovery + bootstrap (superseded; provided by c0mpute)</li>
                    <li>IPIP-0007 — CoinPay Reputation Protocol integration</li>
                </ul>
            </Section>

            {/* TROUBLESHOOTING */}
            <Section id="troubleshoot" title="Troubleshooting">
                <Trouble
                    symptom="`infernet doctor` reports Ollama not reachable"
                    cause="Ollama not installed, or installed but not running."
                    fix={(
                        <>Run <code>infernet setup</code> — it'll detect both states and offer to fix. If you prefer manual: <code>curl -fsSL https://ollama.com/install.sh | sh</code> then <code>sudo systemctl start ollama</code>.</>
                    )}
                />
                <Trouble
                    symptom="`infernet doctor` reports control plane unreachable"
                    cause="Wrong URL in config, or the control plane is genuinely down."
                    fix={(
                        <>Check with <code>curl https://infernetprotocol.com/api/health</code>. If the public site is up but yours doesn't reach it, your network may be filtering outbound. Run <code>infernet login --url &lt;new-url&gt;</code> if you need to repoint.</>
                    )}
                />
                <Trouble
                    symptom={`"job not assigned to this provider" on complete`}
                    cause="Daemon picked up a job but its public_key on the control plane doesn't match. Usually means you regenerated the keypair without re-registering."
                    fix={(<>Run <code>infernet register</code> to re-upsert; then restart the daemon.</>)}
                />
                <Trouble
                    symptom="Inference is much slower than expected"
                    cause="Likely running on CPU — Ollama installs without CUDA on a fresh box."
                    fix={(<>Run <code>nvidia-smi</code> while a job is in flight. If VRAM doesn't move, Ollama isn't using the GPU. Reinstall after installing CUDA, OR switch to a smaller model (<code>qwen2.5:0.5b</code> runs reasonably on CPU).</>)}
                />
                <Trouble
                    symptom="`infernet chat` returns error about missing model"
                    cause="config.engine.model unset or pointing at a model not pulled."
                    fix={(<>Pull and select: <code>infernet model pull qwen2.5:7b &amp;&amp; infernet model use qwen2.5:7b</code>. <code>infernet model show</code> confirms.</>)}
                />
                <Trouble
                    symptom="Email confirmation never arrives"
                    cause="Supabase SMTP not configured, or sender domain not warmed up."
                    fix={(<>Check Supabase Dashboard → Authentication → SMTP settings. Verify your sender domain has SPF + DKIM. Most "missing email" issues are quarantine — check spam, Promotions, Updates folders.</>)}
                />
                <Trouble
                    symptom="HTTP 502 from infernetprotocol.com"
                    cause="Control plane container is down or env vars are missing at boot."
                    fix={(<>Check <code>/api/health</code> first — a 502 there means the container is fully dead; missing-env-var crashes are the most common cause. SSH (or Railway dashboard) and check the deploy log.</>)}
                />
            </Section>

        </main>
        </>
    );
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function Section({ id, title, children }) {
    return (
        <section id={id} className="mb-16 scroll-mt-24">
            <h2 className="mb-4 flex items-baseline gap-3 text-2xl font-semibold tracking-tight text-white sm:text-3xl">
                <span className="text-[var(--accent)]">#</span>
                {title}
            </h2>
            <div className="space-y-4 leading-7 text-[var(--muted)] [&>p>code]:rounded [&>p>code]:bg-[var(--panel-strong)] [&>p>code]:px-1.5 [&>p>code]:py-0.5 [&>p>code]:text-[var(--accent)]">
                {children}
            </div>
        </section>
    );
}

function CodeBlock({ children }) {
    // Pull the raw text from children so the copy button has something
    // to put on the clipboard. Works for plain strings + arrays of
    // strings (the most common shapes inside our `{`...`}` literals).
    const text = childrenToText(children);
    return (
        <div className="relative my-3">
            <CopyButton text={text} />
            <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-[1rem] border border-white/10 bg-[var(--panel-strong)] p-5 pr-20 font-mono text-sm leading-6 text-[var(--accent)]">
                <code>{children}</code>
            </pre>
        </div>
    );
}

function childrenToText(children) {
    if (typeof children === "string") return children;
    if (Array.isArray(children)) return children.map(childrenToText).join("");
    if (children == null || typeof children === "boolean") return "";
    if (typeof children === "object" && "props" in children) {
        return childrenToText(children.props?.children);
    }
    return String(children);
}

function Aside({ type = "note", children }) {
    const colors =
        type === "warn"
            ? "border-yellow-400/30 bg-yellow-400/10 text-yellow-200"
            : "border-[var(--accent)]/30 bg-[var(--accent)]/10 text-[var(--accent)]";
    const label = type === "warn" ? "Heads up" : "Note";
    return (
        <div className={`my-4 rounded-lg border ${colors} p-4 text-sm`}>
            <span className="font-semibold">{label} ·</span> {children}
        </div>
    );
}

function Table({ columns, rows }) {
    return (
        <div className="my-4 overflow-x-auto rounded-[1rem] border border-white/10">
            <table className="w-full border-collapse text-sm">
                <thead>
                    <tr className="bg-[var(--panel-strong)] text-left">
                        {columns.map((c) => (
                            <th
                                key={c}
                                className="border-b border-white/10 px-4 py-3 text-xs font-semibold uppercase tracking-[0.15em] text-[var(--muted)]"
                            >
                                {c}
                            </th>
                        ))}
                    </tr>
                </thead>
                <tbody>
                    {rows.map((row, i) => (
                        <tr key={i} className="border-b border-white/5 last:border-b-0">
                            {row.map((cell, j) => (
                                <td key={j} className="px-4 py-3 align-top text-[var(--muted)]">
                                    {typeof cell === "string" && /^[a-z][a-z-]+$/i.test(cell.split(/\s/)[0]) ? (
                                        <code className="rounded bg-[var(--bg)] px-1.5 py-0.5 text-[var(--accent)]">
                                            {cell}
                                        </code>
                                    ) : (
                                        cell
                                    )}
                                </td>
                            ))}
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

function Trouble({ symptom, cause, fix }) {
    return (
        <div className="my-4 rounded-[1rem] border border-white/10 bg-[var(--panel)] p-5">
            <p className="mb-2 text-sm font-semibold text-white">{symptom}</p>
            <p className="mb-2 text-sm text-[var(--muted)]"><span className="text-[var(--accent)]">Cause —</span> {cause}</p>
            <p className="text-sm text-[var(--muted)]"><span className="text-[var(--accent)]">Fix —</span> {fix}</p>
        </div>
    );
}
