import "server-only";
import { NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createLimiter, phaseOf, limitHeaders, tokenAllowanceLeft, tokenReservationFor, estimateTokens, publicReservation } from "@/lib/reservations/core";
import { resolveKey, recordUsage, addTokens, reserveTokens, settleTokens } from "@/lib/data/reservations";
import { getModelDenylist } from "@/lib/data/blocklists";
import { deniedModel } from "@/lib/moderation/blocklists";
import { forwardToEndpoint } from "@/lib/data/reservation-upstream";
import { createChatJob } from "@/lib/data/chat";
import { streamJobEvents } from "@/lib/data/chat-stream";
import { trustedClientFor, billedSubjectFrom } from "@/lib/trusted-clients";
import { authorizeInteractive, userIdForCoinpaySubject } from "@/lib/data/interactive-billing";
import { purgeJobContent } from "@/lib/data/job-retention";
import { houseLaneBillingOk, houseLaneBalanceError } from "@/lib/reservations/house-lane";
import { chargeIdemKey } from "@/lib/billing/interactive";
import { getSupabaseServerClient } from "@/lib/supabase/server";

/**
 * /v1/chat/completions and /v1/models for reservation keys (ifr_res_...).
 *
 * A reservation key only ever reaches its reservation's pinned target with
 * one of its exact models, only inside the reserved window, and only within
 * the agreed per-key / shared limits and included tokens. Refusals are 429s
 * with X-Infernet-Limit-Type / X-Infernet-Limit-Scope / Retry-After headers.
 */

const limiter = createLimiter();

function err(status, message, code, headers = {}, extra = {}) {
    return NextResponse.json(
        { error: { message, type: "infernet_reservation_error", code, ...extra } },
        { status, headers }
    );
}

async function authenticate(rawKey) {
    const hit = await resolveKey(rawKey);
    if (!hit) return { error: err(401, "invalid or revoked reservation key", "invalid_key") };
    return hit;
}

function windowError(res) {
    const phase = phaseOf(res);
    if (phase === "active") return null;
    const r = publicReservation(res);
    const msg = phase === "upcoming" ? `reservation starts at ${r.start_at}`
        : phase === "ended" ? `reservation ended at ${r.end_at}`
        : "reservation cancelled";
    return err(403, msg, `reservation_${phase}`, {}, { start_at: r.start_at, end_at: r.end_at });
}

export async function serveModels(rawKey) {
    const auth = await authenticate(rawKey);
    if (auth.error) return auth.error;
    const res = auth.reservation;
    return NextResponse.json({
        object: "list",
        data: res.models.map((id) => ({ id, object: "model", owned_by: res.operator_name, created: Math.floor(new Date(res.start_at).getTime() / 1000) }))
    });
}

