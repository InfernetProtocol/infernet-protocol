// Job records + artifacts for slow /chat media jobs, kept in a media store
// (media-store.js) so they outlive this process. Every Infernet deploy
// restarts the app, several times an hour on a busy day; without this a
// promo or a song in flight was simply lost.
//
// Layout: <kind>/<id>/job.json (the record), <kind>/<id>/lease.json (which
// process is running it, until when) and the job's artifacts beside them.
//
// The process running a job renews its lease every few seconds. A pending
// job whose lease has lapsed (its process died: a deploy) is claimed by the
// next process that looks (on boot, then every minute) and resumed from its
// last completed stage. During a deploy the old container, the standby and
// the new container may all look at once: the lease decides, and a runner
// that finds its lease taken stops writing.

import os from "node:os";
import { randomUUID } from "node:crypto";

export const MEDIA_JOB_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const LEASE_MS = 60_000;
// A job still pending after this long is not coming back: mark it failed.
export const STUCK_MS = 6 * 60 * 60 * 1000;

export function ttlFromEnv(env = process.env) {
  const days = Number(env.MEDIA_JOB_TTL_DAYS);
  return Number.isFinite(days) && days > 0 ? days * 24 * 60 * 60 * 1000 : MEDIA_JOB_TTL_MS;
}

/** One id per process, unique across containers that share a store. */
export const processOwner = () => (globalThis.__infernetMediaOwner ??= `${os.hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`);

const SYSTEM = new Set(["job.json", "lease.json"]);

/**
 * `store` is a media store or a function returning one (resolved lazily, so
 * importing a route never touches the network). Every method is a no-op
 * (or null / false / []) when there is no store.
 */
export function createDurableJobs({ kind, store, owner = processOwner(), leaseMs = LEASE_MS, ttlMs = MEDIA_JOB_TTL_MS, stuckMs = STUCK_MS, now = Date.now } = {}) {
  const s = () => (typeof store === "function" ? store() : store) ?? null;
  const key = (id, name) => `${kind}/${id}/${name}`;
  const json = (v) => Buffer.from(JSON.stringify(v));
  const readJson = async (k) => {
    const b = await s().get(k);
    if (!b) return null;
    try {
      return JSON.parse(b.toString("utf8"));
    } catch {
      return null;
    }
  };

  const api = {
    kind,
    owner,
    get enabled() {
      return Boolean(s());
    },

    async save(record) {
      if (!s()) return false;
      await s().put(key(record.id, "job.json"), json({ ...record, kind, updatedAt: now() }), { contentType: "application/json" });
      return true;
    },

    async load(id) {
      if (!s()) return null;
      return readJson(key(id, "job.json"));
    },

    async putFile(id, name, bytes, contentType) {
      if (!s()) return false;
      await s().put(key(id, name), bytes, { contentType });
      return true;
    },

    async getFile(id, name) {
      if (!s()) return null;
      return s().get(key(id, name));
    },

    /** The job's artifact names (not the record or the lease). */
    async files(id) {
      if (!s()) return [];
      return (await s().list(`${kind}/${id}`)).filter((n) => !SYSTEM.has(n));
    },

    async ids() {
      if (!s()) return [];
      return s().list(kind);
    },

    /** Take the job unless another live process holds it. */
    async claim(id) {
      if (!s()) return false;
      const k = key(id, "lease.json");
      const cur = await readJson(k);
      if (cur && cur.owner !== owner && cur.until > now()) return false;
      if (cur) await s().remove([k]);
      // An atomic create: of several processes racing here, one wins.
      const won = await s().put(k, json({ owner, until: now() + leaseMs }), { contentType: "application/json", upsert: false });
      if (!won) return false;
      return (await readJson(k))?.owner === owner;
    },

    /** Extend our lease. False when another process has taken the job. */
    async renew(id) {
      if (!s()) return true;
      const k = key(id, "lease.json");
      const cur = await readJson(k);
      if (cur && cur.owner !== owner && cur.until > now()) return false;
      await s().put(k, json({ owner, until: now() + leaseMs }), { contentType: "application/json" });
      return true;
    },

    async release(id) {
      if (!s()) return;
      const k = key(id, "lease.json");
      const cur = await readJson(k).catch(() => null);
      if (cur?.owner === owner) await s().remove([k]);
    },

    async remove(id) {
      if (!s()) return;
      const names = await s().list(`${kind}/${id}`);
      await s().remove(names.map((n) => key(id, n)));
    },

    /** Ids of jobs whose record says pending. */
    async pending() {
      const out = [];
      for (const id of await api.ids()) {
        const rec = await api.load(id).catch(() => null);
        if (rec?.status === "pending") out.push(id);
      }
      return out;
    },

    /**
     * Expire finished jobs older than ttlMs (record + artifacts), fail jobs
     * stuck pending past stuckMs, and drop folders with no record that are
     * older than a lease (a job that died before its first save).
     */
    async sweep() {
      const t = now();
      let removed = 0;
      for (const id of await api.ids()) {
        try {
          const rec = await api.load(id);
          if (!rec) {
            const lease = await readJson(key(id, "lease.json"));
            if (!lease || lease.until < t - leaseMs) {
              await api.remove(id);
              removed++;
            }
            continue;
          }
          if (rec.status !== "pending") {
            if (t - (rec.finishedAt ?? rec.createdAt ?? 0) > ttlMs) {
              await api.remove(id);
              removed++;
            }
          } else if (t - (rec.createdAt ?? 0) > stuckMs) {
            await api.save({ ...rec, status: "failed", error: "This job stopped and could not be resumed; try again", httpStatus: 504, finishedAt: t });
          }
        } catch (e) {
          console.warn(`[${kind}] sweep ${id}: ${e?.message ?? e}`);
        }
      }
      return removed;
    }
  };
  return api;
}

/**
 * Keep a running job's record and lease fresh: `snapshot()` returns the
 * record to save. Saves are serialised; `flush()` saves now and waits.
 * When another process takes the lease, `onLost()` runs and saving stops.
 */
export function keepJobAlive(durable, id, snapshot, { everyMs = 15_000, onLost = null } = {}) {
  let chain = Promise.resolve();
  let lost = false;
  let dirty = false;
  const save = () => {
    if (lost || !durable.enabled) return chain;
    dirty = false;
    chain = chain
      .then(() => durable.save(snapshot()))
      .catch((e) => console.warn(`[${durable.kind}] save ${id}: ${e?.message ?? e}`));
    return chain;
  };
  const timer = setInterval(async () => {
    if (lost) return;
    try {
      if (!(await durable.renew(id))) {
        lost = true;
        clearInterval(timer);
        onLost?.();
        return;
      }
    } catch (e) {
      console.warn(`[${durable.kind}] lease ${id}: ${e?.message ?? e}`);
    }
    if (dirty) save();
  }, everyMs);
  timer.unref?.();
  return {
    get lost() {
      return lost;
    },
    /** Something changed: saved on the next tick (progress lines). */
    touch() {
      dirty = true;
    },
    flush: save,
    async stop({ release = true } = {}) {
      clearInterval(timer);
      await chain;
      if (release && !lost) await durable.release(id).catch(() => {});
    }
  };
}
