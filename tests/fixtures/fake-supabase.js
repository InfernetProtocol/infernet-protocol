/**
 * A small in-memory stand-in for the Supabase client used by the paid batch
 * tests: tables of rows, the filter / order / limit chain the data modules
 * use, insert / update / upsert, and rpc() dispatched to handlers the test
 * provides (the real ledger functions are SQL, tested in a throwaway
 * Postgres by tooling/test-paid-batch-sql.sh).
 */
import { randomUUID } from "node:crypto";

export function createFakeSupabase({ tables = {}, rpc = {} } = {}) {
    const db = { tables, rpcCalls: [] };

    function from(table) {
        db.tables[table] ??= [];
        const rows = () => db.tables[table];
        const filters = [];
        let op = "select";
        let patch = null;
        let payload = null;
        let opts = {};
        let single = null;
        let limitN = null;
        let head = false;
        let orderBy = null;

        const match = (r) => filters.every((f) => f(r));
        const q = {
            select(_cols, o) { if (o?.head) head = true; if (o?.count) opts.count = true; return q; },
            insert(v) { op = "insert"; payload = v; return q; },
            update(v) { op = "update"; patch = v; return q; },
            upsert(v, o = {}) { op = "upsert"; payload = v; opts = { ...opts, ...o }; return q; },
            delete() { op = "delete"; return q; },
            eq(c, v) { filters.push((r) => r[c] === v); return q; },
            neq(c, v) { filters.push((r) => r[c] !== v); return q; },
            is(c, v) { filters.push((r) => (r[c] ?? null) === v); return q; },
            in(c, vs) { filters.push((r) => vs.includes(r[c])); return q; },
            gt(c, v) { filters.push((r) => r[c] > v); return q; },
            gte(c, v) { filters.push((r) => r[c] >= v); return q; },
            lt(c, v) { filters.push((r) => r[c] < v); return q; },
            not(c, o, v) { filters.push((r) => !(o === "is" && (r[c] ?? null) === v)); return q; },
            order(c, o = {}) { orderBy = [c, o.ascending !== false]; return q; },
            limit(n) { limitN = n; return q; },
            range(a, b) { limitN = b - a + 1; return q; },
            maybeSingle() { single = "maybe"; return q; },
            single() { single = "one"; return q; },
            then(res, rej) { return Promise.resolve(run()).then(res, rej); }
        };

        function run() {
            if (op === "insert" || op === "upsert") {
                const list = (Array.isArray(payload) ? payload : [payload]).map((r) => ({ id: r.id ?? randomUUID(), created_at: new Date().toISOString(), ...r }));
                const out = [];
                for (const r of list) {
                    if (op === "upsert" && opts.onConflict) {
                        const keys = opts.onConflict.split(",");
                        const hit = rows().find((x) => keys.every((k) => x[k] === r[k]));
                        if (hit) { if (!opts.ignoreDuplicates) Object.assign(hit, r); continue; }
                    }
                    rows().push(r);
                    out.push(r);
                }
                return finish(out);
            }
            let list = rows().filter(match);
            if (op === "update") {
                for (const r of list) Object.assign(r, patch);
                return finish(list);
            }
            if (op === "delete") {
                db.tables[table] = rows().filter((r) => !match(r));
                return finish(list);
            }
            if (orderBy) {
                const [c, asc] = orderBy;
                list = [...list].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
            }
            if (limitN !== null) list = list.slice(0, limitN);
            if (head) return { data: null, count: list.length, error: null };
            return finish(list);
        }

        function finish(list) {
            if (single === "maybe") return { data: list[0] ?? null, error: null };
            if (single === "one") return list[0] ? { data: list[0], error: null } : { data: null, error: { message: "no rows" } };
            return { data: list, error: null, count: list.length };
        }
        return q;
    }

    return {
        db,
        from,
        async rpc(name, args) {
            db.rpcCalls.push({ name, args });
            const fn = rpc[name];
            if (!fn) return { data: null, error: { message: `no rpc ${name}` } };
            try {
                return { data: await fn(args, db), error: null };
            } catch (e) {
                return { data: null, error: { message: e.message } };
            }
        }
    };
}
