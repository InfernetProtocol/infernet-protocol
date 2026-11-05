-- Durable store for @profullstack/browser-fingerprint.
--
-- The guard needs a Store with two operations: incr (a fixed-window counter)
-- and claim (first-writer-wins on a key, which is how one challenge token is
-- stopped from minting many visitor identities).
--
-- The package ships memory, SQLite and Redis stores. Memory is the wrong one
-- here for the same reason the free-query counter is not in memory: it resets
-- on every deploy, and this app deploys several times a day, so a replayed
-- challenge token would become usable again after each one. There is no Redis
-- in this stack, so the store is Postgres.
--
-- Nothing in here is a fingerprint. The guard hands us keyed hashes only; this
-- table holds those opaque keys, a count and an expiry.

create table if not exists public.fingerprint_store (
    key        text primary key,
    -- Set by claim(); null for pure counters.
    value      text,
    count      integer not null default 0,
    expires_at timestamptz not null
);

create index if not exists fingerprint_store_expires_idx on public.fingerprint_store (expires_at);

alter table public.fingerprint_store enable row level security;
revoke all on table public.fingerprint_store from anon, authenticated;
grant select, insert, update, delete on table public.fingerprint_store to service_role;

/**
 * Fixed-window increment. An entry past its expiry is treated as absent and
 * restarted, which is what makes the window fixed rather than sliding.
 */
create or replace function public.fingerprint_incr(p_key text, p_ttl_ms bigint)
returns integer
language plpgsql
as $$
declare n integer;
begin
    insert into public.fingerprint_store (key, count, expires_at)
         values (p_key, 1, now() + make_interval(secs => greatest(p_ttl_ms, 1) / 1000.0))
    on conflict (key) do update
            set count = case when public.fingerprint_store.expires_at <= now() then 1
                             else public.fingerprint_store.count + 1 end,
                expires_at = case when public.fingerprint_store.expires_at <= now()
                                  then now() + make_interval(secs => greatest(p_ttl_ms, 1) / 1000.0)
                                  else public.fingerprint_store.expires_at end
      returning public.fingerprint_store.count into n;
    return n;
end $$;

/**
 * First writer wins: returns the value already held for the key, or null when
 * this caller is the one that just set it. That null is the signal the guard
 * reads as "this token had not been used before".
 */
create or replace function public.fingerprint_claim(p_key text, p_value text, p_ttl_ms bigint)
returns text
language plpgsql
as $$
declare held text;
begin
    -- Clear an expired holder first, so a key frees up when its window passes.
    delete from public.fingerprint_store where key = p_key and expires_at <= now();

    insert into public.fingerprint_store (key, value, count, expires_at)
         values (p_key, p_value, 1, now() + make_interval(secs => greatest(p_ttl_ms, 1) / 1000.0))
    on conflict (key) do nothing;

    if found then
        return null;
    end if;

    select public.fingerprint_store.value into held
      from public.fingerprint_store where key = p_key;
    return held;
end $$;

create or replace function public.fingerprint_store_prune()
returns integer
language plpgsql
as $$
declare n integer;
begin
    delete from public.fingerprint_store where expires_at <= now() - interval '1 day';
    get diagnostics n = row_count;
    return n;
end $$;

revoke all on function public.fingerprint_incr(text, bigint) from public, anon, authenticated;
revoke all on function public.fingerprint_claim(text, text, bigint) from public, anon, authenticated;
revoke all on function public.fingerprint_store_prune() from public, anon, authenticated;
grant execute on function public.fingerprint_incr(text, bigint) to service_role;
grant execute on function public.fingerprint_claim(text, text, bigint) to service_role;
grant execute on function public.fingerprint_store_prune() to service_role;
