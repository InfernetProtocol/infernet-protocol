import Link from "next/link";

export const metadata = {
    title: "Liquid Agent: temporal policies (CfC, LTC, GRU)",
    description:
        "Train and serve small temporal policies (CfC and LTC liquid neural networks, with a GRU baseline) that predict the next UI action from consented, redacted desktop demonstrations. Local by default, or on a trusted c0mpute worker."
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

function Table({ columns, rows }) {
    return (
        <div className="mt-4 overflow-x-auto rounded-lg border border-white/10">
            <table className="w-full min-w-[36rem] text-left text-sm">
                <thead className="bg-white/5 text-zinc-300">
                    <tr>{columns.map((c) => <th key={c} className="px-4 py-2 font-medium">{c}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-[var(--muted)]">
                    {rows.map((r) => (
                        <tr key={r[0]}>{r.map((cell, i) => <td key={i} className="px-4 py-2 align-top">{i === 0 ? <code className="text-zinc-200">{cell}</code> : cell}</td>)}</tr>
                    ))}
                </tbody>
            </table>
        </div>
    );
}

const A = ({ href, children }) => (
    <a href={href} className="text-[var(--accent)] hover:underline">{children}</a>
);

const GH = "https://github.com/InfernetProtocol/infernet-protocol/blob/master";

export default function LiquidAgentPage() {
    return (
        <main className="mx-auto w-full max-w-4xl px-6 py-16 lg:px-10">
            <header className="space-y-4">
                <p className="text-xs font-semibold uppercase tracking-[0.4em] text-[var(--accent)]">Liquid Agent</p>
                <h1 className="text-4xl font-semibold tracking-tight text-white sm:text-5xl">
                    Small temporal policies for desktop tasks.
                </h1>
                <p className="max-w-2xl text-base leading-7 text-[var(--muted)]">
                    Infernet trains and serves temporal-policy models: CfC and LTC liquid neural networks (from{" "}
                    <A href="https://github.com/mlech26l/ncps">ncps</A>) and a GRU baseline. They learn from consented,
                    redacted demonstrations recorded in <A href="https://w3bs.org/training/liquid-agent">W3BS Training</A>{" "}
                    and propose the next UI action. They run on your own machine by default, or on a trusted{" "}
                    <A href="https://c0mpute.com/temporal">c0mpute</A> worker if you choose one.
                </p>
            </header>

            <H2 id="quick-start">Quick start</H2>
            <P>The Python runtime (PyTorch + ncps, about 1 GB on CPU) is never installed on its own. You install it:</P>
            <Code>{`npm i -g @infernetprotocol/cli          # 0.1.66 or newer
infernet model runtime setup --yes        # CPU lock; --accelerator cuda for NVIDIA
infernet model synth --out mock.json      # synthetic mock email / Reddit / LinkedIn traces
infernet model train --dataset mock.json --output ./model --family cfc --baseline gru
infernet model evaluate --model ./model/cfc --dataset mock.json
infernet model predict --model ./model/cfc --input steps.jsonl`}</Code>
            <P>
                With <code>--baseline</code>, every family trains on the same splits. A liquid family is selected only
                when it beats the GRU baseline on episode success.
            </P>

            <H2 id="workloads">Workloads</H2>
            <Table
                columns={["Workload", "What runs"]}
                rows={[
                    ["infernet.temporal.train", "infernet model train --job: one single-node job; exports model.safetensors + manifest.json + eval.json"],
                    ["infernet.temporal.infer", "infernet model serve --stdio: sticky sessions with TTL, strict sequence order, reset, checkpoint/restore"]
                ]}
            />

            <H2 id="contract">The liquid-agent/v1 contract</H2>
            <P>
                JSON Schemas shared by Infernet, c0mpute and W3BS: Episode, DatasetManifest, DatasetBundle, TrainJob,
                ModelManifest, InferenceSession, PredictRequest, ActionProposal. Content hashes are sha256 over
                canonical JSON and come out byte-identical from JS and Python. A model is identified by the sha256 of
                its safetensors file. Published as{" "}
                <A href="https://www.npmjs.com/package/@infernetprotocol/liquid-agent">@infernetprotocol/liquid-agent</A>.
            </P>

            <H2 id="safety">Safety and privacy</H2>
            <P>
                Datasets are checked before training: every hash, the schema, and a secret scan (keys, tokens,
                cookies, passwords, card numbers). Remote training is refused unless the job carries the user&apos;s
                upload approval. A worker sees the redacted data it trains on, and transport encryption does not change
                that, so pick a worker you trust or train locally. A proposal never authorises anything: it flags
                external writes (send, post, publish, delete, submit) and the W3BS executor asks a person for every one.
            </P>

            <H2 id="results">Results so far</H2>
            <P>
                On synthetic mock traces, GRU beat CfC (0.948 vs 0.869 episode success), so GRU stays the default. All
                families fail on an unseen layout. This is a pipeline and method check, not a claim about real
                desktops. See the <A href={`${GH}/docs/liquid-agent/benchmark.md`}>benchmark report</A>.
            </P>

            <H2 id="more">More</H2>
            <ul className="mt-4 list-disc space-y-2 pl-6 text-base leading-7 text-[var(--muted)]">
                <li><A href={`${GH}/docs/liquid-agent/README.md`}>Design, runtime protocol and error codes</A></li>
                <li><A href="https://w3bs.org/training/liquid-agent">W3BS: teach an agent</A>, where demonstrations are recorded, reviewed and used</li>
                <li><A href="https://c0mpute.com/temporal">c0mpute: temporal workloads</A>, for training and serving on network workers</li>
                <li><Link href="/docs" className="text-[var(--accent)] hover:underline">All Infernet docs</Link></li>
            </ul>
        </main>
    );
}
