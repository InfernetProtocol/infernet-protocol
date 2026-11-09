// Durable storage for slow /chat media jobs (promo videos, songs): the job
// record and every artifact it has made so far, so a deploy that restarts
// this process mid-job loses nothing (see durable-jobs.js).
//
// Two backends with one small interface (keys are "<kind>/<id>/<file>"):
//   - a directory (MEDIA_STORE_DIR, e.g. a mounted volume; tests use a tmp dir)
//   - Supabase Storage, the site's own stack (private bucket MEDIA_STORE_BUCKET,
//     default "media-jobs", created on first use). This is the default in
//     production, where the container's own disk is wiped on every deploy.
// MEDIA_STORE=off turns persistence off (jobs live in memory, as before).
//
//   put(key, bytes, { contentType, upsert = true }) -> true, or false when
//       upsert is false and the key already exists (an atomic create)
//   get(key) -> Buffer | null (null only when the key does not exist)
//   list(prefix) -> names directly under prefix (files and "folders")
//   remove(keys)

import { mkdir, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";

const SAFE_KEY = /^[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;

function checkKey(key) {
  const k = String(key ?? "");
  if (!SAFE_KEY.test(k) || k.split("/").some((p) => p === "." || p === "..")) throw new Error(`unsafe media store key: ${k}`);
  return k;
}

export function createFsStore(root) {
  const file = (key) => path.join(root, checkKey(key));
  return {
    kind: "fs",
    async put(key, bytes, { upsert = true } = {}) {
      const f = file(key);
      await mkdir(path.dirname(f), { recursive: true });
      if (!upsert) {
        try {
          await writeFile(f, bytes, { flag: "wx" });
          return true;
        } catch (e) {
          if (e?.code === "EEXIST") return false;
          throw e;
        }
      }
      // Write then rename, so a reader never sees half a file.
      const tmp = `${f}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, f);
      return true;
    },
    async get(key) {
      try {
        return await readFile(file(key));
      } catch (e) {
        if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return null;
        throw e;
      }
    },
    async list(prefix) {
      try {
        return (await readdir(file(prefix))).filter((n) => !n.endsWith(".tmp"));
      } catch (e) {
        if (e?.code === "ENOENT" || e?.code === "ENOTDIR") return [];
        throw e;
      }
    },
    async remove(keys) {
      for (const k of keys) {
        await rm(file(k), { force: true, recursive: true });
        // Like a bucket: a folder with nothing left in it is gone.
        await rmdir(path.dirname(file(k))).catch(() => {});
      }
    }
  };
}

const notFound = (error) => {
  const code = String(error?.statusCode ?? error?.status ?? "");
  return code === "404" || /not.?found/i.test(String(error?.message ?? ""));
};
const exists = (error) => {
  const code = String(error?.statusCode ?? error?.status ?? "");
  return code === "409" || /exist|duplicate/i.test(String(error?.message ?? ""));
};

/** `client` is a supabase-js client (service role); exported for tests. */
export function createSupabaseStore(client, bucket = "media-jobs") {
  let ready = null;
  const ensure = () => {
    ready ??= client.storage
      .createBucket(bucket, { public: false })
      .then(({ error }) => {
        if (error && !exists(error)) throw error;
      })
      .catch((e) => {
        ready = null;
        throw e;
      });
    return ready;
  };
  const b = () => client.storage.from(bucket);
  return {
    kind: "supabase",
    async put(key, bytes, { contentType = "application/octet-stream", upsert = true } = {}) {
      await ensure();
      const { error } = await b().upload(checkKey(key), bytes, { contentType, upsert });
      if (!error) return true;
      if (!upsert && exists(error)) return false;
      throw error;
    },
    async get(key) {
      await ensure();
      const { data, error } = await b().download(checkKey(key));
      if (error) {
        if (notFound(error)) return null;
        throw error;
      }
      return Buffer.from(await data.arrayBuffer());
    },
    async list(prefix) {
      await ensure();
      const out = [];
      for (let offset = 0; ; offset += 1000) {
        const { data, error } = await b().list(checkKey(prefix), { limit: 1000, offset });
        if (error) throw error;
        for (const e of data ?? []) if (e?.name && e.name !== ".emptyFolderPlaceholder") out.push(e.name);
        if (!data || data.length < 1000) break;
      }
      return out;
    },
    async remove(keys) {
      if (!keys.length) return;
      await ensure();
      const { error } = await b().remove(keys.map(checkKey));
      if (error && !notFound(error)) throw error;
    }
  };
}

/** The process-wide store, or null when persistence is off or unconfigured. */
export function mediaStore(env = process.env) {
  const g = globalThis;
  if (g.__infernetMediaStore !== undefined) return g.__infernetMediaStore;
  let store = null;
  // Unit tests never reach a real bucket by accident; they pass their own store.
  if (env.MEDIA_STORE === "off" || (env.VITEST && !env.MEDIA_STORE_DIR)) store = null;
  else if (env.MEDIA_STORE_DIR) store = createFsStore(env.MEDIA_STORE_DIR);
  else if (env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY) {
    const client = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } });
    store = createSupabaseStore(client, env.MEDIA_STORE_BUCKET || "media-jobs");
  }
  g.__infernetMediaStore = store;
  return store;
}
