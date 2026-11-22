/**
 * `infernet login` — sign in to the control plane (device-code flow).
 *
 * Three modes:
 *   infernet login                  Open browser, poll for authorization,
 *                                   save bearer token to ~/.config/infernet/config.json
 *   infernet login --url <url>      Change the control-plane URL (legacy use case;
 *                                   doesn't touch saved auth)
 *   infernet login --token <jwt>    Paste a token directly (for headless setups)
 *   infernet login --status         Show who's signed in
 *   infernet login --logout         Forget the saved bearer
 *
 * The device-code flow:
 *   1. POST <controlPlane>/api/auth/cli/start → { code, verify_url, poll_url }
 *   2. Print verify_url; try to xdg-open / open / start it
 *   3. User completes signup / signin in browser, lands on /auth/cli/<code>
 *   4. CLI polls poll_url every 2s until status=authorized → save the token
 */

import { spawn } from "node:child_process";
import { loadConfig, saveConfig, getConfigPath } from "../lib/config.js";
import pubkeyCommand from "./pubkey.js";

const HELP = `infernet login — sign in to the control plane

Usage:
  infernet login                  Device-code login (opens browser, polls)
  infernet login --url <url>      Set controlPlane.url (no auth change)
  infernet login --token <jwt>    Save a paste-in token (skip browser flow)
  infernet login --status         Print current auth state
  infernet login --logout         Clear the saved bearer
  infernet login --help

Notes:
  - Auth tokens are HMAC-signed JWTs scoped to the CLI tier (IPIP-0003).
  - Stored in ~/.config/infernet/config.json under auth.* (mode 0600).
  - Token TTL is 5 years; re-run \`infernet login\` only if you rotate secrets.
`;

function tryOpenBrowser(url) {
    const opener =
        process.platform === "darwin" ? "open" :
        process.platform === "win32" ? "cmd" :
        "xdg-open";
    const args =
        process.platform === "win32" ? ["/c", "start", "", url] : [url];
    try {
        const child = spawn(opener, args, { stdio: "ignore", detached: true });
        child.on("error", () => {});
        child.unref?.();
    } catch {
        /* ignore — operator can copy/paste the URL */
    }
}

function decodeJwtPayload(token) {
    try {
        const parts = token.split(".");
        if (parts.length !== 3) return null;
        const json = Buffer.from(parts[1], "base64url").toString("utf8");
        return JSON.parse(json);
    } catch {
        return null;
    }
}

async function saveAuth(config, { token, userId, email, expiresAt }) {
    const next = {
        ...config,
        auth: {
            userId,
            email: email ?? null,
            bearerToken: token,
            issuedAt: new Date().toISOString(),
            expiresAt: expiresAt ?? null
        }
    };
    const path = await saveConfig(next);
    return path;
}

/**
 * Best-effort: after a successful login, if this CLI also holds a
 * Nostr keypair (i.e. the user ran `infernet init` / `setup` already),
 * claim that pubkey under the freshly-authenticated user. Failures are
 * logged and ignored — `infernet pubkey link` can be re-run any time.
 */
async function autoLinkPubkey() {
    const config = (await loadConfig()) ?? {};
    const hasNode = !!(config?.node?.publicKey && config?.node?.privateKey && config?.node?.role);
    const hasAuth = !!config?.auth?.bearerToken;
    if (!hasNode || !hasAuth) return;

    const fakeArgs = {
        positional: ["link"],
        flags: new Map(),
        has() { return false; },
        get() { return undefined; }
    };
    process.stdout.write("\nLinking this node's pubkey to your account...\n  ");
    try {
        await pubkeyCommand(fakeArgs);
    } catch (err) {
        process.stderr.write(`(auto-link failed: ${err?.message ?? err}; run \`infernet pubkey link\` manually.)\n`);
    }
}

async function statusCmd(config) {
    const a = config?.auth;
    if (!a?.bearerToken) {
        process.stdout.write("Not signed in. Run `infernet login` to start.\n");
        return 1;
    }
    process.stdout.write(`Signed in as ${a.email ?? "(no email)"}\n`);
    process.stdout.write(`  user id:  ${a.userId}\n`);
    process.stdout.write(`  issued:   ${a.issuedAt}\n`);
    if (a.expiresAt) process.stdout.write(`  expires:  ${a.expiresAt}\n`);
    process.stdout.write(`  config:   ${getConfigPath()}\n`);
    return 0;
}

async function logoutCmd(config) {
    if (!config?.auth) {
        process.stdout.write("Already signed out.\n");
        return 0;
    }
    const next = { ...config };
    delete next.auth;
    await saveConfig(next);
    process.stdout.write("Signed out. Bearer cleared from local config.\n");
    return 0;
}

async function urlCmd(config, newUrl) {
    const next = {
        ...config,
        controlPlane: { ...(config?.controlPlane ?? {}), url: String(newUrl) }
    };
    const path = await saveConfig(next);
    process.stdout.write(`Control plane: ${newUrl}\nConfig: ${path}\n`);
    return 0;
}

