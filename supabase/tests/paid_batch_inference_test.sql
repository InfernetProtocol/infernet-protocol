-- Ledger invariants for supabase/migrations/20261102020000_paid_batch_inference.sql.
-- Run against a THROWAWAY database that has the schema and the migration:
--   tooling/test-paid-batch-sql.sh <postgres container>
-- Raises (and so exits non-zero under ON_ERROR_STOP) on the first broken rule.
-- Uses its own user ids and cleans up after itself.

\set ON_ERROR_STOP 1

create or replace function pg_temp.assert(cond boolean, msg text) returns void language plpgsql as $$
begin
    if cond is not true then raise exception 'ASSERT FAILED: %', msg; end if;
end $$;

-- available = balance - held; ledger sums agree with the cached account row:
--   balance = topup + transfer_in - transfer_out - charge, held = hold - charge - release.
create or replace function pg_temp.check_account(p_user text) returns void language plpgsql as $$
declare a public.billing_accounts; t bigint; h bigint; c bigint; r bigint; ti bigint; tout bigint;
begin
    select * into a from public.billing_accounts where user_id = p_user;
    select coalesce(sum(amount_micro) filter (where kind = 'topup'), 0),
           coalesce(sum(amount_micro) filter (where kind = 'hold'), 0),
           coalesce(sum(amount_micro) filter (where kind = 'charge'), 0),
           coalesce(sum(amount_micro) filter (where kind = 'release'), 0),
           coalesce(sum(amount_micro) filter (where kind = 'transfer_in'), 0),
           coalesce(sum(amount_micro) filter (where kind = 'transfer_out'), 0)
      into t, h, c, r, ti, tout from public.billing_ledger where user_id = p_user;
    perform pg_temp.assert(a.balance_micro = t + ti - tout - c,
        format('balance %s <> topup %s + transfer_in %s - transfer_out %s - charge %s', a.balance_micro, t, ti, tout, c));
    perform pg_temp.assert(a.held_micro = h - c - r, format('held %s <> hold %s - charge %s - release %s', a.held_micro, h, c, r));
    perform pg_temp.assert(a.balance_micro - a.held_micro >= 0, 'available went negative');
end $$;

delete from public.inference_batch_items where batch_id in (select id from public.inference_batches where user_id like 'sqltest-%');
delete from public.inference_batches where user_id like 'sqltest-%';
delete from public.billing_ledger where user_id like 'sqltest-%';
delete from public.billing_topups where user_id like 'sqltest-%';
delete from public.billing_accounts where user_id like 'sqltest-%';

do $$
declare
    tid uuid; r jsonb; bid uuid; items jsonb; it record; n int;
