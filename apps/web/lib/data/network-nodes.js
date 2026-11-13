// Node counts for the public status page.
//
// Two kinds of machine do Infernet work:
//   - Infernet providers: the `infernet` CLI, heartbeating into `providers`.
//     They serve the LLM chat models.
//   - c0mpute workers: the speech, music, image and video jobs Infernet sends
//     to the c0mpute gateway run on them. They never touch `providers`, so a
//     page that counts only providers shows a fraction of the live network.
//
// The worker card stays its own number: one box can run both, and c0mpute
// does not publish addresses to dedupe by. The LLM card is the exception: it
// adds the c0mpute workers that serve LLM chat (Infernet chat routes to them)
// and says in its note how the sum splits and that it may overlap.

const ONLINE_MS = 10 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Bucket provider rows by how recently they heartbeated. `registered` keeps
 * every row ever created (each re-init, machine or container adds one and
 * nothing deletes them), so on its own it reads like 90% of the network is
 * down. `week` is the number worth showing beside `online`.
 */
export function summarizeProviders(rows, now = Date.now()) {
  let online = 0;
  let week = 0;
  let archived = 0;
  for (const p of rows ?? []) {
    if (p?.status === "archived") {
      archived += 1;
      continue;
    }
    const seen = p?.last_seen ? new Date(p.last_seen).getTime() : NaN;
    if (!Number.isFinite(seen)) continue;
    const age = now - seen;
    if (p.status === "available" && age < ONLINE_MS) online += 1;
    else if (age < WEEK_MS) week += 1;
  }
  const registered = (rows ?? []).length;
  return { online, week, archived, dormant: registered - online - week - archived, registered };
}

export function providerNote({ week, dormant }) {
  const parts = [];
  if (week > 0) parts.push(`${week} more seen this week`);
  if (dormant > 0) parts.push(`${dormant} dormant`);
  return parts.length ? `LLM chat · ${parts.join(" · ")}` : "LLM chat";
}

/**
 * The public "LLM providers online" card: Infernet providers plus c0mpute
 * workers that serve LLM chat (workload infernet.inference; chat sends a
 * request there when no Infernet provider serves the model). The big number is
 * the sum and the note says how it splits. It may count a box twice: one
 * machine can run the infernet CLI and a c0mpute worker, and c0mpute publishes
 * no addresses to dedupe by, so the note says "may overlap" rather than
 * pretending otherwise.
 *
 * `inference` is summarizeC0mputeInference() output, or null when c0mpute's
 * status was unreachable (the card then counts Infernet only, and says so).
 */
export function llmProvidersCard(summary, inference) {
  const infernet = summary?.online ?? 0;
  const rest = [];
  if (summary?.week > 0) rest.push(`${summary.week} more seen this week`);
  if (summary?.dormant > 0) rest.push(`${summary.dormant} dormant`);
  if (inference == null) {
    return {
      label: "LLM providers online",
      value: infernet,
      note: [`${infernet} Infernet (c0mpute count unavailable)`, ...rest].join(" · ")
    };
  }
  const c0mpute = inference.workers ?? 0;
  const split = c0mpute > 0
    ? `${infernet} Infernet + ${c0mpute} c0mpute (may overlap)`
    : `${infernet} Infernet + 0 c0mpute`;
  return {
    label: "LLM providers online",
    value: infernet + c0mpute,
    note: [split, ...rest].join(" · ")
  };
}

/**
 * Parse c0mpute's public GET /api/nodes. Returns null for anything that is
 * not that shape (the site answers some outages with an HTML 200).
 */
export function summarizeC0mputeNodes(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.nodes)) return null;
  const nodes = body.nodes;
  const gpu = nodes.filter((n) => typeof n?.class === "string" && n.class.startsWith("gpu")).length;
  const online = Number.isFinite(body.workers_online) ? body.workers_online : nodes.length;
  return { online, gpu };
}

export function c0mputeCard(summary) {
  if (!summary) {
    return { label: "c0mpute workers", value: "—", note: "c0mpute network unreachable right now" };
  }
  const gpu = summary.gpu > 0 ? ` · ${summary.gpu} GPU` : "";
  return {
    label: "c0mpute workers",
    value: summary.online,
    note: `run speech, music, image + video jobs${gpu}`
  };
}

const C0MPUTE_NODES_URL = process.env.C0MPUTE_NODES_URL || "https://c0mpute.com/api/nodes";

/** Live c0mpute worker summary, or null when the network is unreachable. */
export async function fetchC0mputeSummary({ fetchImpl = fetch, timeoutMs = 4000 } = {}) {
  try {
    const res = await fetchImpl(C0MPUTE_NODES_URL, {
      headers: { accept: "application/json", "user-agent": "infernet-web" },
      signal: AbortSignal.timeout(timeoutMs),
      next: { revalidate: 30 }
    });
    if (!res.ok) return null;
    return summarizeC0mputeNodes(await res.json());
  } catch {
    return null;
  }
}
