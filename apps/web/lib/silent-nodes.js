import "server-only";

/**
 * "Your node went offline" email (docs/prd/01-live-supply.md req 4). Run by the
 * maintenance cron. A provider or aggregator that has been silent for a day and
 * is linked to an account gets one email per outage: a heartbeat clears
 * silence_emailed_at (lib/data/node-api.js), so the next outage mails again.
 * Nodes silent for more than a week are left alone.
 */

const HOUR = 60 * 60_000;
export const SILENT_AFTER_MS = 24 * HOUR;
const SILENT_GIVE_UP_MS = 7 * 24 * HOUR;
const MAX_PER_RUN = 25;
export const SILENT_NODE_FROM = "Infernet Nodes <nodes@infernetprotocol.com>";
const SITE = "https://infernetprotocol.com";

export function buildSilentNodeEmail({ node, role }) {
    const name = node.name ?? node.node_id ?? node.id;
    const since = node.last_seen ? new Date(node.last_seen).toUTCString() : "a while ago";
    const page = `${SITE}/nodes/${node.id}`;
    const subject = `Your Infernet ${role} "${name}" went offline`;
    const text = [
        `Your Infernet ${role} "${name}" has not checked in since ${since}.`,
        "",
        "To bring it back, on that machine run:",
        "",
        "  curl -fsSL https://infernetprotocol.com/install.sh | sh   # update to the latest CLI",
        "  infernet setup --yes                                       # restarts it as a service",
        "",
        "Since v0.1.62 the node runs as a systemd user service (Linux) or a launchd agent (macOS),",
        "so it restarts by itself after crashes, reboots and updates. On other systems",
        "`infernet start` runs a built-in supervisor that does the same.",
        "",
        `Node page: ${page}`,
        "Not running this node any more? `infernet remove` deletes it and these emails stop.",
        "",
        "Infernet Protocol"
    ].join("\n");
    const esc = (v) => String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const html = `<p>Your Infernet ${role} <strong>${esc(name)}</strong> has not checked in since ${esc(since)}.</p>
<p>To bring it back, on that machine run:</p>
<pre>curl -fsSL https://infernetprotocol.com/install.sh | sh
infernet setup --yes</pre>
<p>Since v0.1.62 the node runs as a systemd user service (Linux) or a launchd agent (macOS), so it restarts by itself after crashes, reboots and updates. On other systems <code>infernet start</code> runs a built-in supervisor that does the same.</p>
<p><a href="${page}">Node page</a>. Not running this node any more? <code>infernet remove</code> deletes it and these emails stop.</p>
<p>Infernet Protocol</p>`;
    return { subject, text, html };
}

async function sendEmail({ to, subject, text, html, apiKey, fetchImpl }) {
    const res = await fetchImpl("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from: process.env.NODES_FROM_EMAIL ?? SILENT_NODE_FROM, to: [to], subject, text, html })
    });
    if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`Resend ${res.status}: ${detail.slice(0, 300)}`);
    }
}

/**
 * @param {object} supabase service-role client
 * @returns {Promise<{ emailed: number, skipped: number, errors: number }>}
 */
export async function emailSilentNodes(supabase, { now = new Date(), apiKey = process.env.RESEND_API_KEY, fetchImpl = fetch } = {}) {
    const out = { emailed: 0, skipped: 0, errors: 0 };
    if (!apiKey) return out;
    const newest = new Date(now.getTime() - SILENT_AFTER_MS).toISOString();
    const oldest = new Date(now.getTime() - SILENT_GIVE_UP_MS).toISOString();

    for (const [table, role] of [["providers", "provider"], ["aggregators", "aggregator"]]) {
        if (out.emailed >= MAX_PER_RUN) break;
        const { data: nodes, error } = await supabase
            .from(table)
            .select("id, name, node_id, public_key, last_seen")
            .is("silence_emailed_at", null)
            .lt("last_seen", newest)
            .gte("last_seen", oldest)
            .limit(MAX_PER_RUN);
        if (error) throw new Error(`silent-nodes: ${table}: ${error.message}`);
        for (const node of nodes ?? []) {
            if (out.emailed >= MAX_PER_RUN) break;
            // Mark first: a crash after sending must not mail again every 5 minutes.
            const stamp = now.toISOString();
            const { data: claimed } = await supabase.from(table).update({ silence_emailed_at: stamp })
                .eq("id", node.id).is("silence_emailed_at", null).select("id");
            if (!claimed?.length) continue;
            const { data: link } = await supabase.from("pubkey_links").select("user_id")
                .eq("pubkey", node.public_key).limit(1).maybeSingle();
            if (!link?.user_id) { out.skipped += 1; continue; }
            const { data: userData } = await supabase.auth.admin.getUserById(link.user_id);
            const email = userData?.user?.email;
            if (!email) { out.skipped += 1; continue; }
            try {
                await sendEmail({ to: email, apiKey, fetchImpl, ...buildSilentNodeEmail({ node, role }) });
                out.emailed += 1;
            } catch (err) {
                out.errors += 1;
                console.error(`[silent-nodes] ${node.id}: ${err?.message ?? err}`);
            }
        }
    }
    return out;
}