begin
    -- 1. Top-up credits exactly once.
    insert into public.billing_topups (user_id, amount_usd, amount_micro) values ('sqltest-a', 5, 5000000) returning id into tid;
    r := public.billing_credit_topup(tid, '0xabc');
    perform pg_temp.assert((r->>'credited')::boolean, 'first credit');
    r := public.billing_credit_topup(tid, '0xabc');
    perform pg_temp.assert(not (r->>'credited')::boolean, 'replayed credit must be a no-op');
    perform pg_temp.assert((select balance_micro from public.billing_accounts where user_id = 'sqltest-a') = 5000000, 'balance after topup');
    perform pg_temp.check_account('sqltest-a');

    -- 2. Submit: hold for the total, idempotent on the key.
    items := '[{"idx":0,"custom_id":"a","input":{},"max_tokens":100,"input_tokens":10,"max_cost_micro":1000000},
               {"idx":1,"custom_id":"b","input":{},"max_tokens":100,"input_tokens":10,"max_cost_micro":1000000},
               {"idx":2,"custom_id":"c","input":{},"max_tokens":100,"input_tokens":10,"max_cost_micro":1000000}]';
    r := public.inference_submit_batch('sqltest-a', 'k1', jsonb_build_object('model','m','max_cost_micro',3000000,
            'input_micro_per_m',50000,'output_micro_per_m',200000,'house_fee_pct',2,'max_in_flight',2), items);
    perform pg_temp.assert((r->>'ok')::boolean and not (r->>'existing')::boolean, 'submit ok');
    bid := (r->>'batch_id')::uuid;
    r := public.inference_submit_batch('sqltest-a', 'k1', jsonb_build_object('model','m','max_cost_micro',3000000,
            'input_micro_per_m',50000,'output_micro_per_m',200000,'house_fee_pct',2), items);
    perform pg_temp.assert((r->>'existing')::boolean and (r->>'batch_id')::uuid = bid, 'same idempotency key returns the same batch');
    perform pg_temp.assert((select held_micro from public.billing_accounts where user_id = 'sqltest-a') = 3000000, 'one hold only');
    perform pg_temp.check_account('sqltest-a');

    -- 3. Over the cap / over the balance are refused and move nothing.
    r := public.inference_submit_batch('sqltest-a', 'k2', jsonb_build_object('model','m','max_cost_micro',500000,
            'input_micro_per_m',1,'output_micro_per_m',1,'house_fee_pct',2), items);
    perform pg_temp.assert(r->>'reason' = 'over_max_cost', 'max_cost cap');
    r := public.inference_submit_batch('sqltest-a', 'k3', jsonb_build_object('model','m','max_cost_micro',9000000,
            'input_micro_per_m',1,'output_micro_per_m',1,'house_fee_pct',2), items);
    perform pg_temp.assert(r->>'reason' = 'insufficient_balance' and (r->>'available_micro')::bigint = 2000000, 'available balance');
    perform pg_temp.check_account('sqltest-a');

    -- 4. Claim respects max_in_flight.
    select count(*) into n from public.inference_claim_items(bid);
    perform pg_temp.assert(n = 2, format('claimed %s, want 2', n));
    select count(*) into n from public.inference_claim_items(bid);
    perform pg_temp.assert(n = 0, 'nothing more while 2 are in flight');

    -- 5. Settle: completed charges min(cost, max); replay is a no-op; failed charges 0.
    select id into it from public.inference_batch_items where batch_id = bid and custom_id = 'a';
    r := public.inference_settle_item(it.id, 'completed', 50, 9999999, null);
    perform pg_temp.assert((r->>'charged_micro')::bigint = 1000000, 'charge is capped at the item max');
    r := public.inference_settle_item(it.id, 'completed', 50, 10, null);
    perform pg_temp.assert(r->>'reason' = 'already', 'settle replay is a no-op');
    select id into it from public.inference_batch_items where batch_id = bid and custom_id = 'b';
    r := public.inference_settle_item(it.id, 'failed', 0, 500, 'boom');
    perform pg_temp.assert((r->>'charged_micro')::bigint = 0 and (r->>'released_micro')::bigint = 1000000, 'failed charges 0');
    perform pg_temp.check_account('sqltest-a');

    -- 6. Cancel releases the queued item; the batch finishes as cancelled.
    r := public.inference_cancel_batch(bid, 'someone-else');
    perform pg_temp.assert(not (r->>'ok')::boolean, 'only the owner can cancel');
    r := public.inference_cancel_batch(bid, 'sqltest-a');
    perform pg_temp.assert((r->>'cancelled_items')::int = 1, 'one queued item cancelled');
    perform pg_temp.assert((select status from public.inference_batches where id = bid) = 'cancelled', 'batch cancelled');
    perform pg_temp.assert((select held_micro from public.billing_accounts where user_id = 'sqltest-a') = 0, 'no hold left');
    perform pg_temp.assert((select balance_micro from public.billing_accounts where user_id = 'sqltest-a') = 4000000, 'paid only for item a');
    perform pg_temp.check_account('sqltest-a');

    -- 7. A cheap completion releases the unused part; a full batch completes.
    r := public.inference_submit_batch('sqltest-a', 'k4', jsonb_build_object('model','m','max_cost_micro',1000000,
            'input_micro_per_m',1,'output_micro_per_m',1,'house_fee_pct',2),
            '[{"idx":0,"custom_id":"x","input":{},"max_tokens":10,"input_tokens":1,"max_cost_micro":1000000}]');
    bid := (r->>'batch_id')::uuid;
    perform public.inference_claim_items(bid);
    select id into it from public.inference_batch_items where batch_id = bid;
    r := public.inference_settle_item(it.id, 'cancelled', 0, 0, null);
    perform pg_temp.assert(r->>'reason' = 'not_queued', 'a dispatched item cannot be cancelled');
    r := public.inference_settle_item(it.id, 'requeue', 0, 0, 'no provider');
    perform pg_temp.assert((r->>'requeued')::boolean, 'requeue');
    perform public.inference_claim_items(bid);
    r := public.inference_settle_item(it.id, 'completed', 3, 123, null);
    perform pg_temp.assert((r->>'charged_micro')::bigint = 123 and (r->>'released_micro')::bigint = 999877 and (r->>'batch_done')::boolean, 'partial charge + release, batch done');
    perform pg_temp.assert((select status from public.inference_batches where id = bid) = 'completed', 'batch completed');
    perform pg_temp.check_account('sqltest-a');

    -- 8. The table constraint itself refuses a negative available balance.
    begin
        update public.billing_accounts set held_micro = balance_micro + 1 where user_id = 'sqltest-a';
        raise exception 'ASSERT FAILED: constraint allowed held > balance';
    exception when check_violation then null;
    end;
    raise notice 'paid batch SQL invariants: all passed';
