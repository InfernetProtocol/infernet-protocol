#!/usr/bin/env bash
# Paid batch inference: SQL ledger tests against a THROWAWAY Postgres container
# that already has the schema and supabase/migrations/20261102020000_paid_batch_inference.sql.
# Never point this at production.
#
#   docker run -d --rm --name infbatch-pg -e POSTGRES_PASSWORD=x postgres:15
#   (load a schema-only dump + the migration)
#   tooling/test-paid-batch-sql.sh infbatch-pg
#
# 1. supabase/tests/paid_batch_inference_test.sql: top-up once, hold, idempotent
#    submit, caps, claim bound, settle/replay, cancel, invariants.
# 2. Concurrency: 20 parallel submits of $1 each against a $5 balance, each in
#    its own session. Exactly 5 may succeed and available never goes negative.
# 3. Payout request vs earned-balance spend racing for the same money.
set -euo pipefail
C="${1:?usage: test-paid-batch-sql.sh <throwaway postgres container>}"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
psql() { docker exec -i "$C" psql -q -X -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"; }

psql < "$HERE/supabase/tests/paid_batch_inference_test.sql"

psql <<'SQL'
delete from public.inference_batch_items where batch_id in (select id from public.inference_batches where user_id = 'sqltest-race');
delete from public.inference_batches where user_id = 'sqltest-race';
delete from public.billing_ledger where user_id = 'sqltest-race';
delete from public.billing_topups where user_id = 'sqltest-race';
delete from public.billing_accounts where user_id = 'sqltest-race';
with t as (insert into public.billing_topups (user_id, amount_usd, amount_micro) values ('sqltest-race', 5, 5000000) returning id)
select public.billing_credit_topup(id) from t;
SQL

pids=()
for i in $(seq 1 20); do
  psql -c "select pg_sleep(random() * 0.05); select public.inference_submit_batch('sqltest-race', 'race-$i',
    '{\"model\":\"m\",\"max_cost_micro\":1000000,\"input_micro_per_m\":1,\"output_micro_per_m\":1,\"house_fee_pct\":2}',
    '[{\"idx\":0,\"custom_id\":\"a\",\"input\":{},\"max_tokens\":1,\"input_tokens\":1,\"max_cost_micro\":1000000}]');" >/dev/null &
  pids+=($!)
done
for p in "${pids[@]}"; do wait "$p"; done

out="$(psql -At -c "select (select count(*) from public.inference_batches where user_id = 'sqltest-race'),
  balance_micro, held_micro from public.billing_accounts where user_id = 'sqltest-race'")"
echo "race: batches|balance|held = $out"
[ "$out" = "5|5000000|5000000" ] || { echo "FAIL: concurrent submits overdrew or lost a hold"; exit 1; }

# 3. Payout vs spend race: $2.50 spendable; a $2.50 payout request and a
#    $2.50 earned-only batch submit at the same moment, 10 rounds. Exactly
#    one of the two may take the money each round.
for round in $(seq 1 10); do
  psql >/dev/null <<'SQL'
delete from public.inference_batch_items where batch_id in (select id from public.inference_batches where user_id = '00000000-0000-0000-0000-0000000000a1');
delete from public.inference_batches where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.billing_ledger where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.billing_topups where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.billing_accounts where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.provider_earnings where provider_id = '00000000-0000-0000-0000-0000000000e1' and kind = 'spent_on_compute';
delete from public.payout_requests where provider_id = '00000000-0000-0000-0000-0000000000e1' and status <> 'sent';
SQL
  psql -c "insert into public.payout_requests (provider_id, amount_usd, coin, address) values ('00000000-0000-0000-0000-0000000000e1', 2.5, 'USDC', '0x0');" >/dev/null 2>&1 &
  a=$!
  psql -c "select public.inference_submit_batch('00000000-0000-0000-0000-0000000000a1', 'race', '{\"model\":\"m\",\"max_cost_micro\":2500000,\"input_micro_per_m\":1,\"output_micro_per_m\":1,\"house_fee_pct\":2,\"funding\":[\"earned\"]}', '[{\"idx\":0,\"custom_id\":\"a\",\"input\":{},\"max_tokens\":1,\"input_tokens\":1,\"max_cost_micro\":2500000}]');" >/dev/null 2>&1 &
  b=$!
  wait $a || true; wait $b || true
  got="$(psql -At -c "select (select count(*) from public.payout_requests where provider_id = '00000000-0000-0000-0000-0000000000e1' and status = 'requested')
     + (select count(*) from public.inference_batches where user_id = '00000000-0000-0000-0000-0000000000a1'),
     public.provider_available_usd('00000000-0000-0000-0000-0000000000e1') >= 0")"
  [ "$got" = "1|t" ] || { echo "FAIL round $round: payout+spend winners|available>=0 = $got"; exit 1; }
done
echo "payout vs spend race: 10 rounds, one winner each"
echo "paid batch SQL tests: all passed"
