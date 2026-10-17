import Link from "next/link";

const canonicalLinks = [
  {
    label: "Official site",
    href: "https://infernetprotocol.com",
    description: "Hosted control plane, public chat playground, GPU deployment flow, and project home."
  },
  {
    label: "Open-source repository",
    href: "https://github.com/infernetprotocol/infernet-protocol",
    description: "Monorepo for the web dashboard, CLI, daemon, SDK packages, protocol docs, IPIPs, and Docker provider image."
  },
  {
    label: "Protocol specification",
    href: "https://github.com/infernetprotocol/infernet-protocol/blob/master/INFERNET-PROTOCOL.md",
    description: "Primary technical reference for the Infernet Protocol."
  },
  {
    label: "Architecture document",
    href: "https://github.com/infernetprotocol/infernet-protocol/blob/master/INFERNET-ARCHITECTURE.md",
    description: "Control-plane, node, identity, signed-request, payment, and deployment architecture."
  },
  {
    label: "Infernet Protocol Improvement Proposals",
    href: "https://github.com/infernetprotocol/infernet-protocol/tree/master/ipips",
    description: "IPIPs for protocol changes, network behavior, identity, chat, and governance."
  },
  {
    label: "The Infernet Protocol Book",
    href: "https://infernetprotocol.com/book",
    description: "Operator, developer, and protocol guide built from the open-source docs/book sources."
  },
  {
    label: "GitHub releases",
    href: "https://github.com/infernetprotocol/infernet-protocol/releases",
    description: "Tagged source releases for operators, contributors, and downstream packagers."
  },
  {
    label: "Container image",
    href: "https://github.com/orgs/InfernetProtocol/packages",
    description: "GHCR provider image for booting an Infernet GPU node."
  }
];

const facts = [
  "Open-source decentralized GPU inference marketplace.",
  "GPU providers can run one command, register a node, and accept inference jobs.",
  "Nodes authenticate with Nostr/secp256k1 signed HTTP requests instead of database credentials.",
  "The hosted control plane is infernetprotocol.com; self-hosted control planes are supported.",
  "The monorepo includes a Next.js dashboard, CLI/daemon, SDK packages, Docker provider image, and protocol improvement proposals.",
  "Payment flows are designed for multi-coin crypto settlement via CoinPayPortal."
];

const installCommands = [
  "curl -fsSL https://raw.githubusercontent.com/infernetprotocol/infernet-protocol/master/install.sh | sh",
  "docker run --rm -it --gpus all ghcr.io/profullstack/infernet-provider:latest",
  "git clone https://github.com/infernetprotocol/infernet-protocol.git"
];

export const metadata = {
  title: "Infernet Protocol | Open-source decentralized GPU inference marketplace",
  description:
    "Infernet Protocol is an open-source decentralized GPU inference marketplace with a Next.js control plane, CLI daemon, Docker provider image, Nostr-signed node API, and IPIP protocol docs.",
  alternates: {
    canonical: "https://infernetprotocol.com/protocol"
  },
  openGraph: {
    title: "Infernet Protocol",
    description:
      "Open-source decentralized GPU inference marketplace. Rent GPUs, run inference jobs, and operate provider nodes with signed, credential-minimized node APIs.",
    url: "https://infernetprotocol.com/protocol",
    siteName: "Infernet Protocol",
    type: "website"
  }
};

