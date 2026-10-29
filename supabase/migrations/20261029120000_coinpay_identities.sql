-- Sign in with CoinPay: bind an Infernet user to a CoinPay account by its OIDC
-- `sub`, never by email (CoinPay never verifies emails, so email_verified is
-- always false). One CoinPay account per user and one user per CoinPay
-- account. Additive only.
--
-- created_via = 'connect': linked from Settings while signed in to an existing
--   account (that account keeps its own email and password).
-- created_via = 'signup': a first CoinPay login created the account. Its auth
--   email is a random placeholder under coinpay-users.infernetprotocol.com;
--   the CoinPay email is kept here as UNVERIFIED contact info and is never
--   used to find, merge or sign in to an account.
create table if not exists public.coinpay_identities (
  user_id uuid primary key references auth.users(id) on delete cascade,
  coinpay_sub text not null unique,
  coinpay_email text,
  coinpay_name text,
  created_via text not null check (created_via in ('connect', 'signup')),
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);
alter table public.coinpay_identities enable row level security;
revoke all on table public.coinpay_identities from anon, authenticated;
-- Server code (service role) is the only reader and writer.
grant select, insert, update, delete on table public.coinpay_identities to service_role;
