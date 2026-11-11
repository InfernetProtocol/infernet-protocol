import { describe, expect, it } from "vitest";
import {
  c0mputeCard,
  fetchC0mputeSummary,
  providerNote,
  summarizeC0mputeNodes,
  summarizeProviders
} from "@/lib/data/network-nodes";

const NOW = Date.parse("2026-11-11T07:00:00Z");
const ago = (ms) => new Date(NOW - ms).toISOString();
const MIN = 60 * 1000;
const DAY = 24 * 60 * MIN;

describe("summarizeProviders", () => {
  it("splits online, this week, dormant and archived", () => {
    const rows = [
      { status: "available", last_seen: ago(1 * MIN) },
      { status: "available", last_seen: ago(9 * MIN) },
      { status: "available", last_seen: ago(11 * MIN) }, // stale heartbeat: week
      { status: "offline", last_seen: ago(2 * DAY) },
      { status: "offline", last_seen: ago(40 * DAY) },
      { status: "archived", last_seen: ago(100 * DAY) },
      { status: "offline", last_seen: null }
    ];
    expect(summarizeProviders(rows, NOW)).toEqual({
      online: 2,
      week: 2,
      archived: 1,
      dormant: 2,
      registered: 7
    });
  });

  it("does not count an offline row as online even with a fresh heartbeat", () => {
    expect(summarizeProviders([{ status: "offline", last_seen: ago(MIN) }], NOW).online).toBe(0);
  });
});

describe("providerNote", () => {
  it("names the week and dormant buckets", () => {
    expect(providerNote({ week: 7, dormant: 37 })).toBe("LLM chat · 7 more seen this week · 37 dormant");
    expect(providerNote({ week: 0, dormant: 0 })).toBe("LLM chat");
  });
});

describe("c0mpute nodes", () => {
  it("counts workers and GPUs", () => {
    const s = summarizeC0mputeNodes({
      workers_online: 3,
      nodes: [{ class: "cpu" }, { class: "gpu:nvidia" }, { class: "gpu:amd" }]
    });
    expect(s).toEqual({ online: 3, gpu: 2 });
    expect(c0mputeCard(s)).toEqual({
      label: "c0mpute workers",
      value: 3,
      note: "run speech, music, image + video jobs · 2 GPU"
    });
  });

  it("rejects a non-node body and renders an unreachable card", () => {
    expect(summarizeC0mputeNodes("<!doctype html>")).toBeNull();
    expect(summarizeC0mputeNodes({ ok: true })).toBeNull();
    expect(c0mputeCard(null).value).toBe("—");
  });

  it("returns null when the fetch fails or the body is HTML", async () => {
    const boom = async () => { throw new Error("ECONNREFUSED"); };
    expect(await fetchC0mputeSummary({ fetchImpl: boom })).toBeNull();
    const html = async () => ({ ok: true, json: async () => { throw new SyntaxError("Unexpected token <"); } });
    expect(await fetchC0mputeSummary({ fetchImpl: html })).toBeNull();
    const good = async () => ({ ok: true, json: async () => ({ workers_online: 17, nodes: [{ class: "cpu" }] }) });
    expect(await fetchC0mputeSummary({ fetchImpl: good })).toEqual({ online: 17, gpu: 0 });
  });
});