export default function ProtocolPage() {
  return (
    <main className="min-h-screen px-4 py-8 sm:px-6 lg:px-10">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-8">
        <section className="rounded-[2rem] border border-white/10 bg-[var(--panel)] p-6 shadow-[0_20px_80px_rgba(0,0,0,0.35)] backdrop-blur lg:p-10">
          <p className="text-sm uppercase tracking-[0.35em] text-[var(--accent)]">Infernet Protocol</p>
          <div className="mt-4 grid gap-8 lg:grid-cols-[1.3fr_0.7fr]">
            <div>
              <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-6xl">
                Open-source decentralized GPU inference marketplace.
              </h1>
              <p className="mt-5 max-w-3xl text-lg leading-8 text-[var(--muted)]">
                Infernet Protocol connects GPU providers, model operators, and inference consumers through a
                self-hostable control plane, signed node APIs, crypto-native payments, and a provider runtime
                that can run on cloud GPUs, home labs, and edge machines.
              </p>
              <div className="mt-6 flex flex-wrap gap-3">
                <a
                  href="https://infernetprotocol.com"
                  className="rounded-full bg-[var(--accent)] px-5 py-3 text-sm font-semibold text-slate-950 transition hover:bg-white"
                >
                  Visit infernetprotocol.com
                </a>
                <a
                  href="https://github.com/infernetprotocol/infernet-protocol"
                  className="rounded-full border border-[var(--line)] px-5 py-3 text-sm font-semibold text-white transition hover:border-[var(--accent)] hover:bg-white/5"
                >
                  GitHub repository
                </a>
              </div>
            </div>
            <aside className="rounded-[1.5rem] border border-white/10 bg-[var(--panel-strong)] p-5">
              <h2 className="text-sm font-medium uppercase tracking-[0.25em] text-[var(--muted)]">Quick facts</h2>
              <ul className="mt-4 space-y-3 text-sm leading-6 text-[var(--text)]">
                {facts.map((fact) => (
                  <li key={fact} className="flex gap-3">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--accent)]" />
                    <span>{fact}</span>
                  </li>
                ))}
              </ul>
            </aside>
          </div>
        </section>

        <section className="grid gap-4 md:grid-cols-3">
          {installCommands.map((command) => (
            <div key={command} className="rounded-[1.25rem] border border-white/10 bg-[var(--panel-strong)] p-5">
              <p className="text-xs uppercase tracking-[0.25em] text-[var(--accent)]">Start here</p>
              <code className="mt-3 block break-words rounded-xl bg-black/30 p-3 text-sm leading-6 text-white">
                {command}
              </code>
            </div>
          ))}
        </section>

        <section className="rounded-[2rem] border border-white/10 bg-[var(--panel)] p-6 lg:p-8">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <p className="text-sm uppercase tracking-[0.35em] text-[var(--accent)]">Canonical links</p>
              <h2 className="mt-2 text-3xl font-semibold text-white">References for contributors, indexers, and media</h2>
            </div>
            <Link href="/" className="text-sm text-[var(--muted)] hover:text-white">
              Back to dashboard →
            </Link>
          </div>
          <div className="mt-6 grid gap-4 md:grid-cols-2">
            {canonicalLinks.map((link) => (
              <a
                key={link.href}
                href={link.href}
                className="rounded-[1.25rem] border border-white/10 bg-[var(--panel-strong)] p-5 transition hover:border-[var(--accent)] hover:bg-white/5"
              >
                <h3 className="text-lg font-semibold text-white">{link.label}</h3>
                <p className="mt-2 text-sm leading-6 text-[var(--muted)]">{link.description}</p>
                <p className="mt-3 break-all text-sm text-[var(--accent)]">{link.href}</p>
              </a>
            ))}
          </div>
        </section>

        <section className="rounded-[2rem] border border-white/10 bg-[var(--panel)] p-6 lg:p-8">
          <p className="text-sm uppercase tracking-[0.35em] text-[var(--accent)]">Community and publications</p>
          <h2 className="mt-2 text-3xl font-semibold text-white">Add independent references here as they ship</h2>
          <p className="mt-3 max-w-3xl text-base leading-7 text-[var(--muted)]">
            This page is the stable home for community links, the Infernet Protocol book, Discord invite,
            third-party coverage, interviews, tutorials, and package indexes. Add those links here when their
            public URLs are available, then search engines and downstream directories have a clean canonical
            target instead of a Wiktionary dictionary entry.
          </p>
        </section>
      </div>
    </main>
  );
}
