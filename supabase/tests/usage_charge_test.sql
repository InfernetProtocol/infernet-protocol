-- Ledger invariants for supabase/migrations/20261122200000_usage_charge.sql
-- (billing_charge_exact: charge exactly the amount, or nothing).
-- Run against a THROWAWAY database that has the schema and the migration:
--   docker exec -i <postgres container> psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < supabase/tests/usage_charge_test.sql
-- Raises (and so exits non-zero under ON_ERROR_STOP) on the first broken rule.
-- Uses its own user ids and cleans up after itself.

\set ON_ERROR_STOP 1

create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin
    if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

delete from public.billing_ledger where user_id like 'sqltest-usage-%';
delete from public.billing_accounts where user_id like 'sqltest-usage-%';

do $$
declare
    r jsonb; n int; job uuid := gen_random_uuid();
begin
    insert into public.billing_accounts (user_id, balance_micro, held_micro)
        values ('sqltest-usage-a', 1000000, 400000);          -- 0.60 available, 0.40 held by a batch

    -- 1. Not enough: nothing moves, no ledger row, and the key stays unused.
    r := public.billing_charge_exact('sqltest-usage-a', 'sqltest-usage:k1', 700000, false, job);
    perform pg_temp.assert(not (r->>'charged')::boolean, 'short balance must not charge');
    perform pg_temp.assert(r->>'reason' = 'insufficient_balance', 'reason is insufficient_balance');
    perform pg_temp.assert((r->>'spendable_micro')::bigint = 600000, 'spendable is what is not held');
    perform pg_temp.assert((select balance_micro from public.billing_accounts where user_id = 'sqltest-usage-a') = 1000000,
        'balance untouched by a refused charge');
    select count(*) into n from public.billing_ledger where user_id = 'sqltest-usage-a';
    perform pg_temp.assert(n = 0, 'a refused charge writes no ledger row');

    -- 2. Enough: exactly the amount, once.
    r := public.billing_charge_exact('sqltest-usage-a', 'sqltest-usage:k2', 250000, false, job);
    perform pg_temp.assert((r->>'charged')::boolean, 'covered charge goes through');
    perform pg_temp.assert((r->>'charged_micro')::bigint = 250000, 'charged in full');
    perform pg_temp.assert((r->>'spendable_micro')::bigint = 350000, 'spendable after the charge');
    perform pg_temp.assert((select balance_micro from public.billing_accounts where user_id = 'sqltest-usage-a') = 750000,
        'balance down by exactly the charge');

    -- 3. Replay: the original amount comes back and nothing moves.
    r := public.billing_charge_exact('sqltest-usage-a', 'sqltest-usage:k2', 250000, false, job);
    perform pg_temp.assert(not (r->>'charged')::boolean and r->>'reason' = 'already_charged', 'replay is a no-op');
    perform pg_temp.assert((r->>'charged_micro')::bigint = 250000, 'replay reports the original amount');
    perform pg_temp.assert(r->>'user_id' = 'sqltest-usage-a', 'replay reports whose charge it was');
    perform pg_temp.assert((select balance_micro from public.billing_accounts where user_id = 'sqltest-usage-a') = 750000,
        'replay moved nothing');
    select count(*) into n from public.billing_ledger where user_id = 'sqltest-usage-a' and kind = 'charge';
    perform pg_temp.assert(n = 1, 'one charge row for one key');

    -- 4. The refused key from step 1 is free to use once the money is there.
    update public.billing_accounts set held_micro = 0 where user_id = 'sqltest-usage-a';
    r := public.billing_charge_exact('sqltest-usage-a', 'sqltest-usage:k1', 700000, false, job);
    perform pg_temp.assert((r->>'charged')::boolean and (r->>'charged_micro')::bigint = 700000, 'retry after funding charges');
    perform pg_temp.assert((r->>'spendable_micro')::bigint = 50000, 'spendable after the retry');

    -- 5. Someone with no account at all: refused, never negative.
    r := public.billing_charge_exact('sqltest-usage-b', 'sqltest-usage:k3', 1, false, null);
    perform pg_temp.assert(not (r->>'charged')::boolean and r->>'reason' = 'insufficient_balance', 'empty account is refused');
    perform pg_temp.assert((r->>'spendable_micro')::bigint = 0, 'empty account has nothing to spend');

    -- 6. Zero is not a charge.
    r := public.billing_charge_exact('sqltest-usage-a', 'sqltest-usage:k4', 0, false, null);
    perform pg_temp.assert(not (r->>'charged')::boolean and r->>'reason' = 'nothing_to_charge', 'zero charges nothing');
end $$;

delete from public.billing_ledger where user_id like 'sqltest-usage-%';
delete from public.billing_accounts where user_id like 'sqltest-usage-%';

\echo usage_charge_test: ok
