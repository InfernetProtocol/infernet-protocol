-- The shared @profullstack/profile fields (email, first_name, last_name,
-- company_domain, job_title, linkedin_url) in the package's own table, keyed
-- by the Supabase auth user id. public.users is keyed by Nostr pubkey (and is
-- empty), so it is not the per-account record.
--
-- Service-role only: RLS on, no policies, no anon/authenticated grants.
-- No backfill: no auth account has a stored name.
--
-- Apply by hand on dev2 (the deploy never runs migrations):
--   docker exec -i infernetprotocol-com-supabase-db psql -U postgres -d postgres -1 < this file
--   then: notify pgrst, 'reload schema';
-- Additive and idempotent, so it is safe before the deploy.

create table if not exists public.user_profiles (
  "user_id" uuid primary key references auth.users (id) on delete cascade,
  "email" text,
  "first_name" text,
  "last_name" text,
  "company_domain" text,
  "job_title" text,
  "linkedin_url" text,
  "created_at" timestamptz not null default now(),
  "updated_at" timestamptz not null default now()
);
create index if not exists "user_profiles_email" on public.user_profiles (lower("email"));
create index if not exists "user_profiles_company_domain" on public.user_profiles ("company_domain");

alter table public.user_profiles enable row level security;
revoke all on public.user_profiles from anon, authenticated;
