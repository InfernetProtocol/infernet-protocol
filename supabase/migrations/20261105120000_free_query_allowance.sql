-- A daily allowance for free queries.
--
-- The free tier was 20 requests an hour per IP, held in a Map inside one
-- Next.js process (lib/rate-limit.js). That is fine for an hourly cap and
-- useless for a DAILY one: the count resets on every deploy, and this app
-- deployed six times in one afternoon, so "10 a day" in memory would really
-- be "10 per deploy". It is also per process, so it does not hold once there
-- is more than one.
--
-- So the daily allowance lives here instead, and is spent atomically.
--
-- Privacy: the subject is `user:<id>` when we know who is asking, and
-- otherwise `ip:<sha256(key + ip)>`. The raw IP is never stored. The rest of
-- this codebase goes out of its way not to keep IPs (lib/geo.js keeps the
-- resolved location and never the address), and a free-tier counter is not a
-- good reason to start.

create table if not exists public.free_queries (
    -- 'user:<uuid>' or 'ip:<64 hex>'. Opaque on purpose.
    subject    text not null,
    day        date not null,
    used       integer not null default 0 check (used >= 0),
    first_at   timestamptz not null default now(),
    last_at    timestamptz not null default now(),
    primary key (subject, day)
);

create index if not exists free_queries_day_idx on public.free_queries (day);

alter table public.free_queries enable row level security;
revoke all on table public.free_queries from anon, authenticated;
grant select, insert, update, delete on table public.free_queries to service_role;

/**
 * Spend one free query for a subject, or report that the allowance is gone.
 *
 * Atomic on purpose: two requests arriving together must not both read "9 used"
 * and both be allowed. The insert-on-conflict does the increment in one
 * statement, and the decision is made from the value it returns.
 *
 * p_max 0 means no free queries at all; a negative p_max means unlimited,
 * which is how the caller expresses "no cap configured" without a second code
 * path.
 */
create or replace function public.free_query_consume(
    p_subject text, p_max integer, p_day date default null)
returns jsonb
language plpgsql
as $$
declare
    d      date := coalesce(p_day, (now() at time zone 'utc')::date);
    used   integer;
begin
    if p_subject is null or length(p_subject) = 0 then
        return jsonb_build_object('allowed', false, 'reason', 'no_subject');
    end if;
    if p_max < 0 then
        return jsonb_build_object('allowed', true, 'unlimited', true);
    end if;
    if p_max = 0 then
        return jsonb_build_object('allowed', false, 'used', 0, 'remaining', 0, 'limit', 0);
    end if;

    insert into public.free_queries (subject, day, used)
         values (p_subject, d, 1)
    on conflict (subject, day) do update
            set used = public.free_queries.used + 1,
                last_at = now()
      returning public.free_queries.used into used;

    -- Over the line: give the attempt back, so a refused request does not eat
    -- tomorrow's allowance when the clock rolls over mid-burst.
    if used > p_max then
        update public.free_queries set used = p_max where subject = p_subject and day = d;
        return jsonb_build_object('allowed', false, 'used', p_max, 'remaining', 0, 'limit', p_max);
    end if;

    return jsonb_build_object('allowed', true, 'used', used, 'remaining', p_max - used, 'limit', p_max);
end $$;

revoke all on function public.free_query_consume(text, integer, date) from public, anon, authenticated;
grant execute on function public.free_query_consume(text, integer, date) to service_role;

-- Keep the table small: an allowance older than a week decides nothing.
create or replace function public.free_queries_prune(p_keep_days integer default 7)
returns integer
language plpgsql
as $$
declare n integer;
begin
    delete from public.free_queries
     where day < ((now() at time zone 'utc')::date - greatest(p_keep_days, 1));
    get diagnostics n = row_count;
    return n;
end $$;

revoke all on function public.free_queries_prune(integer) from public, anon, authenticated;
grant execute on function public.free_queries_prune(integer) to service_role;
