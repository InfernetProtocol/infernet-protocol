-- Operator vault (2026-10-28): our own payout key is sealed like a user's.
--
-- The CoinPay key that can send payouts no longer comes from the environment.
-- It is sealed under a passphrase only the operators know (PBKDF2 600k -> HKDF
-- -> AES-256-GCM, @profullstack/sealed-secrets, plus a recovery key shown once);
-- this table holds the sealed vault record and the sealed key, nothing that
-- opens them. An admin unlocks from /admin/payouts; the key then lives in the
-- web process's memory for the time chosen (7 days by default) and a restart
-- locks it again. Service role only.
create table if not exists public.operator_secrets (
  name text primary key,
  seal jsonb,
  blob jsonb,
  updated_at timestamptz not null default now()
);
alter table public.operator_secrets enable row level security;
revoke all on public.operator_secrets from anon, authenticated;
grant all on public.operator_secrets to service_role;