end $$;

-- Earned balance funding ----------------------------------------------------
-- A user with one node: $3 subsidy confirmed, $5 pending approval and $2
-- paid-pending (neither counts), $0.50 already paid out. Spendable = $2.50.
delete from public.payout_requests where provider_id = '00000000-0000-0000-0000-0000000000e1';
delete from public.provider_earnings where provider_id = '00000000-0000-0000-0000-0000000000e1';
delete from public.jobs where id in ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f3');
delete from public.pubkey_links where user_id = '00000000-0000-0000-0000-0000000000a1';
delete from public.providers where id = '00000000-0000-0000-0000-0000000000e1';
insert into public.providers (id, name, public_key) values ('00000000-0000-0000-0000-0000000000e1', 'sqltest-node', repeat('e', 64));
insert into public.pubkey_links (user_id, pubkey, role) values ('00000000-0000-0000-0000-0000000000a1', repeat('e', 64), 'provider');
insert into public.jobs (id, title) values ('00000000-0000-0000-0000-0000000000f1', 't'), ('00000000-0000-0000-0000-0000000000f2', 't'), ('00000000-0000-0000-0000-0000000000f3', 't');
insert into public.provider_earnings (job_id, provider_id, kind, amount_usd, status) values
    ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000e1', 'subsidy', 3, 'confirmed'),
    ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000e1', 'subsidy', 5, 'pending_approval'),
    ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000e1', 'paid', 2, 'pending');
insert into public.payout_requests (provider_id, amount_usd, coin, address, status) values
    ('00000000-0000-0000-0000-0000000000e1', 0.5, 'USDC', '0x0', 'sent');

do $$
declare
    u text := '00000000-0000-0000-0000-0000000000a1';
    prov uuid := '00000000-0000-0000-0000-0000000000e1';
    r jsonb; bid uuid; it record; tid uuid;
    one jsonb := '[{"idx":0,"custom_id":"a","input":{},"max_tokens":1,"input_tokens":1,"max_cost_micro":2000000}]';
    b jsonb := '{"model":"m","max_cost_micro":2000000,"input_micro_per_m":1,"output_micro_per_m":1,"house_fee_pct":2}';