export async function serveChatCompletion(request, rawKey) {
    const auth = await authenticate(rawKey);
    if (auth.error) return auth.error;
    const { reservation: res, key } = auth;

    const closed = windowError(res);
    if (closed) return closed;

    let body;
    try { body = await request.json(); } catch { return err(400, "invalid JSON body", "invalid_body"); }
    const { model, messages } = body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) return err(400, "messages[] is required", "invalid_body");
    if (typeof model !== "string" || !res.models.includes(model)) {
        return err(400, `model must be one of the reserved models: ${res.models.join(", ")}`, "model_not_reserved", {}, { reserved_models: res.models });
    }

    if (deniedModel(await getModelDenylist(), model)) {
        return err(403, `model "${model}" is not available on Infernet`, "model_denied");
    }

    // House lane: confidential, paid per request by the person a trusted
    // client names, on the pinned house node only, with nothing kept.
    let house = null;
    if (res.house_lane) {
        const auth = await authorizeHouseLane(request, model);
        if (auth.error) return auth.error;
        house = auth;
    }

    const base = { reservation_id: res.id, key_id: key.id, model };

    if (res.included_tokens > 0 && tokenAllowanceLeft(res) <= 0) {
        await recordUsage({ ...base, outcome: "limit_tokens", limit_scope: "shared", http_status: 429 });
        return err(429, `included token allowance (${res.included_tokens}) is used up`, "token_allowance_exhausted",
            limitHeaders(res, { type: "tokens", scope: "shared", limit: res.included_tokens, retryAfterMs: 3600_000 }));
    }

    const slot = limiter.acquire(res, key.id);
    if (!slot.ok) {
        await recordUsage({ ...base, outcome: `limit_${slot.type}`, limit_scope: slot.scope, http_status: 429 });
        return err(429, `${slot.scope} ${slot.type} limit of ${slot.limit} reached`, `limit_${slot.type}_${slot.scope}`, slot.headers);
    }

    // The included-token cap is enforced in the DB: reserve the most this
    // call can use (prompt + max_tokens) atomically, settle to actual after.
    let reserved = 0;
    const want = tokenReservationFor(res, body);
    if (want > 0) {
        const r = await reserveTokens(res.id, want);
        if (r.ok === false) {
            slot.release();
            await recordUsage({ ...base, outcome: "limit_tokens", limit_scope: "shared", http_status: 429 });
            const left = tokenAllowanceLeft(res);
            return err(429, `included token allowance (${res.included_tokens}) cannot cover this request: about ${left} left, the request may use up to ${want}; lower max_tokens`, "token_allowance_exhausted",
                limitHeaders(res, { type: "tokens", scope: "shared", limit: res.included_tokens, remaining: left, retryAfterMs: 3600_000 }));
        }
        if (r.ok) reserved = want;
    }

    const t0 = Date.now();
    let finished = false;
    const finish = async ({ outcome, prompt = 0, completion = 0, estimated = false, status }) => {
        if (finished) return;
        finished = true;
        slot.release();
        await recordUsage({ ...base, outcome, prompt_tokens: prompt, completion_tokens: completion, tokens_estimated: estimated, latency_ms: Date.now() - t0, http_status: status });
        if (reserved > 0) await settleTokens(res.id, reserved, prompt + completion);
        else if (prompt + completion > 0) await addTokens(res.id, prompt + completion);
    };
    const headers = { ...slot.headers, "X-Infernet-Reservation": res.id, "X-Infernet-Operator": res.operator_name };
    if (house) headers["X-Infernet-Lane"] = "house";

    try {
        return res.target_kind === "endpoint"
            ? await viaEndpoint(res, body, headers, finish)
            : await viaNode(res, body, headers, finish, house);
    } catch (e) {
        await finish({ outcome: "upstream_error", status: 502 });
        return err(502, `pinned endpoint failed: ${e?.message ?? e}`, "upstream_error", headers);
    }
}

// ---- house lane --------------------------------------------------------------

/**
 * Who pays for a house-lane request, or the refusal. The lane is paid only and
 * serves only our trusted clients: the trusted key is a header of its own
 * (the bearer is the reservation key), and the subject it names must have a
 * balance. A free, unlinked or unreadable caller is refused, never served.
 */
async function authorizeHouseLane(request, model) {
    const trusted = trustedClientFor(request.headers.get("x-infernet-client-key")?.trim() ?? null);
    if (!trusted) {
        return { error: err(403, "a house-lane reservation serves only a trusted client (X-Infernet-Client-Key)", "house_lane_client_required") };
    }
    const sub = billedSubjectFrom(request, trusted);
    if (!sub) {
        return { error: err(403, "a house-lane request must name who pays (X-Infernet-Billed-Subject)", "house_lane_subject_required") };
    }
    const userId = await userIdForCoinpaySubject(sub);
    const billing = userId
        ? await authorizeInteractive({ userId, model })
        : { mode: "free", reason: "unlinked", spendable_usd: "0.000000" };
    if (!houseLaneBillingOk(billing)) {
        const e = houseLaneBalanceError(billing);
        return { error: err(e.status, e.message, e.code, {}, e.extra) };
    }
    return { userId, mode: billing.mode };
}

/**
 * What the person was charged for a finished house-lane job. The charge is
 * written when the node reports completion, which can land a moment after the
 * last token, so wait briefly for it. Null when it has not landed (the caller
 * is still charged; it just is not in this response).
 */
