import { NextResponse } from "next/server";
import { rateLimit, getClientIp } from "@/lib/rate-limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
const MAX_SOURCE_BYTES = 256 * 1024;

function apiBase() {
  return (process.env.READM3_API_URL ?? "https://readm3.com/api/v1").replace(/\/$/, "");
}

async function readm3Post(path, body, token) {
  const response = await fetch(`${apiBase()}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000)
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error ?? `Readm3 returned ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return result;
}

export async function POST(request) {
  const checked = limit.check(getClientIp(request));
  if (!checked.ok) {
    return NextResponse.json({ error: "Too many Readm3 publishes — try again later" }, { status: 429 });
  }

  let payload;
  try {
    payload = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const source = typeof payload?.source === "string" ? payload.source : "";
  if (!source.trim()) return NextResponse.json({ error: "source is required" }, { status: 400 });
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) {
    return NextResponse.json({ error: "Markdown is too large for a Readm3 paste" }, { status: 413 });
  }

  const title = typeof payload?.title === "string" && payload.title.trim()
    ? payload.title.trim().slice(0, 120)
    : "infernet-answer.md";
  const token = process.env.READM3_TOKEN?.trim();

  try {
    // With credentials configured, create a real document and share it. In the
    // public playground the normal path is the anonymous expiring paste API.
    if (token) {
      const document = await readm3Post("/documents", { title, source, access: "private" }, token);
      const shared = await readm3Post(
        `/documents/${encodeURIComponent(document.id)}/shares`,
        { role: "view", label: "infernetprotocol.com" },
        token
      );
      if (typeof shared.url === "string") return NextResponse.json({ url: shared.url, mode: "document" });
    }

    const paste = await readm3Post("/pastes", { source, title, expiresIn: "30d" });
    if (typeof paste.url !== "string") throw new Error("Readm3 returned no paste URL");
    return NextResponse.json({ url: paste.url, mode: "paste" });
  } catch (error) {
    return NextResponse.json({ error: error?.message ?? "Readm3 publish failed" }, { status: 502 });
  }
}
