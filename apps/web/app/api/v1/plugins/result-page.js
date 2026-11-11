import "server-only";
import { appUrl } from "@/lib/auth/app-url";

export const STATE_COOKIE = "ifn_plugin_oauth";

function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Small HTML page that ends a plugin sign-in: posts the result to the /chat
 * window that opened it (same origin only) and closes, else links back.
 */
export function pluginResultPage({ ok, slug, name, tools, message, returnTo }, status = 200) {
    const back = typeof returnTo === "string" && returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/chat";
    const title = ok ? `${name ?? slug} connected` : "Plugin sign-in failed";
    const detail = ok
        ? `${esc(name ?? slug)} is ready${Number.isFinite(tools) ? ` with ${tools} tool${tools === 1 ? "" : "s"}` : ""}. You can close this window.`
        : esc(message);
    const payload = JSON.stringify({ type: "infernet-plugin", ok: !!ok, slug: slug ?? null, message: ok ? null : String(message ?? "") })
        .replace(/</g, "\\u003c");
    const origin = JSON.stringify(appUrl().replace(/\/+$/, ""));
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><meta name="robots" content="noindex">
<style>body{font:15px/1.5 system-ui,sans-serif;background:#06131a;color:#e6f1f3;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px}
main{max-width:420px;text-align:center}a{color:#2dd4bf}h1{font-size:20px}</style></head>
<body><main><h1>${esc(title)}</h1><p>${detail}</p><p><a href="${esc(back)}">Back to chat</a></p></main>
<script>(function(){var m=${payload};try{if(window.opener&&!window.opener.closed){window.opener.postMessage(m,${origin});if(m.ok)setTimeout(function(){window.close()},600);}}catch(e){}})();</script>
</body></html>`;
    return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
}