async function houseCharge(jobId, { waitMs = 4000 } = {}) {
    try {
        const supabase = getSupabaseServerClient();
        const until = Date.now() + waitMs;
        for (;;) {
            const { data } = await supabase
                .from("billing_ledger")
                .select("amount_micro")
                .eq("idem_key", chargeIdemKey(jobId))
                .maybeSingle();
            if (data) return { charged_micro: Number(data.amount_micro), charged_usd: (Number(data.amount_micro) / 1e6).toFixed(6) };
            if (Date.now() >= until) return null;
            await new Promise((r) => setTimeout(r, 500));
        }
    } catch {
        return null;
    }
}

function houseReceipt(res, model, charge) {
    return {
        lane: "house",
        operator: res.operator_name,
        model,
        billed: true,
        ...(charge ? { charged_usd: charge.charged_usd, charged_micro: charge.charged_micro } : { charge_pending: true })
    };
}

// ---- endpoint target: proxy to the operator's OpenAI-compatible URL --------

async function viaEndpoint(res, body, headers, finish) {
    const stream = body.stream === true;
    const upstreamBody = { ...body, model: body.model };
    if (stream) upstreamBody.stream_options = { ...(body.stream_options ?? {}), include_usage: true };
    const up = await forwardToEndpoint(res, upstreamBody);

    if (!up.ok) {
        const text = await up.text().catch(() => "");
        // A 4xx from upstream is the caller's request (bad params), not an outage.
        const outage = up.status >= 500 || up.status === 404;
        await finish({ outcome: outage ? "upstream_error" : "ok", status: up.status });
        return new Response(text || JSON.stringify({ error: { message: `upstream HTTP ${up.status}` } }), {
            status: outage ? 502 : up.status,
            headers: { "content-type": up.headers.get("content-type") ?? "application/json", ...headers }
        });
    }

    if (!stream) {
        const j = await up.json();
        const u = j?.usage ?? {};
        const estimated = !Number.isFinite(u.prompt_tokens);
        const prompt = estimated ? estimateTokens(JSON.stringify(body.messages)) : u.prompt_tokens;
        const completion = Number.isFinite(u.completion_tokens) ? u.completion_tokens
            : estimateTokens(j?.choices?.[0]?.message?.content ?? "");
        await finish({ outcome: "ok", prompt, completion, estimated, status: 200 });
        return NextResponse.json(j, { headers });
    }

    // Stream: pass bytes through untouched, watching for the usage chunk.
    const decoder = new TextDecoder();
    const reader = up.body.getReader();
    let buf = "", usage = null, chars = 0, settled = false;
    const settle = async (outcome, status) => {
        if (settled) return;
        settled = true;
        await finish({
            outcome, status, estimated: !usage,
            prompt: usage?.prompt_tokens ?? estimateTokens(JSON.stringify(body.messages)),
            completion: usage?.completion_tokens ?? Math.ceil(chars / 4)
        });
    };
    const watch = (bytes) => {
        buf += decoder.decode(bytes, { stream: true });
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:") || line.includes("[DONE]")) continue;
            try {
                const j = JSON.parse(line.slice(5));
                if (j?.usage) usage = j.usage;
                chars += (j?.choices?.[0]?.delta?.content ?? "").length;
            } catch { /* partial or non-JSON line */ }
        }
    };
    const out = new ReadableStream({
        async pull(ctl) {
            try {
                const { done, value } = await reader.read();
                if (done) { await settle("ok", 200); ctl.close(); return; }
                watch(value);
                ctl.enqueue(value);
            } catch (e) {
                await settle("upstream_error", 502);
                ctl.error(e);
            }
        },
        // The client hung up: free the concurrency slot and stop reading upstream.
        async cancel() {
            await settle("ok", 499);
            try { await reader.cancel(); } catch { /* already closed */ }
        }
    });
    return new Response(out, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", ...headers }
    });
}

// ---- node target: an Infernet job pinned to one provider ------------------

function chunk(id, model, delta, finish = null) {
    return { id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason: finish }] };
}

