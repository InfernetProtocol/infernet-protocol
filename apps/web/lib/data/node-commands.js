import "server-only";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * node_commands data layer — owner-side issuing + daemon-side polling.
 * Server-only; every entry point re-checks who's allowed to do what
 * before touching the table.
 */

const KNOWN_COMMANDS = new Set(["model_install", "model_remove", "train_shard"]);
const MAX_POLL_LIMIT = 10;
// Same liveness window as the daily report's "live" count and the reaper.
const NODE_LIVE_MS = 10 * 60 * 1000;
const MAX_ERROR_CHARS = 2000;

/**
 * Turn a daemon's error output into something a dashboard can show. Ollama
 * and hf write progress spinners and cursor codes to the same stream as the
 * error, so the stored text was mostly `\x1B[?25l pulling manifest ⠋ ...`
 * with the actual cause at the end, often cut off. Strip the terminal
 * control sequences, keep the last line of each carriage-return redraw, and
 * keep the tail, where the cause is.
 */
export function cleanCommandError(text) {
    if (typeof text !== "string") return text;
    const cleaned = text
        // CSI (colours, cursor show/hide, ?2026h sync) and OSC sequences.
        .replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
        .replace(/\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)/g, "")
        .replace(/\x1B[@-Z\\-_]/g, "")
        // A spinner redraws one line with \r; only the last frame matters.
        .split("\n")
        .map((line) => line.split("\r").filter((part) => part.trim()).pop() ?? "")
        .map((line) => line.trimEnd())
        .filter((line, i, all) => line || (i > 0 && all[i - 1]))
        .join("\n")
        .trim();
    return cleaned.length > MAX_ERROR_CHARS ? "…" + cleaned.slice(-MAX_ERROR_CHARS) : cleaned;
}

/**
 * Throw 409 unless the node behind `pubkey` has sent a heartbeat recently.
 * Commands are delivered by the daemon's own poll, so one queued for a node
 * that is not running just sat until the 24 h reaper failed it: 21 of the 60
 * failed commands in production were exactly that.
 */
export async function assertNodeLive(pubkey, now = Date.now()) {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("providers")
        .select("last_seen")
        .eq("public_key", pubkey)
        .maybeSingle();
    if (error) throw new Error(error.message);
    const seen = data?.last_seen ? Date.parse(data.last_seen) : NaN;
    if (Number.isFinite(seen) && now - seen <= NODE_LIVE_MS) return;
    const when = Number.isFinite(seen) ? `last heartbeat ${new Date(seen).toISOString()}` : "it has never sent a heartbeat";
    const err = new Error(
        `this node is offline (${when}); start it with \`infernet start\` and send the command again`
    );
    err.status = 409;
    throw err;
}

export function isValidCommand(verb) {
    return KNOWN_COMMANDS.has(verb);
}

/**
 * Verify that user_id owns the target pubkey via pubkey_links.
 * Returns true / false; throws only on DB errors.
 */
export async function userOwnsPubkey(userId, pubkey) {
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("pubkey_links")
        .select("id")
        .eq("user_id", userId)
        .eq("pubkey", pubkey)
        .maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
}

/**
 * Owner inserts a command targeting a specific node. Caller MUST have
 * already verified the user owns the pubkey.
 */
export async function issueCommand({ userId, pubkey, command, args }) {
    if (!isValidCommand(command)) {
        const err = new Error(`unknown command: ${command}`);
        err.status = 400;
        throw err;
    }
    await assertNodeLive(pubkey);
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("node_commands")
        .insert({
            pubkey,
            command,
            args: args ?? {},
            issued_by: userId,
            status: "pending"
        })
        .select("id, command, args, status, issued_at")
        .single();
    if (error) {
        const err = new Error(error.message);
        err.status = 500;
        throw err;
    }
    return data;
}

/**
 * Owner cancels an in-flight command. Only pending/running commands can be
 * cancelled; terminal ones (completed/failed/cancelled) are left as-is.
 * The daemon learns about the cancel via its next progress post (whose
 * response echoes the current status) and stops the running process.
 */
export async function cancelCommand({ userId, pubkey, commandId }) {
    if (!(await userOwnsPubkey(userId, pubkey))) {
        const err = new Error("not the owner of that pubkey");
        err.status = 403;
        throw err;
    }
    const supabase = getSupabaseServerClient();
    const { data: row, error: lookErr } = await supabase
        .from("node_commands")
        .select("id, pubkey, status")
        .eq("id", commandId)
        .maybeSingle();
    if (lookErr) throw new Error(lookErr.message);
    if (!row) {
        const err = new Error("command not found");
        err.status = 404;
        throw err;
    }
    if (row.pubkey !== pubkey) {
        const err = new Error("command does not target this pubkey");
        err.status = 403;
        throw err;
    }
    if (!["pending", "running"].includes(row.status)) {
        // Already terminal — nothing to cancel.
        return { id: commandId, status: row.status, cancelled: false };
    }
    const { data, error } = await supabase
        .from("node_commands")
        .update({
            status: "cancelled",
            completed_at: new Date().toISOString(),
            error: "cancelled by user"
        })
        .eq("id", commandId)
        .in("status", ["pending", "running"])
        .select("id, status")
        .maybeSingle();
    if (error) throw new Error(error.message);
    return { id: commandId, status: data?.status ?? "cancelled", cancelled: true };
}

/**
 * List recent commands targeting a pubkey. Owner-side dashboard view —
 * caller passes the user_id and we re-verify ownership.
 */
