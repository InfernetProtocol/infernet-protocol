import Link from "next/link";
import CopyButton from "@/components/copy-button";
import ProviderLogos from "@/components/provider-logos";

export const metadata = {
  title: "Infernet Protocol — Decentralized GPU compute",
  description:
    "A peer-to-peer GPU compute marketplace for inference and distributed training. Operators run one CLI command and start earning crypto. Clients pay in any supported coin. No native token, no rent extraction."
};

const INSTALL_ONE_LINER =
  "curl -fsSL https://c0mpute.com/install.sh | sh && c0mpute plugin install infernet";

export default function HomePage() {
  return (
    <>
      <main className="min-h-screen">
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-white/10">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-8 px-6 py-20 sm:py-28 lg:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
            Infernet Protocol
          </p>
          <h1 className="max-w-4xl text-5xl font-semibold leading-[1.05] tracking-tight text-white sm:text-6xl lg:text-7xl">
            We&apos;re doing to AI what Bitcoin did to money.
          </h1>
          <p className="max-w-2xl text-lg leading-8 text-[var(--muted)] sm:text-xl">
            A peer-to-peer GPU compute marketplace — inference <em className="not-italic text-white">and</em> distributed training.
            Run one CLI command, point it at the hardware you have, and start earning crypto. No native token,
            no rent extraction, no permission required.
          </p>

          <div className="flex flex-wrap items-center gap-3 pt-2">
            <Link
              href="#run-a-node"
              className="inline-flex items-center gap-2 rounded-full bg-[var(--accent-strong)] px-6 py-3 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
            >
              Run a node →
            </Link>
            <Link
              href="/chat"
              className="inline-flex items-center gap-2 rounded-full border border-white/20 px-6 py-3 text-sm font-semibold text-white transition hover:bg-white/10"
            >
              Try /chat
            </Link>
            <Link
              href="/status"
              className="inline-flex items-center gap-2 rounded-full px-6 py-3 text-sm font-semibold text-[var(--muted)] transition hover:text-white"
            >
              Live status →
            </Link>
          </div>
        </div>
      </section>

      {/* What it is */}
      <section className="border-b border-white/10">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-20 lg:grid-cols-3 lg:px-10">
          <Pillar
            eyebrow="For operators"
            title="Earn crypto for the GPU you already have"
            body="Run any model you can serve — Qwen, Llama, Mistral, your own. The control plane routes paying jobs to you and pays out in whichever coin you pasted in. No native token to hold, no platform spread above market."
          />
          <Pillar
            eyebrow="For clients"
            title="Pay in any chain you want"
            body="Submit chat, training, or embedding jobs and pay in BTC, ETH, SOL, USDC on multiple chains, Lightning, or whatever CoinPayPortal supports. The provider you got routed to gets paid; you don't have to learn a new asset to use the network."
          />
          <Pillar
            eyebrow="For the protocol"
            title="The control plane is convenience, not dependency"
            body="Operators authenticate with a Nostr keypair — never a database credential. Peer discovery + workload auctions live in c0mpute (libp2p Kad-DHT + gossipsub), shared with other plugins. The control plane can go dark and the c0mpute network keeps working."
          />
        </div>
      </section>

      {/* The honest version — workload positioning */}
      <section id="how-it-competes" className="border-b border-white/10">
        <div className="mx-auto max-w-6xl px-6 py-20 lg:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">
            The honest version
          </p>
          <h2 className="mt-4 max-w-3xl text-3xl font-semibold leading-tight tracking-tight text-white sm:text-4xl">
            Not a decentralized hyperscaler. The economic substrate for jobs that don&apos;t need NVLink.
          </h2>
          <p className="mt-6 max-w-3xl text-base leading-7 text-[var(--muted)]">
            Hyperscalers earn their interconnect moat on one specific workload: synchronous
            tensor-parallel training of frontier-scale models, where μs-level GPU-to-GPU
            bandwidth matters. We don&apos;t try to compete there. The math doesn&apos;t work, and
            we&apos;d be selling a fiction. Here&apos;s what <em>does</em> work on a peer-to-peer GPU network —
            and why it&apos;s most of the market.
          </p>

          <div className="mt-10 grid gap-6 lg:grid-cols-3">
            <Pillar
              eyebrow="Live today"
              title="Single-GPU & CPU inference"
              body="Run any chat model your hardware can serve — Qwen, Llama, Mistral — through Ollama on whatever GPU or CPU you have. One model, one box, one request. Zero NVLink penalty. The dominant inference pattern by request volume, and the one a peer network is actually best at."
            />
            <Pillar
              eyebrow="Coming next"
              title="vLLM + ComfyUI endpoints"
              body="OpenAI-compatible chat/completions via vLLM (drops into every existing tool that already speaks OpenAI), and image generation via ComfyUI. Both slot into the same engine-adapter pattern Ollama uses today. Embarrassingly parallel batch + LoRA fine-tunes + federated/DiLoCo-style training round out the workload set."
            />
            <Pillar
              eyebrow="Not our market"
              title="Hyperscaler-only workloads"
              body="Tight-sync 100B+ training, 64-node Slurm clusters, rent-a-Linux-box pod hosting. Maybe 20 orgs on Earth do those at scale; they own their fleets and they're not our customers. Conceding them costs nothing and frees us to build the protocol the rest of the market actually wants."
            />
          </div>

          <div className="mt-10 max-w-3xl text-base leading-7 text-[var(--muted)] space-y-4">
            <p>
              <strong className="text-white">On the ASIC future.</strong> Every flagship phone
              already ships with an inference accelerator. Apple Neural Engine, Qualcomm Hexagon,
              Tenstorrent, Groq&apos;s LPU, Cerebras, AWS Trainium — silicon optimized for matmul keeps
              getting cheaper, weirder, and more ubiquitous. Bitcoin&apos;s real lesson isn&apos;t that
              ASICs killed CPU mining. It&apos;s that <em>the protocol survived three hardware
                generations because it didn&apos;t depend on any of them</em>.
            </p>
            <p>
              Infernet is the protocol layer. Whatever silicon shows up next, the matchmaking,
              escrow, reputation (CPR), and payment routing don&apos;t change.
            </p>
          </div>
        </div>
      </section>

      {/* Run a node */}
      <section id="run-a-node" className="border-b border-white/10">
        <div className="mx-auto grid w-full max-w-6xl gap-10 px-6 py-20 lg:grid-cols-[1.1fr_0.9fr] lg:px-10">
          <div className="space-y-5">
            <p className="text-xs font-semibold uppercase tracking-[0.35em] text-[var(--accent)]">
              Get started
            </p>
            <h2 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Run a node in two commands.
            </h2>
            <p className="text-base leading-7 text-[var(--muted)]">
              Linux, macOS, or Windows (via WSL2). Re-run the installer anytime to update.
              Operators with their own hardware just point Infernet at it and configure
              payouts; the rest of the stack (Ollama, firewall, daemon) is handled by{" "}
              <code className="rounded bg-[var(--panel-strong)] px-1.5 py-0.5 text-[var(--accent)]">
                infernet setup
              </code>
              .
            </p>
            <ul className="space-y-2 text-sm text-[var(--muted)]">
              <li>· Install Ollama, pull a model, open the firewall</li>
              <li>· Configure your payout addresses (BYO wallet or generated)</li>
              <li>· Register with the control plane and start the daemon</li>
              <li>· Windows? <code>wsl --install -d Ubuntu</code>, then run the same one-liner inside it</li>
            </ul>
          </div>

          <div className="rounded-[1.5rem] border border-white/10 bg-[var(--panel-strong)] p-6 font-mono text-sm leading-7 text-[var(--accent)]">
            <p className="text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Install</p>
            <div className="relative mt-3">
              <CopyButton text={INSTALL_ONE_LINER} />
              <pre className="overflow-x-auto whitespace-pre-wrap break-all pr-20 text-[var(--accent)]">
                {INSTALL_ONE_LINER}
              </pre>
            </div>
            <p className="mt-6 text-xs uppercase tracking-[0.3em] text-[var(--muted)]">Then</p>
            <div className="relative mt-3">
              <CopyButton text={`infernet setup
infernet "what is 2+2?"`} />
              <pre className="overflow-x-auto whitespace-pre-wrap break-all pr-20 text-white">
{`infernet setup            # bootstrap Ollama + model + firewall
infernet "what is 2+2?"   # default verb is chat`}
              </pre>
            </div>
          </div>
        </div>
      </section>

      <ProviderLogos />

      {/* Try /chat */}
      <section className="border-b border-white/10">
        <div className="mx-auto flex w-full max-w-6xl flex-col items-start gap-6 px-6 py-20 lg:px-10">
          <p className="text-xs font-semibold uppercase tracking-[0.35em] text-[var(--accent)]">
            Try it now
          </p>
          <h2 className="max-w-3xl text-3xl font-semibold tracking-tight text-white sm:text-4xl">
            The public playground at <Link href="/chat" className="text-[var(--accent)] underline-offset-4 hover:underline">/chat</Link>{" "}
            routes through real provider nodes.
          </h2>
          <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
            When the network has live providers, your prompt goes to one of them and tokens stream
            back over SSE. When it doesn't (early-launch reality), it falls back to NVIDIA NIM so
            the demo never breaks. Either way, it's the real wire.
          </p>
          <Link
            href="/chat"
            className="inline-flex items-center gap-2 rounded-full bg-[var(--accent-strong)] px-6 py-3 text-sm font-semibold text-[var(--bg)] transition hover:bg-[var(--accent)]"
          >
            Open /chat →
          </Link>
        </div>
      </section>

      </main>
    </>
  );
}

function Pillar({ eyebrow, title, body }) {
  return (
    <div className="flex flex-col gap-3 rounded-[1.5rem] border border-white/10 bg-[var(--panel)] p-6 backdrop-blur">
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-[var(--accent)]">
        {eyebrow}
      </p>
      <h3 className="text-xl font-semibold tracking-tight text-white">{title}</h3>
      <p className="text-sm leading-6 text-[var(--muted)]">{body}</p>
    </div>
  );
}
