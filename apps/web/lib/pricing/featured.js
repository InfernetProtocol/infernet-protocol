/**
 * The model we sell first: the uncensored 9B on GPU (Anthony, 2026-11-18:
 * "make it sellable"). Its price is a fixed house list price (lib/billing/
 * core.js DEFAULT_INFERENCE_PRICING, settings inference_pricing), set so a
 * typical chat costs about $0.005 and the GPU pays for itself.
 *
 * `typical` is the 7-day mix of 553 real jobs on this model (2026-11-11 to
 * 2026-11-18, the server's token estimates): 1,170 input tokens (median 784,
 * p90 2,372) and 337 output (median 160, p90 666) a chat.
 */
export const FEATURED_MODEL = Object.freeze({
    id: "eriktonon/qwen3.8-uncensored:9b",
    label: "Uncensored Qwen3.8 9B · GPU",
    blurb: "a 9B Qwen3.8 distill with refusals removed, served from GPU nodes with a 32K context; the network's default chat model.",
    input_per_m_usd: 2,
    output_per_m_usd: 8,
    typical: Object.freeze({ input_tokens: 1_170, output_tokens: 337 })
});

/** What a typical chat costs at `price` ({ input, output } per 1M USD). */
export function perChatUsd(price, typical = FEATURED_MODEL.typical) {
    const i = Number(price?.input ?? price?.input_per_m_usd) || 0;
    const o = Number(price?.output ?? price?.output_per_m_usd) || 0;
    return (typical.input_tokens * i + typical.output_tokens * o) / 1e6;
}

/**
 * Chats a day for the GPU to pay for itself: the node keeps (1 - fee) of
 * each chat, and the GPU costs `gpuUsdPerDay`.
 */
export function breakEvenChatsPerDay({ price, gpuUsdPerDay, houseFeePct = 5, typical = FEATURED_MODEL.typical }) {
    const nodeShare = perChatUsd(price, typical) * (1 - houseFeePct / 100);
    return nodeShare > 0 ? Math.ceil(gpuUsdPerDay / nodeShare) : Infinity;
}
