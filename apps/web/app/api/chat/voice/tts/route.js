import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { fetchSpeechGateway, readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 40 });

export async function POST(request) {
  const rate = limit.check(getClientIp(request));
  if (!rate.ok) return errorJson("Voice rate limit exceeded — try again later", 429);
  if (!speechGateway()) return errorJson("Voice mode is not configured", 503);
  if (Number(request.headers.get("content-length") ?? 0) > 24 * 1024) {
    return errorJson("Voice request is too large", 413);
  }

  let body;
  try {
    const bytes = await readLimitedBody(request, 24 * 1024);
    if (!bytes) return errorJson("Voice request is too large", 413);
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return errorJson("Invalid JSON body", 400);
  }
  if (!body || typeof body.text !== "string" || body.text.length > 6000) {
    return errorJson("Text must contain 1 to 6000 characters", 400);
  }

  let response;
  try {
    response = await fetchSpeechGateway("/v1/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  } catch (error) {
    return errorJson("Speech synthesis failed", 502, error?.message ?? String(error));
  }
  if (!response) return errorJson("Voice mode is not configured", 503);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return errorJson("Speech synthesis failed", response.status, detail.slice(0, 500));
  }
  return new Response(response.body, {
    status: 200,
    headers: {
      "content-type": response.headers.get("content-type") ?? "audio/wav",
      "cache-control": "no-store",
      ...(response.headers.get("x-c0mpute-job-id") ? { "x-c0mpute-job-id": response.headers.get("x-c0mpute-job-id") } : {}),
      ...(response.headers.get("x-c0mpute-worker-peer-id") ? { "x-c0mpute-worker-peer-id": response.headers.get("x-c0mpute-worker-peer-id") } : {})
    }
  });
}
