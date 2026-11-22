import { describe, it, expect, beforeEach, vi } from "vitest";
import {
    normalizeEntry,
    normalizeGallery,
    fallbackGallery,
    loadGallery,
    _resetGalleryCache,
    GALLERY_TTL_MS
} from "@/lib/gallery";
import { NAV_GROUPS, ACCOUNT_GROUP, FEATURED } from "@/lib/nav";

const board = {
    slug: "board-as-a-service",
    name: "Board as a Service",
    tagline: "Five AI advisors",
    url: "https://board.saas.pit.world",
    c0mpute_url: "https://gateway.c0mpute.com/s/d28960255346f386e99c/",
    category: "Apps",
    built_with: ["Infernet chat", "c0mpute hosting", "CoinPay"],
    image: null,
    added_at: "2026-11-22T00:00:00Z"
};

function jsonResponse(body, status = 200) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
}

describe("gallery normalize", () => {
    it("keeps a valid entry", () => {
        expect(normalizeEntry(board)).toMatchObject({ slug: "board-as-a-service", category: "Apps", image: null });
    });

    it("drops entries without a name or with a non-http link", () => {
        expect(normalizeEntry({ name: "x", url: "javascript:alert(1)" })).toBeNull();
        expect(normalizeEntry({ url: "https://a.example" })).toBeNull();
    });

    it("strips unsafe image and c0mpute links", () => {
        const e = normalizeEntry({ ...board, image: "data:text/html,x", c0mpute_url: "ftp://x" });
        expect(e.image).toBeNull();
        expect(e.c0mpute_url).toBeNull();
    });

    it("accepts a bare array or an envelope, dedupes slugs, newest first", () => {
        const older = { ...board, slug: "old", name: "Old", added_at: "2026-01-01T00:00:00Z" };
        expect(normalizeGallery([older, board, board]).map((e) => e.slug)).toEqual(["board-as-a-service", "old"]);
        expect(normalizeGallery({ entries: [board] })).toHaveLength(1);
        expect(normalizeGallery({ data: [board] })).toHaveLength(1);
        expect(normalizeGallery({ nope: 1 })).toBeNull();
    });

    it("bundled fallback has the verified Board as a Service entry", () => {
        const [first] = fallbackGallery();
        expect(first.url).toBe("https://board.saas.pit.world/");
        expect(first.c0mpute_url).toBe("https://gateway.c0mpute.com/s/d28960255346f386e99c/");
    });
});

describe("loadGallery", () => {
    beforeEach(() => {
        _resetGalleryCache();
        vi.useRealTimers();
    });

    it("uses the live list when c0mpute answers", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({ entries: [{ ...board, name: "Live" }] }));
        const got = await loadGallery({ fetchImpl });
        expect(got.source).toBe("c0mpute");
        expect(got.entries[0].name).toBe("Live");
    });

    it("falls back to the bundled copy when c0mpute fails", async () => {
        const fetchImpl = vi.fn(async () => jsonResponse({}, 404));
        const got = await loadGallery({ fetchImpl });
        expect(got.source).toBe("fallback");
        expect(got.entries[0].slug).toBe("board-as-a-service");
    });

    it("falls back when the live list is empty", async () => {
        const got = await loadGallery({ fetchImpl: async () => jsonResponse([]) });
        expect(got.source).toBe("fallback");
    });

    it("caches for the TTL and keeps the last good copy on a later failure", async () => {
        vi.useFakeTimers();
        let calls = 0;
        const fetchImpl = async () => {
            calls += 1;
            if (calls === 1) return jsonResponse([board]);
            throw new Error("down");
        };
        await loadGallery({ fetchImpl });
        await loadGallery({ fetchImpl });
        expect(calls).toBe(1);
        vi.advanceTimersByTime(GALLERY_TTL_MS + 1);
        const stale = await loadGallery({ fetchImpl }); // answers stale, refreshes behind
        expect(stale.source).toBe("c0mpute");
        await vi.runAllTimersAsync();
        const after = await loadGallery({ fetchImpl });
        expect(calls).toBe(2);
        expect(after.entries[0].slug).toBe("board-as-a-service");
    });
});

describe("nav IA", () => {
    const hrefs = new Set([FEATURED.href, ...[...NAV_GROUPS, ACCOUNT_GROUP].flatMap((g) => g.items.map((i) => i.href.split("#")[0]))]);

    it("still links every page the old flat navbar linked", () => {
        for (const old of ["/getting-started", "/pricing", "/protocol", "/docs", "/book", "/chat", "/deploy", "/order", "/status", "/dashboard", "/invites", "/settings"]) {
            expect(hrefs.has(old), old).toBe(true);
        }
    });

    it("features the gallery and lists it under Use", () => {
        expect(FEATURED.href).toBe("/gallery");
        expect(NAV_GROUPS.find((g) => g.id === "use").items.some((i) => i.href === "/gallery")).toBe(true);
    });
});
