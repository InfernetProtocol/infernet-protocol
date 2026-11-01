-- Provider rows are part of the financial ledger's identity. Removing a node
-- must not cascade away earnings or payout history; application removal now
-- archives providers instead.
alter table public.providers
  add column if not exists archived_at timestamptz,
  add column if not exists archived_is_public boolean;

alter table public.provider_earnings
  drop constraint if exists provider_earnings_provider_id_fkey;
alter table public.provider_earnings
  add constraint provider_earnings_provider_id_fkey
  foreign key (provider_id) references public.providers(id) on delete restrict;

alter table public.provider_earnings
  drop constraint if exists provider_earnings_job_id_fkey;
alter table public.provider_earnings
  add constraint provider_earnings_job_id_fkey
  foreign key (job_id) references public.jobs(id) on delete restrict;

alter table public.payout_requests
  drop constraint if exists payout_requests_provider_id_fkey;
alter table public.payout_requests
  add constraint payout_requests_provider_id_fkey
  foreign key (provider_id) references public.providers(id) on delete restrict;

notify pgrst, 'reload schema';
