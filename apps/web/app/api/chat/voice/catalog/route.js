import { fetchSpeechGateway, errorJson } from "@/lib/chat/speech-service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  let response;
  try {
    response = await fetchSpeechGateway("/v1/voices");
  } catch (error) {
    return errorJson("Voice service is unavailable", 502, error?.message ?? String(error));
  }
  if (!response) return errorJson("Voice mode is not configured", 503);
  if (!response.ok) return errorJson("Voice service is unavailable", response.status);
  return new Response(response.body, {
    status: 200,
    headers: { "content-type": "application/json", "cache-control": "no-store" }
  });
}
