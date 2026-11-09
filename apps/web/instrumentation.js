// Runs once when the server starts (Next.js instrumentation hook).
//
// Promo videos and songs are kept in the media store (lib/chat/media-store.js)
// as they are made, so a deploy that restarts this app mid-job can carry on
// with it. Here we ask our own /api/chat/media/resume route to do that on
// boot and every minute after (a lease another container held lapses within
// a minute of it going away). A request to ourselves rather than an import:
// the resume code is server-only route code.

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const env = (name) => process.env[name];
  if (env("MEDIA_RESUME") === "0" || env("MEDIA_STORE") === "off") return;
  const port = env("PORT") || "3000";
  const url = `http://127.0.0.1:${port}/api/chat/media/resume`;
  let busy = false;
  const ask = async () => {
    if (busy) return;
    busy = true;
    try {
      const res = await fetch(url, { method: "POST", signal: AbortSignal.timeout(120_000) });
      const body = await res.json().catch(() => null);
      const n = (body?.resumed?.promos ?? 0) + (body?.resumed?.songs ?? 0);
      if (n) console.log(`[media] resumed ${body.resumed.promos} promo(s) and ${body.resumed.songs} song(s)`);
    } catch {
      // Not listening yet, or busy: the next tick tries again.
    } finally {
      busy = false;
    }
  };
  setTimeout(ask, 15_000).unref?.();
  setInterval(ask, 60_000).unref?.();
}