async function tokenCmd(config, tokenStr) {
    const claims = decodeJwtPayload(tokenStr);
    if (!claims || !claims.sub) {
        process.stderr.write("error: token doesn't look like a CLI JWT\n");
        return 2;
    }
    const path = await saveAuth(config, {
        token: tokenStr,
        userId: claims.sub,
        email: claims.email ?? null,
        expiresAt: claims.exp ? new Date(claims.exp * 1000).toISOString() : null
    });
    process.stdout.write(`✓ Signed in${claims.email ? ` as ${claims.email}` : ""}\n  saved to ${path}\n`);
    await autoLinkPubkey();
    return 0;
}

export async function deviceCodeFlow(config, { baseUrl: fallbackUrl = null, out = process.stdout } = {}) {
    const baseUrl = config?.controlPlane?.url || fallbackUrl;
    if (!baseUrl) {
        process.stderr.write(
            "error: no control plane configured. Run `infernet init` first (or pass --url <url>).\n"
        );
        return 1;
    }

    let startResp;
    try {
        const res = await fetch(new URL("/api/auth/cli/start", baseUrl), {
            method: "POST",
            headers: { accept: "application/json" }
        });
        if (!res.ok) {
            process.stderr.write(`error: /api/auth/cli/start → HTTP ${res.status}\n`);
            return 1;
        }
        startResp = await res.json();
    } catch (err) {
        process.stderr.write(`error: could not reach ${baseUrl}: ${err?.message ?? err}\n`);
        return 1;
    }

    const verifyUrl = startResp.verify_url;
    const pollUrl = new URL(startResp.poll_url, baseUrl).toString();

    out.write(`\nOpen this URL to sign in:\n  ${verifyUrl}\n`);
    out.write(`(expires ${startResp.expires_at})\n\n`);
    tryOpenBrowser(verifyUrl);
    out.write("Waiting for browser sign-in...\n");

    const startedAt = Date.now();
    const timeoutMs = 10 * 60 * 1000;
    let dotted = 0;
    while (Date.now() - startedAt < timeoutMs) {
        await new Promise((r) => setTimeout(r, 2000));
        let body;
        try {
            const res = await fetch(pollUrl, { headers: { accept: "application/json" } });
            if (!res.ok) {
                if (res.status === 404) {
                    process.stderr.write("\nerror: session not found server-side\n");
                    return 1;
                }
                continue;
            }
            body = await res.json();
        } catch {
            continue;
        }

        if (body.status === "expired") {
            process.stderr.write("\nLogin link expired. Run `infernet login` again.\n");
            return 1;
        }
        if (body.status === "consumed") {
            process.stderr.write("\nThis login session was already consumed.\n");
            return 1;
        }
        if (body.status === "authorized" && body.token) {
            const path = await saveAuth(config, {
                token: body.token,
                userId: body.userId,
                email: body.email ?? null,
                expiresAt: body.expiresAt ?? null
            });
            out.write(`\n✓ Signed in${body.email ? ` as ${body.email}` : ""}\n  saved to ${path}\n`);
            await autoLinkPubkey();
            return 0;
        }

        // pending — show a heartbeat dot every 6 seconds
        dotted += 1;
        if (dotted % 3 === 0) out.write(".");
    }
    process.stderr.write("\nLogin timed out after 10 minutes.\n");
    return 1;
}

/**
 * Obtain a bearer token autonomously using the node's Nostr keypair.
 * Hits POST /api/auth/cli/node-token — no browser, no prompts.
 * Returns 0 on success, non-zero on failure.
 */
export async function nodeTokenLogin(config) {
    const baseUrl = config?.controlPlane?.url;
    const privKey = config?.node?.privateKey;
    const pubKey  = config?.node?.publicKey;
    if (!baseUrl || !privKey || !pubKey) return 1;

    let res;
    try {
        const { signRequest } = await import("@infernetprotocol/auth");
        const path = "/api/auth/cli/node-token";
        const url  = new URL(path, baseUrl).toString();
        const body = JSON.stringify({ ts: Date.now() });
        const { header } = signRequest({ method: "POST", path, body, privateKey: privKey, publicKey: pubKey });
        res = await fetch(url, {
            method: "POST",
            headers: { "X-Infernet-Auth": header, "content-type": "application/json" },
            body
        });
    } catch (err) {
        process.stderr.write(`[login] node-token fetch failed: ${err?.message ?? err}\n`);
        return 1;
    }

    if (!res.ok) {
        const msg = await res.text().catch(() => res.status);
        process.stderr.write(`[login] node-token → ${res.status}: ${msg}\n`);
        return 1;
    }

    const data = await res.json();
    await saveAuth(config, {
        token: data.token,
        userId: data.userId,
        email: data.email ?? null,
        expiresAt: data.expiresAt ?? null
    });
    process.stdout.write(`[login] bearer token refreshed (expires ${data.expiresAt})\n`);
    return 0;
}

export default async function login(args) {
    if (args.has("help") || args.has("h")) {
        process.stdout.write(HELP);
        return 0;
    }

    const config = (await loadConfig()) ?? {};

    if (args.has("status")) return statusCmd(config);
    if (args.has("logout")) return logoutCmd(config);

    const newUrl = args.get("url");
    if (newUrl) return urlCmd(config, newUrl);

    const tokenArg = args.get("token");
    if (tokenArg) return tokenCmd(config, String(tokenArg));

    return deviceCodeFlow(config, { baseUrl: "https://infernetprotocol.com" });
}
