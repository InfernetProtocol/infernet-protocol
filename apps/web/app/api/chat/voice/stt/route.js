import { rateLimit, getClientIp } from "@/lib/rate-limit";
import { fetchSpeechGateway, readLimitedBody, speechGateway, errorJson } from "@/lib/chat/speech-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const limit = rateLimit({ windowMs: 60 * 60 * 1000, max: 20 });
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

export async function POST(request) {
  const rate = limit.check(getClientIp(request));
  if (!rate.ok) return errorJson("Speech recognition rate limit exceeded — try again later", 429);
  if (!speechGateway()) return errorJson("Voice mode is not configured", 503);

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (declaredLength > MAX_AUDIO_BYTES) return errorJson("Audio must be 25 MiB or smaller", 413);
  const mime = request.headers.get("content-type") ?? "";
  if (!mime.toLowerCase().startsWith("audio/") && !mime.toLowerCase().startsWith("video/webm")) {
    return errorJson("Send a supported audio recording", 415);
  }
  const audio = await readLimitedBody(request, MAX_AUDIO_BYTES);
  if (!audio) return errorJson("Audio must be 25 MiB or smaller", 413);
  if (audio.byteLength === 0) {
    return errorJson("Audio must contain at least one byte", 400);
  }

  let response;
  try {
    response = await fetchSpeechGateway("/v1/stt?model=base", {
      method: "POST",
      headers: { "content-type": mime },
      body: audio
    });
  } catch (error) {
    return errorJson("Speech recognition failed", 502, error?.message ?? String(error));
  }
  if (!response) return errorJson("Voice mode is not configured", 503);
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return errorJson("Speech recognition failed", response.status, detail.slice(0, 500));
  }
  return new Response(response.body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
