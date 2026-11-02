import Link from "next/link";
import houseModels from "@/public/house-models.json";

export const metadata = {
    title: "House models",
    description:
        "Models Infernet publishes for every provider node to serve: what a node pulls, how it decides a model fits, how the downloads are verified, and how operators opt out."
};

function H2({ id, children }) {
    return (
        <h2 id={id} className="scroll-mt-24 pt-10 text-2xl font-semibold tracking-tight text-white">
            {children}
        </h2>
    );
}

function P({ children }) {
    return <p className="mt-4 text-base leading-7 text-[var(--muted)]">{children}</p>;
}

function Code({ children }) {
    return (
        <pre className="mt-4 overflow-x-auto rounded-lg border border-white/10 bg-black/40 p-4 text-sm leading-6 text-zinc-200">
            <code>{children}</code>
        </pre>
    );
}

const gb = (b) => `${(b / 1024 ** 3).toFixed(1)} GB`;

export default function HouseModelsPage() {
    const manifest = houseModels;
    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-16 lg:px-10">
            <header className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">House models</p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    Models every node serves by default.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    Infernet publishes a short list of models that every provider node pulls and serves, so a
                    request for one of them can reach any node on the network, not only ours. It is on by default
                    for every node (new installs and existing ones through auto-update) and one command turns it off.
                </p>
            </header>

            <H2 id="list">The current list</H2>
            <P>
                The list is <a className="text-[var(--accent)] hover:underline" href="/house-models.json">/house-models.json</a>,
                a static file in the{" "}
                <a className="text-[var(--accent)] hover:underline" href="https://github.com/InfernetProtocol/infernet-protocol/blob/master/apps/web/public/house-models.json">
                    repository
                </a>. Adding a model is a pull request to that file.
            </P>
            <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
                <table className="w-full min-w-[36rem] text-left text-sm">
                    <thead className="bg-white/5 text-zinc-300">
                        <tr>
                            <th className="px-4 py-2 font-medium">Model (as served)</th>
                            <th className="px-4 py-2 font-medium">Size</th>
                            <th className="px-4 py-2 font-medium">Needs RAM</th>
                            <th className="px-4 py-2 font-medium">What</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-white/5 text-[var(--muted)]">
                        {manifest.models.map((m) => (
                            <tr key={m.source}>
                                <td className="px-4 py-2 align-top"><code className="text-zinc-200">{m.source}</code>{m.uncensored ? " (uncensored)" : ""}</td>
                                <td className="px-4 py-2 align-top">{gb(m.size_bytes)}</td>
                                <td className="px-4 py-2 align-top">{m.min_ram_gb} GB</td>
                                <td className="px-4 py-2 align-top">{m.description}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>

            <H2 id="how">What a node does</H2>
            <P>
                On start, and every 6 hours after, the daemon fetches the list over HTTPS (only from
                infernetprotocol.com or c0mpute.com) and, one model at a time, pulls each listed model into Ollama when:
            </P>
            <ul className="mt-4 list-disc space-y-2 pl-6 text-base leading-7 text-[var(--muted)]">
                <li>the machine has at least the model&apos;s <code>min_ram_gb</code> of RAM;</li>
                <li>after the download at least 10% of the disk stays free (never less than 10 GB, never more than 50 GB required);</li>
                <li>house models stay under the operator&apos;s disk cap, if one is set;</li>
                <li>one at a time; a pull waits up to 10 minutes for a running job to finish, then goes ahead (it is download work Ollama does beside inference).</li>
            </ul>
            <P>
                After each pull the node checks the model&apos;s digest and size against the list and deletes it if they
                differ. A model that leaves the list is removed. Models the operator pulled are never touched: the node
                only removes models it pulled itself (recorded in <code>~/.config/infernet/house-models-state.json</code>).
                A pulled house model is advertised and served like any other model, and jobs on it earn like any other job.
            </P>
            <P>
                When the list pins a new digest for a model (a new build), every node that pulled the old build re-pulls
                it on its next sync (CLI 0.1.84 and later). The old build stays until the new one verifies, so a failed
                update leaves the node serving the old one and retries after 24 hours. A model the operator pulled
                themselves is never updated; <code>infernet house-models</code> reports it as outdated.
            </P>

            <H2 id="opt-out">Opting out</H2>
            <Code>{`infernet house-models                 # what is pulled, disk used, last sync
infernet house-models list            # the list and whether each model fits here
infernet house-models off             # turn off (removes the ones the node pulled)
infernet house-models uncensored off  # skip uncensored models only
infernet house-models cap 20          # house models may use at most 20 GB
infernet house-models on              # back on`}</Code>
            <P>
                At install time: <code>INFERNET_NO_HOUSE_MODELS=1</code> (or <code>--no-house-models</code>),{" "}
                <code>INFERNET_NO_UNCENSORED_MODELS=1</code> (or <code>--no-uncensored-models</code>) and{" "}
                <code>INFERNET_HOUSE_MODELS_MAX_GB=20</code>. The same flags work on <code>infernet setup</code> and{" "}
                <code>infernet start</code>. c0mpute nodes take the same flags on c0mpute&apos;s installer, and{" "}
                <code>c0mpute worker status</code> shows the house models next to the rest of the node.{" "}
                <code>infernet status</code> always lists them.
            </P>

            <H2 id="add">Adding a model</H2>
            <P>
                Open a PR that adds an entry to <code>apps/web/public/house-models.json</code>:
            </P>
            <Code>{`{
  "name": "my-model",
  "source": "hf.co/<org>/<repo>-GGUF",        // or an Ollama tag
  "digest": "sha256:<sha256 of the registry manifest>",
  "size_bytes": 531070268,                    // all layers + config
  "min_ram_gb": 2,
  "min_disk_gb": 1,
  "uncensored": false,
  "license": "apache-2.0",
  "description": "…",
  "added": "2026-11-02"
}`}</Code>
            <P>
                The digest is what <code>ollama list</code> shows after a pull (full value from{" "}
                <code>/api/tags</code>), the same as <code>sha256sum</code> of the registry manifest at{" "}
                <code>https://hf.co/v2/&lt;org&gt;/&lt;repo&gt;/manifests/latest</code> (or{" "}
                <code>registry.ollama.ai/v2/&lt;ns&gt;/&lt;model&gt;/manifests/&lt;tag&gt;</code>). Nodes pick the change up
                on their next sync after the site deploys.
            </P>

            <p className="mt-12 text-sm text-[var(--muted)]">
                Back to the <Link href="/docs" className="text-[var(--accent)] hover:underline">documentation</Link>.
            </p>
        </main>
    );
}
