-- Provider earnings ledger + payout requests.
--
-- Until now a completed free (playground) job credited nobody, and a paid
-- job only queued an 'outbound' payment_transactions row that nothing read.
-- Providers saw "$0.00 earned" with no way to tell free from unpaid.
--
-- provider_earnings: one row per (job, provider). Paid jobs carry the
--   provider's share of payment_offer after the house fee; free jobs carry a
--   house subsidy per 1k output tokens, 'pending_approval' until the rate is
--   approved. Earnings accrue with or without a payout address.
-- payout_requests: a provider asks to withdraw its confirmed balance; an
--   admin approves; only then is a CoinPay payout sent.

create table if not exists public.provider_earnings (
  id               uuid primary key default gen_random_uuid(),
  job_id           uuid not null references public.jobs(id) on delete cascade,
  provider_id      uuid not null references public.providers(id) on delete cascade,
  kind             text not null check (kind in ('paid', 'subsidy')),
  role             text not null default 'single',          -- single | primary | slice
  share            numeric(12, 8) not null default 1,
  output_tokens    integer not null default 0,
  rate_per_1k_usd  numeric(14, 8),                           -- subsidy rate used (null for paid)
  gross_usd        numeric(18, 8) not null default 0,
  fee_usd          numeric(18, 8) not null default 0,
  amount_usd       numeric(18, 8) not null default 0,
  coin             text,
  status           text not null default 'pending'
                     check (status in ('pending_approval', 'pending', 'confirmed', 'void')),
  model_name       text,
  metadata         jsonb not null default '{}'::jsonb,
  earned_at        timestamptz not null default now(),
  confirmed_at     timestamptz,
  created_at       timestamptz not null default now(),
  unique (job_id, provider_id)
);

create index if not exists provider_earnings_provider_idx on public.provider_earnings (provider_id, earned_at desc);
create index if not exists provider_earnings_status_idx   on public.provider_earnings (status);

create table if not exists public.payout_requests (
  id                 uuid primary key default gen_random_uuid(),
  provider_id        uuid not null references public.providers(id) on delete cascade,
  amount_usd         numeric(18, 8) not null check (amount_usd > 0),
  coin               text not null,
  network            text,
  address            text not null,
  status             text not null default 'requested'
                       check (status in ('requested', 'approved', 'sending', 'sent', 'rejected', 'failed')),
  requested_via      text,                                   -- cli | dashboard
  approved_by        text,
  approved_at        timestamptz,
  sent_at            timestamptz,
  tx_hash            text,
  gateway_payout_id  text,
  error              text,
  metadata           jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists payout_requests_provider_idx on public.payout_requests (provider_id, created_at desc);
create index if not exists payout_requests_status_idx   on public.payout_requests (status);
-- At most one open request per provider.
create unique index if not exists payout_requests_one_open
  on public.payout_requests (provider_id)
  where status in ('requested', 'approved', 'sending');

-- The subsidy rate is undecided while credits are 'pending_approval', so a
-- rate change re-prices all of them (confirmed credits keep their rate).
create or replace function public.reprice_pending_subsidy(new_rate numeric)
returns integer
language sql
security definer
set search_path = public
as $$
  with updated as (
    update public.provider_earnings
       set rate_per_1k_usd = new_rate,
           gross_usd  = round(output_tokens::numeric / 1000 * new_rate, 8),
           amount_usd = round(output_tokens::numeric / 1000 * new_rate, 8),
           fee_usd    = 0
     where kind = 'subsidy' and status = 'pending_approval'
     returning 1
  )
  select count(*)::integer from updated;
$$;

revoke all on function public.reprice_pending_subsidy(numeric) from public, anon, authenticated;
grant execute on function public.reprice_pending_subsidy(numeric) to service_role;

-- Service role only (the app reads and writes server-side).
alter table public.provider_earnings enable row level security;
alter table public.payout_requests   enable row level security;

notify pgrst, 'reload schema';
