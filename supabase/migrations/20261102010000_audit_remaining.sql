-- Engineering audit, remaining items (2026-11-02). Additive and idempotent:
-- applied by hand BEFORE the code that uses it deploys, and the code already
-- running keeps working with it applied.
--
-- 1. provider_earnings: whether the token count was estimated (text/4), and
--    why a credit is held for review (subsidy outliers).
-- 2. provider_earnings kind 'reservation': the operator's share of a prepaid
--    node reservation order. No job, so job_id becomes nullable and the row
--    carries reservation_id instead; one per (reservation, provider). Jobs
--    served for a reservation are tagged so they earn no subsidy on top.
-- 3. providers.disabled_at: a durable admin kill switch that heartbeats and
--    re-registers honour (status stays 'disabled').
-- 5. Atomic included-token cap: reserve before the call, settle after.
-- 6. reservation_orders.payment_tx_hash for receipts.

-- 1 + 2: provider_earnings ------------------------------------------------

alter table public.provider_earnings
    add column if not exists tokens_estimated boolean not null default false,
    add column if not exists held_reason text,
    add column if not exists reservation_id uuid references public.reservations(id) on delete restrict;

alter table public.provider_earnings alter column job_id drop not null;

alter table public.provider_earnings drop constraint if exists provider_earnings_kind_check;
alter table public.provider_earnings
    add constraint provider_earnings_kind_check check (kind in ('paid', 'subsidy', 'reservation'));

-- A job credit has a job; a reservation credit has a reservation.
alter table public.provider_earnings drop constraint if exists provider_earnings_target_shape;
alter table public.provider_earnings
    add constraint provider_earnings_target_shape check (
        (kind = 'reservation' and reservation_id is not null)
        or (kind <> 'reservation' and job_id is not null)
    );

create unique index if not exists provider_earnings_reservation_provider_key
    on public.provider_earnings (reservation_id, provider_id) where kind = 'reservation';

create index if not exists provider_earnings_review_idx
    on public.provider_earnings (earned_at)
    where status = 'pending_approval' and (kind = 'reservation' or held_reason is not null);

alter table public.jobs
    add column if not exists reservation_id uuid references public.reservations(id) on delete set null;

create index if not exists jobs_reservation_id_idx
    on public.jobs (reservation_id) where reservation_id is not null;

-- 3: provider kill switch -------------------------------------------------

alter table public.providers
    add column if not exists disabled_at timestamptz,
    add column if not exists disabled_reason text,
    add column if not exists disabled_by text;

create index if not exists providers_disabled_idx
    on public.providers (disabled_at) where disabled_at is not null;

-- 5: atomic included-token cap --------------------------------------------

-- Reserve p_tokens against the allowance in one statement. Returns the new
-- tokens_used, or null (no row) when it would go over included_tokens.
-- included_tokens = 0 means no cap.
create or replace function public.reservation_reserve_tokens(p_reservation_id uuid, p_tokens bigint)
returns bigint
language sql
as $$
    update public.reservations
       set tokens_used = tokens_used + greatest(p_tokens, 0),
           updated_at = now()
     where id = p_reservation_id
       and (included_tokens = 0 or tokens_used + greatest(p_tokens, 0) <= included_tokens)
    returning tokens_used;
$$;

-- Replace a reservation with what the call really used (may be more or less).
create or replace function public.reservation_settle_tokens(p_reservation_id uuid, p_reserved bigint, p_actual bigint)
returns bigint
language sql
as $$
    update public.reservations
       set tokens_used = greatest(tokens_used - greatest(p_reserved, 0) + greatest(p_actual, 0), 0),
           updated_at = now()
     where id = p_reservation_id
    returning tokens_used;
$$;

revoke all on function public.reservation_reserve_tokens(uuid, bigint) from public, anon, authenticated;
grant execute on function public.reservation_reserve_tokens(uuid, bigint) to service_role;
revoke all on function public.reservation_settle_tokens(uuid, bigint, bigint) from public, anon, authenticated;
grant execute on function public.reservation_settle_tokens(uuid, bigint, bigint) to service_role;

-- 6: receipts -------------------------------------------------------------

alter table public.reservation_orders
    add column if not exists payment_tx_hash text;

notify pgrst, 'reload schema';
