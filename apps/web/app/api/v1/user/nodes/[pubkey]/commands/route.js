import { NextResponse } from "next/server";
import { handleRoute } from "@/lib/http";
import { verifyBearerHeader } from "@/lib/auth/bearer";
import { getCurrentUser } from "@/lib/supabase/auth-server";
import {
    issueCommand,
    listCommandsForPubkey,
    userOwnsPubkey,
    isValidCommand
} from "@/lib/data/node-commands";
import { validateTrainingConfig } from "@infernetprotocol/config/training-config";

export const dynamic = "force-dynamic";

/**
 * Owner-issued node command surface.
 *
 *   POST /api/v1/user/nodes/<pubkey>/commands
 *     body: { command: string, args?: object }
 *     auth: CLI bearer OR Supabase session cookie (browser /dashboard)
 *     owner check: pubkey_links(user_id=claims.sub, pubkey=<param>)
 *
 *   GET  /api/v1/user/nodes/<pubkey>/commands?limit=20
 *     auth + owner check identical to POST
 *     returns recent commands for the node (status, result, error, etc.)
 *
 * Non-owners get 403, not 404, so legitimate owners with bad pubkeys
 * still see a useful error.
 */

async function resolveUser(request) {
    const claims = verifyBearerHeader(request.headers.get("authorization"));
    if (claims?.sub) return { userId: claims.sub };
    try {
        const user = await getCurrentUser();
        if (user?.id) return { userId: user.id };
    } catch { /* fall through */ }
    return null;
}

async function authorizeOwner(request, pubkey) {
    const auth = await resolveUser(request);
    if (!auth) {
        const err = new Error("not signed in");
        err.status = 401;
        throw err;
    }
    if (!(await userOwnsPubkey(auth.userId, pubkey))) {
        const err = new Error("you don't own that node");
        err.status = 403;
        throw err;
    }
    return auth.userId;
}

export async function POST(request, { params }) {
    return handleRoute(async () => {
        const { pubkey } = await params;
        const userId = await authorizeOwner(request, pubkey);

        let body;
        try {
            body = await request.json();
        } catch {
            const err = new Error("invalid JSON body");
            err.status = 400;
            throw err;
        }

        const command = String(body?.command ?? "").trim();
        const args = body?.args && typeof body.args === "object" ? body.args : {};

        if (!isValidCommand(command)) {
            const err = new Error(`unknown command: ${command}`);
            err.status = 400;
            throw err;
        }

        // Per-command arg validation. Keep this central so the daemon
        // only ever sees well-shaped args.
        if (command === "model_install" || command === "model_remove") {
            const model = String(args.model ?? "").trim();
            if (!model || model.length > 256) {
                const err = new Error(`${command} requires args.model (1..256 chars)`);
                err.status = 400;
                throw err;
            }
            args.model = model;
            // Optional HF repo — lets a GPU node serve this model on vLLM
            // instead of Ollama. Keep it well-shaped or drop it.
            if (command === "model_install" && args.hf != null) {
                const hf = String(args.hf).trim();
                if (hf && hf.length <= 256) args.hf = hf;
                else delete args.hf;
            }
        }
        if (command === "train_shard") {
            if (!args.shard_url || !args.base_model) {
                const err = new Error("train_shard requires args.shard_url and args.base_model");
                err.status = 400;
                throw err;
            }
            // The daemon renders these into a Python script: numbers and
            // names only (the daemon re-checks before it renders).
            const checked = validateTrainingConfig({
                base_model: args.base_model,
                training: args.training ?? undefined,
                lora: args.lora ?? undefined
            });
            args.base_model = checked.base_model;
            if (checked.training) args.training = checked.training;
            if (checked.lora) args.lora = checked.lora;
            // Owner-only path to the owner's own nodes, so LAN http is fine;
            // the public market (training-market.js) requires public https.
            for (const key of ["shard_url", "upload_url"]) {
                if (args[key] == null) continue;
                let ok = false;
                try { ok = ["http:", "https:"].includes(new URL(String(args[key])).protocol); } catch { /* not a URL */ }
                if (!ok) {
                    const err = new Error(`train_shard: args.${key} must be an http(s) URL`);
                    err.status = 400;
                    throw err;
                }
            }
        }

        const row = await issueCommand({ userId, pubkey, command, args });
        return NextResponse.json({ data: row });
    });
}

export async function GET(request, { params }) {
    return handleRoute(async () => {
        const { pubkey } = await params;
        const userId = await authorizeOwner(request, pubkey);
        const url = new URL(request.url);
        const limit = Number.parseInt(url.searchParams.get("limit") ?? "", 10) || 20;
        const rows = await listCommandsForPubkey({ userId, pubkey, limit });
        return NextResponse.json({ data: rows });
    });
}