export async function listCommandsForPubkey({ userId, pubkey, limit = 20 }) {
    if (!(await userOwnsPubkey(userId, pubkey))) {
        const err = new Error("not the owner of that pubkey");
        err.status = 403;
        throw err;
    }
    const supabase = getSupabaseServerClient();
    const { data, error } = await supabase
        .from("node_commands")
        .select("id, command, args, status, result, error, progress, issued_at, started_at, completed_at")
        .eq("pubkey", pubkey)
        .order("issued_at", { ascending: false })
        .limit(Math.min(Math.max(limit, 1), 100));
    if (error) throw new Error(error.message);
    return data ?? [];
}

/**
 * Daemon claims pending commands for itself: status pending → running,
 * starts_at = now, returns the rows it claimed. Atomic-ish via
 * select-then-update; in the rare race where two daemon instances poll
 * with the same pubkey, both might see the same row but only one will
 * succeed at flipping it (status='pending' guard in the update).
 */
export async function pollCommandsForNode({ pubkey, limit = 5 }) {
    const supabase = getSupabaseServerClient();
    const safeLimit = Math.min(Math.max(Number(limit) || 5, 1), MAX_POLL_LIMIT);

    const { data: pending, error: peekErr } = await supabase
        .from("node_commands")
        .select("id, command, args, status")
        .eq("pubkey", pubkey)
        .eq("status", "pending")
        .order("issued_at", { ascending: true })
        .limit(safeLimit);
    if (peekErr) throw new Error(peekErr.message);

    const claimed = [];
    for (const row of pending ?? []) {
        const { data: updated, error: upErr } = await supabase
            .from("node_commands")
            .update({ status: "running", started_at: new Date().toISOString() })
            .eq("id", row.id)
            .eq("status", "pending")
            .select("id, command, args")
            .maybeSingle();
        if (upErr) continue;
        if (updated) claimed.push(updated);
    }
    return { commands: claimed };
}

/**
 * Daemon reports a command finished. Verifies the row's pubkey
 * matches the daemon's pubkey before updating — prevents one
 * compromised key from completing another node's commands.
 */
export async function completeCommandForNode({ pubkey, commandId, status, result, errorMessage }) {
    if (!commandId) {
        const err = new Error("commandId is required");
        err.status = 400;
        throw err;
    }
    if (!["completed", "failed"].includes(status)) {
        const err = new Error("status must be completed | failed");
        err.status = 400;
        throw err;
    }
    const supabase = getSupabaseServerClient();
    const { data: row, error: lookErr } = await supabase
        .from("node_commands")
        .select("id, pubkey, status")
        .eq("id", commandId)
        .maybeSingle();
    if (lookErr) throw new Error(lookErr.message);
    if (!row) {
        const err = new Error("command not found");
        err.status = 404;
        throw err;
    }
    if (row.pubkey !== pubkey) {
        const err = new Error("command does not target this pubkey");
        err.status = 403;
        throw err;
    }

    // Guard: only complete a command that's still 'running'. If the owner
    // cancelled it (status='cancelled') meanwhile, don't clobber that — the
    // daemon's completion loses the race and the cancel stands.
    if (row.status !== "running") {
        return { id: commandId, status: row.status, noop: true };
    }
    const patch = {
        status,
        completed_at: new Date().toISOString(),
        ...(result !== undefined ? { result } : {}),
        ...(errorMessage ? { error: cleanCommandError(errorMessage) } : {})
    };
    const { error: upErr } = await supabase
        .from("node_commands")
        .update(patch)
        .eq("id", commandId)
        .eq("status", "running");
    if (upErr) throw new Error(upErr.message);
    return { id: commandId, status };
}

/**
 * Daemon reports incremental progress on a long-running command (e.g.
 * ollama pull). Same pubkey-match check as completeCommandForNode.
 * Stores the latest snapshot only — no history.
 */
export async function updateCommandProgressForNode({ pubkey, commandId, progress }) {
    if (!commandId) {
        const err = new Error("commandId is required");
        err.status = 400;
        throw err;
    }
    if (!progress || typeof progress !== "object") {
        const err = new Error("progress object is required");
        err.status = 400;
        throw err;
    }
    const supabase = getSupabaseServerClient();
    const { data: row, error: lookErr } = await supabase
        .from("node_commands")
        .select("id, pubkey, status")
        .eq("id", commandId)
        .maybeSingle();
    if (lookErr) throw new Error(lookErr.message);
    if (!row) {
        const err = new Error("command not found");
        err.status = 404;
        throw err;
    }
    if (row.pubkey !== pubkey) {
        const err = new Error("command does not target this pubkey");
        err.status = 403;
        throw err;
    }
    // Slim sanitization — keep the shape predictable for the frontend.
    // phase/step/steps drive the stepped progress bar (e.g. download → serve).
    const safe = {
        status: typeof progress.status === "string" ? progress.status.slice(0, 64) : null,
        phase: typeof progress.phase === "string" ? progress.phase.slice(0, 32) : null,
        step: Number.isFinite(progress.step) ? progress.step : null,
        steps: Number.isFinite(progress.steps) ? progress.steps : null,
        total: Number.isFinite(progress.total) ? progress.total : null,
        completed: Number.isFinite(progress.completed) ? progress.completed : null,
        pct: Number.isFinite(progress.pct) ? Math.max(0, Math.min(100, progress.pct)) : null
    };
    const { error: upErr } = await supabase
        .from("node_commands")
        .update({ progress: safe })
        .eq("id", commandId);
    if (upErr) throw new Error(upErr.message);
    // Echo the command's current status so the daemon can detect a cancel
    // (owner set status='cancelled') on its next progress tick — no extra
    // endpoint needed.
    return { id: commandId, progress: safe, status: row.status };
}
