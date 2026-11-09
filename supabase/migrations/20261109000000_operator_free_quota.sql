-- Node operators get a bigger free allowance.
--
-- Someone who runs a node that actually serves the network gets more free
-- queries a day (operator_free_queries_per_day, default 100) and a few free
-- songs (operator_free_songs_per_day, default 5) than a stranger does. The
-- limits live in the interactive_billing settings row and are applied in the
-- app (lib/data/free-tier.js); this function only answers "does this user
-- qualify right now?".
--
-- A user qualifies when they own, through pubkey_links (role 'provider'), a
-- provider that:
--   * is not disabled (providers.disabled_at is null),
--   * was linked at least p_min_link_days ago (default 3), so a node spun up
--     this morning to farm the allowance does not count yet,
--   * was found reachable in at least half of its provider_probes over the
--     last 24 hours. Probes sent by an aggregator the SAME user owns are
--     ignored: anyone can register an aggregator, and an operator vouching
--     for their own node proves nothing. No probes at all means no.
--   * optionally (p_min_jobs_7d, default 0 = off) completed at least that many
--     network-routed jobs in the last 7 days that were NOT billed to the same
--     user, so sending yourself work does not count.
--
-- SECURITY DEFINER with a pinned search_path like the other definer
-- functions here; executable by service_role only.

create or replace function public.operator_qualifies(
    p_user_id        uuid,
    p_min_link_days  integer default 3,
    p_min_jobs_7d    integer default 0,
    p_min_reachable  numeric default 0.5)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
    with mine as (
        select p.id
          from public.providers p
          join public.pubkey_links l
            on l.pubkey = p.public_key and l.role = 'provider'
         where l.user_id = p_user_id
           and p.disabled_at is null
           and l.created_at <= now() - make_interval(days => greatest(coalesce(p_min_link_days, 3), 0))
    ),
    own_aggs as (
        select a.id
          from public.aggregators a
          join public.pubkey_links l
            on l.pubkey = a.public_key and l.role = 'aggregator'
         where l.user_id = p_user_id
    ),
    reachable as (
        select pr.provider_id
          from public.provider_probes pr
         where pr.provider_id in (select id from mine)
           and pr.probed_at >= now() - interval '24 hours'
           and pr.aggregator_id not in (select id from own_aggs)
         group by pr.provider_id
        having count(*) > 0
           and (count(*) filter (where pr.reachable))::numeric / count(*)
               >= coalesce(p_min_reachable, 0.5)
    )
    select p_user_id is not null
       and exists (select 1 from reachable)
       and (
            coalesce(p_min_jobs_7d, 0) <= 0
         or (select count(*)
               from public.jobs j
              where j.provider_id in (select provider_id from reachable)
                and j.status = 'completed'
                and coalesce(j.completed_at, j.created_at) >= now() - interval '7 days'
                and (j.billed_user_id is null or j.billed_user_id <> p_user_id::text)
            ) >= p_min_jobs_7d
       );
$$;

revoke all on function public.operator_qualifies(uuid, integer, integer, numeric) from public, anon, authenticated;
grant execute on function public.operator_qualifies(uuid, integer, integer, numeric) to service_role;

notify pgrst, 'reload schema';