begin
    delete from public.inference_batch_items where batch_id in (select id from public.inference_batches where user_id = u);
    delete from public.inference_batches where user_id = u;
    delete from public.billing_ledger where user_id = u;
    delete from public.billing_topups where user_id = u;
    delete from public.billing_accounts where user_id = u;

    r := public.billing_funding_preview(u);
    perform pg_temp.assert((r->>'earned_spendable_micro')::bigint = 2500000, format('spendable %s, want 2500000 (pending never counts)', r));

    -- prepaid_only refuses even though earnings could pay; it reports both.
    r := public.inference_submit_batch(u, 'e0', b || '{"funding":["prepaid"]}', one);
    perform pg_temp.assert(r->>'reason' = 'insufficient_balance' and (r->>'shortfall_micro')::bigint = 2000000, 'prepaid_only ignores earnings');

    -- Earned first: $2 moves from earnings into the hold.
    r := public.inference_submit_batch(u, 'e1', b || '{"funding":["earned","prepaid"]}', one);
    perform pg_temp.assert((r->>'ok')::boolean and (r->>'earned_micro')::bigint = 2000000, format('earned funding %s', r));
    bid := (r->>'batch_id')::uuid;
    perform pg_temp.assert(public.provider_available_usd(prov) = 0.5, 'provider available after the spend');
    perform pg_temp.check_account(u);
    -- Replay moves nothing.
    r := public.inference_submit_batch(u, 'e1', b || '{"funding":["earned","prepaid"]}', one);
    perform pg_temp.assert((r->>'existing')::boolean and public.provider_available_usd(prov) = 0.5, 'replay moves no earnings');

    -- A payout can no longer take the spent money.
    begin
        insert into public.payout_requests (provider_id, amount_usd, coin, address) values (prov, 1, 'USDC', '0x0');
        raise exception 'ASSERT FAILED: payout above available was accepted';
    exception when check_violation then null;
    end;

    -- Charge $0.30; the unused $1.70 returns to earnings at batch end.
    perform public.inference_claim_items(bid);
    select id into it from public.inference_batch_items where batch_id = bid;
    r := public.inference_settle_item(it.id, 'completed', 1, 300000, null);
    perform pg_temp.assert((r->>'batch_done')::boolean, 'batch done');
    perform pg_temp.assert((select returned_earned_micro from public.inference_batches where id = bid) = 1700000, 'unused earned returned');
    perform pg_temp.assert(public.provider_available_usd(prov) = 2.2, format('available %s, want 2.2', public.provider_available_usd(prov)));
    perform pg_temp.assert((select balance_micro from public.billing_accounts where user_id = u) = 0, 'compute balance back to 0');
    perform pg_temp.check_account(u);

    -- Prepaid first: $1 prepaid + $1 earned.
    insert into public.billing_topups (user_id, amount_usd, amount_micro) values (u, 1, 1000000) returning id into tid;
    perform public.billing_credit_topup(tid);
    r := public.inference_submit_batch(u, 'e2', b || '{"funding":["prepaid","earned"]}', one);
    perform pg_temp.assert((r->>'ok')::boolean and (r->>'earned_micro')::bigint = 1000000, format('prepaid first %s', r));
    perform pg_temp.check_account(u);
    raise notice 'paid batch earned-funding invariants: all passed';
end $$;

-- Wallet: the request's own payment covers only its shortfall source.
do $$
declare u text := 'sqltest-w'; r jsonb; tid uuid;
    one jsonb := '[{"idx":0,"custom_id":"a","input":{},"max_tokens":1,"input_tokens":1,"max_cost_micro":1500000}]';
    b jsonb := '{"model":"m","max_cost_micro":1500000,"input_micro_per_m":1,"output_micro_per_m":1,"house_fee_pct":2}';
begin
    delete from public.inference_batch_items where batch_id in (select id from public.inference_batches where user_id = u);
    delete from public.inference_batches where user_id = u;
    delete from public.billing_ledger where user_id = u;
    delete from public.billing_topups where user_id = u;
    delete from public.billing_accounts where user_id = u;
    insert into public.billing_topups (user_id, amount_usd, amount_micro) values (u, 1, 1000000) returning id into tid;
    perform public.billing_credit_topup(tid);
    -- wallet only, nothing paid by wallet yet: refused even with $1 prepaid.
    r := public.inference_submit_batch(u, 'w0', b || '{"funding":["wallet"]}', one);
    perform pg_temp.assert(r->>'reason' = 'insufficient_balance' and (r->>'shortfall_micro')::bigint = 1500000, format('wallet only %s', r));
    -- prepaid then wallet: $1 prepaid + $0.50 just paid by x402 (credited as a top-up).
    insert into public.billing_topups (user_id, amount_usd, amount_micro, source, payment_ref) values (u, 0.5, 500000, 'x402', 'nonce-1') returning id into tid;
    perform public.billing_credit_topup(tid);
    r := public.inference_submit_batch(u, 'w1', b || '{"funding":["prepaid","wallet"],"wallet_micro":500000}', one);
    perform pg_temp.assert((r->>'ok')::boolean, format('prepaid + wallet %s', r));
    perform pg_temp.assert((select funded_wallet_micro from public.inference_batches where id = (r->>'batch_id')::uuid) = 500000, 'wallet share recorded');
    -- the same x402 nonce cannot be recorded twice
    begin
        insert into public.billing_topups (user_id, amount_usd, amount_micro, source, payment_ref) values (u, 0.5, 500000, 'x402', 'nonce-1');
        raise exception 'ASSERT FAILED: replayed x402 nonce accepted';
    exception when unique_violation then null;
    end;
    perform pg_temp.check_account(u);
    raise notice 'paid batch wallet invariants: all passed';
end $$;
