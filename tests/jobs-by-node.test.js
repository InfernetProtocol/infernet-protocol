import { describe, expect, it } from "vitest";
import { foldJobsByNode, routeOf } from "../apps/web/lib/jobs-by-node.js";

const providers = [
    { id: "d1", name: "provider@bonita", node_id: "abc" },
    { id: "c1", name: "c0mpute KBdpB123", node_id: "c0mpute:12D3KooWxyzKBdpB123" }
];
const t = (s) => new Date(Date.UTC(2026, 10, 14, 9, 0, s)).toISOString();

describe("routeOf", () => {
    it("names c0mpute workers, daemons, the hosted fallback and unserved jobs", () => {
        expect(routeOf({}, providers[1])).toBe("c0mpute node");
        expect(routeOf({}, providers[0])).toBe("daemon");
        expect(routeOf({ assigned_at: t(0), status: "completed" }, null)).toBe("hosted");
        expect(routeOf({ status: "failed" }, null)).toBe("unserved");
    });
});

describe("foldJobsByNode", () => {
    it("counts free and billed jobs per node with run time, top model and earnings", () => {
        const jobs = [
            { provider_id: "c1", status: "completed", billed_user_id: "u", assigned_at: t(0), completed_at: t(20), model_name: "qwen2.5:7b" },
            { provider_id: "c1", status: "completed", billed_user_id: null, assigned_at: t(0), completed_at: t(40), model_name: "qwen2.5:7b" },
            { provider_id: "d1", status: "failed", billed_user_id: "u", assigned_at: t(0), model_name: "qwen2.5:0.5b" },
            { provider_id: null, status: "failed", billed_user_id: null, model_name: "llama3.1:70b" }
        ];
        const earnings = [{ provider_id: "c1", amount_usd: 0.0006 }, { provider_id: "c1", amount_usd: 0.0004 }];
        const rows = foldJobsByNode({ jobs, providers, earnings });
        expect(rows[0]).toMatchObject({
            node: "c0mpute KBdpB123", route: "c0mpute node", jobs: 2, completed: 2,
            billed_free: "1 / 1", avg_time: "30s", top_model: "qwen2.5:7b", earned: "$0.0010"
        });
        expect(rows.find((r) => r.node === "provider@bonita")).toMatchObject({ route: "daemon", jobs: 1, completed: 0, avg_time: "-", earned: "$0" });
        expect(rows.find((r) => r.route === "unserved")).toMatchObject({ node: "no node took it", jobs: 1, billed_free: "0 / 1" });
        expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
    });
});