async function viaNode(res, body, headers, finish, house = null) {
    const { messages, model } = body;
    const bundle = await createChatJob({
        messages,
        modelName: model,
        providerId: res.provider_id,
        pinned: true,
        reservationId: res.id,
        maxTokens: Number.isFinite(body.max_tokens) ? body.max_tokens : undefined,
        temperature: Number.isFinite(body.temperature) ? body.temperature : undefined,
        // House lane: charged to the caller's balance on completion, and no
        // content kept once the request is over.
        ...(house ? { billedUserId: house.userId, noRetain: true } : {})
    });
    if (bundle.source !== "p2p" || bundle.job?.provider_id !== res.provider_id) {
        await finish({ outcome: "upstream_error", status: 503 });
        // A job row recorded as failed still carries the prompt until purged.
        if (house && bundle.job?.id) await purgeJobContent(bundle.job.id);
        return err(503, "the pinned operator node is not available right now", "pinned_node_unavailable", headers);
    }
    // House lane: the content goes as soon as the answer is out, whatever happened.
    const done = async (args) => {
        await finish(args);
        if (house) await purgeJobContent(bundle.job.id);
    };
    const id = `chatcmpl-${randomUUID().replace(/-/g, "").slice(0, 24)}`;
    const prompt = estimateTokens(JSON.stringify(messages));

    if (body.stream === true) {
        const enc = new TextEncoder();
        let closed = false;
        let keepalive = null;
        const sse = new ReadableStream({
            async start(ctl) {
                const send = (s) => {
                    if (closed) return;
                    try { ctl.enqueue(enc.encode(s)); } catch { closed = true; }
                };
                const push = (o) => send(`data: ${typeof o === "string" ? o : JSON.stringify(o)}\n\n`);
                // A CPU node can spend minutes on the prompt before its first
                // token: a comment line every 15 s keeps proxies from closing
                // the idle connection (OpenAI clients skip comments).
                keepalive = setInterval(() => send(": keepalive\n\n"), 15_000);
                keepalive.unref?.();
                let text = "", ok = false, ended = false;
                try {
                    push(chunk(id, model, { role: "assistant", content: "" }));
                    for await (const ev of streamJobEvents(bundle.job.id)) {
                        if (closed) break;
                        if (ev.type === "token") {
                            const t = ev.data?.text ?? "";
                            if (t) { text += t; push(chunk(id, model, { content: t })); }
                        } else if (ev.type === "done") { ok = true; ended = true; break; }
                        else if (ev.type === "error") { ended = true; push({ id, object: "chat.completion.chunk", error: { message: ev.data?.message ?? "engine error" } }); break; }
                    }
                    if (ok) push(chunk(id, model, {}, "stop"));
                    if (ok && house) {
                        // The receipt rides one extra chunk OpenAI clients ignore (no choices).
                        const charge = await houseCharge(bundle.job.id);
                        push({ id, object: "infernet.house", x_infernet: houseReceipt(res, model, charge),
                            usage: { prompt_tokens: prompt, completion_tokens: estimateTokens(text), estimated: true } });
                    }
                    push("[DONE]");
                } finally {
                    clearInterval(keepalive);
                    const args = { outcome: ok ? "ok" : "upstream_error", status: ok ? 200 : closed ? 499 : 502, prompt, completion: estimateTokens(text), estimated: true };
                    // The caller left while the node was still working: the node
                    // still needs the prompt, so the purge waits for the job to
                    // finish (the reservations cron sweeps it then).
                    if (ended || !house) await done(args);
                    else await finish(args);
                    try { ctl.close(); } catch { /* closed */ }
                }
            },
            cancel() {
                closed = true;
                clearInterval(keepalive);
            }
        });
        return new Response(sse, { headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no", ...headers } });
    }

    let text = "", ok = false, failure = null;
    for await (const ev of streamJobEvents(bundle.job.id)) {
        if (ev.type === "token") text += ev.data?.text ?? "";
        else if (ev.type === "done") {
            if (typeof ev.data?.text === "string" && ev.data.text.length > text.length) text = ev.data.text;
            ok = true;
            break;
        } else if (ev.type === "error") { failure = ev.data?.message ?? "engine error"; break; }
    }
    const completion = estimateTokens(text);
    const charge = ok && house ? await houseCharge(bundle.job.id) : null;
    await done({ outcome: ok ? "ok" : "upstream_error", status: ok ? 200 : 502, prompt, completion, estimated: true });
    if (!ok) return err(502, failure ?? "stream ended without a response", "upstream_error", headers);
    return NextResponse.json({
        id, object: "chat.completion", created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion, estimated: true },
        ...(house ? { x_infernet: houseReceipt(res, model, charge) } : {})
    }, { headers });
}
