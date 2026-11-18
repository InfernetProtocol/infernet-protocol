-- The house fee as a ledger credit to the platform account.
--
-- Anthony, 2026-11-18: "where do the fees go? those be kept in our platform
-- (admin) wallet right? so our balance should always be equal, no deficit".
--
-- Before: a charged job debited the payer the full gross (for the admin fleet
-- account, a 'spent_on_compute' row on one of its providers), credited the
-- serving node its share as a 'paid' row (amount_usd = gross - fee_usd), and
-- the fee itself was only a number on that row (fee_usd). Nothing credited it
-- anywhere, so every job the platform account paid for left it 5% short.
--
-- Now every fee-bearing credit ('paid' and 'reservation' rows with
-- fee_usd > 0) posts a matching 'platform_fee' credit to the platform
-- provider (settings 'earnings'.platform_provider_id, a provider linked to the
-- admin account): amount_usd = fee_usd, same status as its source row (so a
-- confirmed job's fee is confirmed, a voided one is voided), keyed by
-- source_earning_id so it is posted once. Per job:
--   debit gross  =  node share (paid.amount_usd)  +  platform_fee.amount_usd
-- and the platform account nets to zero on the jobs it pays for itself.
--
-- A trigger posts it, so every write path (interactive billing, batches,
-- reservations, CoinPay-paid jobs) is covered without each one remembering.
-- Revenue reads these rows (lib/earnings/core.js summariseFees,
-- lib/earnings/revenue.js) instead of summing fee_usd, so nothing counts twice.
--
-- Idempotent: re-running changes nothing (columns/constraints guarded, the
-- backfill upserts on source_earning_id).

alter table public.provider_earnings
    add column if not exists source_earning_id uuid references public.provider_earnings(id) on delete restrict;

alter table public.provider_earnings drop constraint if exists provider_earnings_kind_check;
alter table public.provider_earnings
    add constraint provider_earnings_kind_check
    check (kind in ('paid', 'subsidy', 'reservation', 'spent_on_compute', 'platform_fee'));

alter table public.provider_earnings drop constraint if exists provider_earnings_target_shape;
alter table public.provider_earnings
    add constraint provider_earnings_target_shape check (
        (kind = 'reservation' and reservation_id is not null)
        or (kind = 'spent_on_compute' and transfer_id is not null and job_id is null)
        -- The fee row points at its source credit, not at the job: the
        -- platform provider may have served that job too, and
        -- (job_id, provider_id) is unique.
        or (kind = 'platform_fee' and source_earning_id is not null
            and job_id is null and reservation_id is null and transfer_id is null)
        or (kind not in ('reservation', 'spent_on_compute', 'platform_fee') and job_id is not null)
    );

create unique index if not exists provider_earnings_platform_fee_key
    on public.provider_earnings (source_earning_id) where kind = 'platform_fee';

-- The provider the house fee is credited to, or null (no fee rows then).
create or replace function public.platform_fee_provider_id()
returns uuid
language plpgsql
stable
as $$
declare
    raw text;
    id  uuid;
begin
    select value->>'platform_provider_id' into raw from public.settings where key = 'earnings';
    if raw is null or raw !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        return null;
    end if;
    select p.id into id from public.providers p where p.id = raw::uuid;
    return id;
end $$;

-- Post (or bring up to date) the platform_fee credit for one source credit.
create or replace function public.post_platform_fee(e public.provider_earnings)
returns void
language plpgsql
as $$
declare
    platform uuid;
begin
    if e.kind not in ('paid', 'reservation') then return; end if;
    platform := public.platform_fee_provider_id();
    if platform is null then return; end if;
    if coalesce(e.fee_usd, 0) <= 0 then
        -- No fee (any more): void a fee row posted earlier.
        update public.provider_earnings
           set status = 'void'
         where kind = 'platform_fee' and source_earning_id = e.id and status <> 'void';
        return;
    end if;
    insert into public.provider_earnings (job_id, provider_id, kind, role, share, output_tokens,
            gross_usd, fee_usd, amount_usd, coin, status, model_name, confirmed_at, earned_at, created_at,
            source_earning_id, metadata)
    values (null, platform, 'platform_fee', 'single', 1, 0,
            e.fee_usd, 0, e.fee_usd, e.coin, e.status, e.model_name, e.confirmed_at, e.earned_at, e.created_at,
            e.id,
            jsonb_build_object('source', 'house_fee', 'source_kind', e.kind, 'job_id', e.job_id,
                               'reservation_id', e.reservation_id, 'node_provider_id', e.provider_id))
    on conflict (source_earning_id) where kind = 'platform_fee' do update
       set amount_usd = excluded.amount_usd,
           gross_usd = excluded.gross_usd,
           status = excluded.status,
           confirmed_at = excluded.confirmed_at;
end $$;

create or replace function public.provider_earnings_post_platform_fee()
returns trigger
language plpgsql
as $$
begin
    perform public.post_platform_fee(new);
    return null;
end $$;

drop trigger if exists provider_earnings_platform_fee on public.provider_earnings;
create trigger provider_earnings_platform_fee
    after insert or update of status, fee_usd, confirmed_at on public.provider_earnings
    for each row
    when (new.kind in ('paid', 'reservation'))
    execute function public.provider_earnings_post_platform_fee();

-- Production: the house fee goes to the admin fleet account's vienna node,
-- the provider its own compute spending is debited from. Only set where that
-- provider exists and nothing was chosen yet, so other databases are untouched.
update public.settings
   set value = value || jsonb_build_object('platform_provider_id', '33a068dd-c60c-4015-821b-1e7466290f80')
 where key = 'earnings'
   and not (value ? 'platform_provider_id')
   and exists (select 1 from public.providers where id = '33a068dd-c60c-4015-821b-1e7466290f80');

-- Backfill every fee ever charged (one row per source credit; re-runs are no-ops).
do $$
declare r public.provider_earnings;
begin
    for r in select * from public.provider_earnings
              where kind in ('paid', 'reservation') and fee_usd > 0
              order by created_at loop
        perform public.post_platform_fee(r);
    end loop;
end $$;
