-- Paid batch inference (2026-11-02). Additive and idempotent: applied by hand
-- BEFORE the code that uses it deploys; the code already running never reads
-- or writes these tables, and the one new jobs column is nullable.
--
-- Money is integer micro-USD (bigint, 1 USD = 1,000,000) everywhere here.
-- Nothing is a float.
--
--   inference_api_keys      consumer API keys (ik_live_...), sha256 only
--   billing_accounts        one row per user: balance_micro, held_micro
--   billing_ledger          topup / hold / charge / release, one row per
--                           idempotency key (unique), so a replay is a no-op
--   billing_topups          prepaid top-ups through a CoinPay checkout
--   inference_batch_quotes  preflight quotes (15 min), never touch the balance
--   inference_batches       a submitted batch and its hold
--   inference_batch_items   one per request; becomes one job when dispatched
--   jobs.batch_item_id      the job serves a prepaid batch item (no subsidy)
--   provider_earnings kind 'spent_on_compute' (+ transfer_id): node earnings
--                           moved into the compute balance (negative) and the
--                           unused part returned (positive); a trigger on
--                           payout_requests keeps payouts and spends from
--                           ever taking the same money
--
-- Invariants (enforced by the functions below, which lock the account row):
--   balance_micro = sum(topup) + sum(transfer_in) - sum(transfer_out) - sum(charge)
--   held_micro    = sum(hold)  - sum(charge) - sum(release)
--   available     = balance_micro - held_micro >= 0, always
--
-- Every table enables RLS with no policies and is reachable by service_role
-- only, like credit_*.

-- API keys ----------------------------------------------------------------

create table if not exists public.inference_api_keys (
    id           uuid primary key default gen_random_uuid(),
    user_id      text not null,
    user_email   text,
    name         text,
    key_prefix   text not null,
    key_hash     text not null unique,
    created_at   timestamptz not null default now(),
    last_used_at timestamptz,
    revoked_at   timestamptz
);
create index if not exists inference_api_keys_user_idx on public.inference_api_keys (user_id, created_at desc);

-- Balance -----------------------------------------------------------------

create table if not exists public.billing_accounts (
    user_id       text primary key,
    user_email    text,
    balance_micro bigint not null default 0,
    held_micro    bigint not null default 0,
    -- Where a batch hold is funded from, in order. 'earned' = the user's
    -- confirmed node earnings (moved in at submit), 'prepaid' = top-ups,
    -- 'wallet' = pay the shortfall per batch (x402 / checkout).
    funding_order text[] not null default array['earned', 'prepaid', 'wallet'],
    updated_at    timestamptz not null default now(),
    constraint billing_accounts_nonneg check (balance_micro >= 0 and held_micro >= 0),
    constraint billing_accounts_available_nonneg check (held_micro <= balance_micro)
);

create table if not exists public.billing_ledger (
    id           bigserial primary key,
    user_id      text not null,
    kind         text not null check (kind in ('topup', 'hold', 'charge', 'release', 'transfer_in', 'transfer_out')),
    amount_micro bigint not null check (amount_micro >= 0),
    idem_key     text not null unique,
    batch_id     uuid,
    item_id      uuid,
    topup_id     uuid,
    created_at   timestamptz not null default now()
);
create index if not exists billing_ledger_user_idx on public.billing_ledger (user_id, created_at desc);
create index if not exists billing_ledger_charge_idx on public.billing_ledger (created_at) where kind = 'charge';

create table if not exists public.billing_topups (
    id           uuid primary key default gen_random_uuid(),
    user_id      text not null,
    user_email   text,
    amount_usd   numeric(14, 2) not null check (amount_usd > 0),
    amount_micro bigint not null check (amount_micro > 0),
    status       text not null default 'awaiting_payment' check (status in ('awaiting_payment', 'paid', 'failed')),
    source       text not null default 'checkout' check (source in ('checkout', 'x402')),
    payment_ref  text,
    checkout_url text,
    tx_hash      text,
    created_at   timestamptz not null default now(),
    paid_at      timestamptz,
    updated_at   timestamptz not null default now()
);
create index if not exists billing_topups_user_idx on public.billing_topups (user_id, created_at desc);
-- One top-up per CoinPay checkout / x402 nonce: a replayed proof cannot credit twice.
create unique index if not exists billing_topups_ref_key on public.billing_topups (payment_ref) where payment_ref is not null;

-- Batches -----------------------------------------------------------------

create table if not exists public.inference_batch_quotes (
    id              uuid primary key default gen_random_uuid(),
    user_id         text not null,
    model           text not null,
    items           jsonb not null,
    item_count      integer not null,
    total_max_micro bigint not null,
    pricing         jsonb not null,
    expires_at      timestamptz not null,
    used_batch_id   uuid,
    created_at      timestamptz not null default now()
);
create index if not exists inference_batch_quotes_user_idx on public.inference_batch_quotes (user_id, created_at desc);

create table if not exists public.inference_batches (
    id                    uuid primary key default gen_random_uuid(),
    user_id               text not null,
    user_email            text,
    idempotency_key       text not null,
    quote_id              uuid,
    model                 text not null,
    status                text not null default 'running' check (status in ('running', 'completed', 'cancelled')),
    item_count            integer not null,
    max_cost_micro        bigint not null,
    hold_micro            bigint not null,
    charged_micro         bigint not null default 0,
    released_micro        bigint not null default 0,
    funding               text[] not null default array['earned', 'prepaid', 'wallet'],
    funded_earned_micro   bigint not null default 0,
    funded_wallet_micro   bigint not null default 0,
    returned_earned_micro bigint not null default 0,
    input_micro_per_m     bigint not null,
    output_micro_per_m    bigint not null,
    house_fee_pct         numeric(6, 3) not null,
    max_in_flight         integer not null default 8,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    cancelled_at          timestamptz,
    completed_at          timestamptz,
    unique (user_id, idempotency_key)
);
create index if not exists inference_batches_running_idx on public.inference_batches (created_at) where status = 'running';
create index if not exists inference_batches_user_idx on public.inference_batches (user_id, created_at desc);

create table if not exists public.inference_batch_items (
    id             uuid primary key default gen_random_uuid(),
    batch_id       uuid not null references public.inference_batches(id) on delete restrict,
    idx            integer not null,
    custom_id      text not null,
    input          jsonb not null,
    max_tokens     integer not null,
    input_tokens   integer not null,
    max_cost_micro bigint not null check (max_cost_micro >= 0),
    status         text not null default 'queued' check (status in ('queued', 'dispatched', 'completed', 'failed', 'cancelled')),
    attempts       integer not null default 0,
    job_id         uuid,
    output_tokens  integer,
    cost_micro     bigint,
    error          text,
    dispatched_at  timestamptz,
    settled_at     timestamptz,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    unique (batch_id, idx),
    unique (batch_id, custom_id)
);
create index if not exists inference_batch_items_open_idx on public.inference_batch_items (batch_id, status) where settled_at is null;
create index if not exists inference_batch_items_job_idx on public.inference_batch_items (job_id) where job_id is not null;
create index if not exists inference_batch_items_settled_idx on public.inference_batch_items (settled_at) where cost_micro > 0;

alter table public.jobs
    add column if not exists batch_item_id uuid references public.inference_batch_items(id) on delete set null;
create index if not exists jobs_batch_item_id_idx on public.jobs (batch_item_id) where batch_item_id is not null;

-- Earned balance -> compute ---------------------------------------------
-- A node operator can spend confirmed earnings on compute. The spend is a
-- provider_earnings row of kind 'spent_on_compute' with a NEGATIVE amount
-- (status confirmed, no job, transfer_id = the batch), so every existing
-- balance computation (summariseBalance: available = confirmed - open/sent
-- payouts, the payout check, dashboard, CLI) sees it without a code change.
-- Unused earned funds go back at batch end as a positive row of the same kind.

alter table public.provider_earnings
    add column if not exists transfer_id uuid;

alter table public.provider_earnings drop constraint if exists provider_earnings_kind_check;
alter table public.provider_earnings
    add constraint provider_earnings_kind_check check (kind in ('paid', 'subsidy', 'reservation', 'spent_on_compute'));

alter table public.provider_earnings drop constraint if exists provider_earnings_target_shape;
alter table public.provider_earnings
    add constraint provider_earnings_target_shape check (
        (kind = 'reservation' and reservation_id is not null)
        or (kind = 'spent_on_compute' and transfer_id is not null and job_id is null)
        or (kind not in ('reservation', 'spent_on_compute') and job_id is not null)
    );

-- One debit and at most one return per (transfer, provider).
create unique index if not exists provider_earnings_transfer_key
    on public.provider_earnings (transfer_id, provider_id, (amount_usd < 0)) where kind = 'spent_on_compute';

-- Confirmed earnings less open and sent payouts, per provider (8 decimals).
create or replace function public.provider_available_usd(p_provider_id uuid)
returns numeric
language sql stable
as $$
    select coalesce((select sum(amount_usd) from public.provider_earnings
                      where provider_id = p_provider_id and status = 'confirmed'), 0)
         - coalesce((select sum(amount_usd) from public.payout_requests
                      where provider_id = p_provider_id and status in ('requested', 'approved', 'sending', 'sent')), 0);
$$;

-- A payout request can never take money already moved to compute (or
-- vice versa): it locks the provider row, the same lock a spend takes, and
-- is refused above what is available. Old code paths get the check too.
create or replace function public.payout_requests_guard()
returns trigger
language plpgsql
as $$
declare avail numeric;
begin
    if new.status not in ('requested', 'approved', 'sending', 'sent') then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.amount_usd <= old.amount_usd then
        return new;
    end if;
    perform 1 from public.providers where id = new.provider_id for update;
    avail := public.provider_available_usd(new.provider_id)
           + case when tg_op = 'UPDATE' and old.status in ('requested', 'approved', 'sending', 'sent') then old.amount_usd else 0 end;
    if new.amount_usd > avail then
        raise exception 'insufficient_earnings: payout % is more than the available %', new.amount_usd, greatest(avail, 0)
            using errcode = 'check_violation';
    end if;
    return new;
end $$;

drop trigger if exists payout_requests_guard on public.payout_requests;
create trigger payout_requests_guard
    before insert or update of amount_usd, status on public.payout_requests
    for each row execute function public.payout_requests_guard();

-- What the user's nodes can spend now, per provider, in whole micro-USD
-- (rounded down). Providers are the user's through pubkey_links (role
-- provider); disabled providers cannot spend. With p_lock the provider rows
-- are locked (in id order) so a concurrent payout request waits.
create or replace function public.billing_earned_spendable(p_user_id text, p_lock boolean default false)
returns table (provider_id uuid, spendable_micro bigint)
language plpgsql
as $$
declare ids uuid[];
begin
    select coalesce(array_agg(p.id order by p.id), '{}') into ids
      from public.providers p
      join public.pubkey_links l on l.pubkey = p.public_key and l.role = 'provider'
     where l.user_id::text = p_user_id and p.disabled_at is null;
    if p_lock and array_length(ids, 1) > 0 then
        perform 1 from public.providers where id = any(ids) order by id for update;
    end if;
    return query
    select x.id, greatest(floor(public.provider_available_usd(x.id) * 1000000), 0)::bigint
      from unnest(ids) as x(id) order by x.id;
end $$;

-- Read-only funding preview for the API (no locks, no writes).
create or replace function public.billing_funding_preview(p_user_id text)
returns jsonb
language sql stable
as $$
    select jsonb_build_object(
        'prepaid_available_micro', coalesce((select balance_micro - held_micro from public.billing_accounts where user_id = p_user_id), 0),
        'balance_micro', coalesce((select balance_micro from public.billing_accounts where user_id = p_user_id), 0),
        'held_micro', coalesce((select held_micro from public.billing_accounts where user_id = p_user_id), 0),
        'earned_spendable_micro', coalesce((select sum(spendable_micro) from public.billing_earned_spendable(p_user_id, false)), 0),
        'funding_order', coalesce((select to_jsonb(funding_order) from public.billing_accounts where user_id = p_user_id),
                                  '["earned","prepaid","wallet"]'::jsonb));
$$;

-- RLS + grants ------------------------------------------------------------

do $$
declare t text;
begin
    foreach t in array array['inference_api_keys', 'billing_accounts', 'billing_ledger', 'billing_topups',
                             'inference_batch_quotes', 'inference_batches', 'inference_batch_items'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on table public.%I from anon, authenticated', t);
        execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    end loop;
end $$;
grant usage, select on sequence public.billing_ledger_id_seq to service_role;

-- Functions ---------------------------------------------------------------

-- Credit a verified top-up, exactly once. The status flip off
-- awaiting_payment is the lock (webhook and poll can race); the ledger's
-- unique idem_key backs it up. Callers verify with CoinPay first.
create or replace function public.billing_credit_topup(p_topup_id uuid, p_tx_hash text default null)
returns jsonb
language plpgsql
as $$
declare
    t public.billing_topups;
begin
    update public.billing_topups
       set status = 'paid', paid_at = now(), updated_at = now(),
           tx_hash = coalesce(left(p_tx_hash, 200), tx_hash)
     where id = p_topup_id and status = 'awaiting_payment'
    returning * into t;
    if not found then
        return jsonb_build_object('credited', false);
    end if;
    insert into public.billing_accounts (user_id, user_email) values (t.user_id, t.user_email)
        on conflict (user_id) do nothing;
    perform 1 from public.billing_accounts where user_id = t.user_id for update;
    insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, topup_id)
        values (t.user_id, 'topup', t.amount_micro, 'topup:' || t.id, t.id)
        on conflict (idem_key) do nothing;
    if found then
        update public.billing_accounts
           set balance_micro = balance_micro + t.amount_micro, updated_at = now()
         where user_id = t.user_id;
    end if;
    return jsonb_build_object('credited', true, 'amount_micro', t.amount_micro);
end $$;

-- Submit a batch: idempotency check, funding, the batch, its items and one
-- hold for the total max cost, all under the account row lock (and the
-- provider row locks when earnings fund it), so concurrent submits and
-- payout requests are serialised and nothing can be overdrawn.
--   p_batch: { model, quote_id?, max_cost_micro, input_micro_per_m,
--              output_micro_per_m, house_fee_pct, max_in_flight, user_email?,
--              funding: ["earned","prepaid",...], wallet_micro? }
--   p_items: [{ idx, custom_id, input, max_tokens, input_tokens, max_cost_micro }]
-- Funding: the hold is covered from the sources in order. 'earned' moves up
-- to the needed amount of the user's spendable node earnings into the
-- compute balance (transfer_in, and one negative provider_earnings row per
-- provider); 'prepaid' uses the balance; 'wallet' uses only what this
-- request's own wallet payment added (p_batch.wallet_micro, credited as a
-- top-up by the API just before).
-- Returns { ok, batch_id, existing, hold_micro, earned_micro } or
-- { ok: false, reason, prepaid_available_micro, earned_spendable_micro, shortfall_micro, needed_micro }.
create or replace function public.inference_submit_batch(p_user_id text, p_idem text, p_batch jsonb, p_items jsonb)
returns jsonb
language plpgsql
as $$
declare
    acct       public.billing_accounts;
    existing   uuid;
    total      bigint;
    n          integer;
    new_id     uuid := gen_random_uuid();
    sources    text[];
    src        text;
    need       bigint;
    prepaid    bigint;
    earned     bigint := 0;
    earned_take bigint := 0;
    take       bigint;
    pr         record;
    wallet     bigint := greatest(coalesce((p_batch->>'wallet_micro')::bigint, 0), 0);
begin
    insert into public.billing_accounts (user_id, user_email) values (p_user_id, p_batch->>'user_email')
        on conflict (user_id) do nothing;
    select * into acct from public.billing_accounts where user_id = p_user_id for update;

    select id into existing from public.inference_batches where user_id = p_user_id and idempotency_key = p_idem;
    if existing is not null then
        return jsonb_build_object('ok', true, 'batch_id', existing, 'existing', true);
    end if;

    select coalesce(sum((i->>'max_cost_micro')::bigint), 0), count(*) into total, n
      from jsonb_array_elements(p_items) i;
    if n = 0 then
        return jsonb_build_object('ok', false, 'reason', 'no_items');
    end if;
    if total > (p_batch->>'max_cost_micro')::bigint then
        return jsonb_build_object('ok', false, 'reason', 'over_max_cost', 'needed_micro', total);
    end if;

    if jsonb_typeof(p_batch->'funding') = 'array' then
        select array_agg(x) into sources from jsonb_array_elements_text(p_batch->'funding') x;
    end if;
    sources := coalesce(sources, acct.funding_order);
    if 'earned' = any(sources) then
        select coalesce(sum(spendable_micro), 0) into earned from public.billing_earned_spendable(p_user_id, true);
    end if;
    prepaid := acct.balance_micro - acct.held_micro;

    need := total;
    foreach src in array sources loop
        exit when need <= 0;
        if src = 'earned' then
            take := least(need, earned);
            earned_take := earned_take + take;
            need := need - take;
        elsif src = 'prepaid' then
            -- the balance less what this request's wallet payment just added
            take := least(need, greatest(prepaid - least(wallet, prepaid), 0));
            need := need - take;
        elsif src = 'wallet' then
            take := least(need, wallet, prepaid);
            need := need - take;
        end if;
    end loop;
    if need > 0 then
        return jsonb_build_object('ok', false, 'reason', 'insufficient_balance',
            'prepaid_available_micro', prepaid, 'earned_spendable_micro', earned,
            'available_micro', prepaid + case when 'earned' = any(sources) then earned else 0 end,
            'shortfall_micro', need, 'needed_micro', total);
    end if;

    insert into public.inference_batches (id, user_id, user_email, idempotency_key, quote_id, model, item_count,
            max_cost_micro, hold_micro, input_micro_per_m, output_micro_per_m, house_fee_pct, max_in_flight,
            funding, funded_earned_micro, funded_wallet_micro)
    values (new_id, p_user_id, p_batch->>'user_email', p_idem, nullif(p_batch->>'quote_id', '')::uuid, p_batch->>'model', n,
            (p_batch->>'max_cost_micro')::bigint, total, (p_batch->>'input_micro_per_m')::bigint,
            (p_batch->>'output_micro_per_m')::bigint, (p_batch->>'house_fee_pct')::numeric,
            coalesce((p_batch->>'max_in_flight')::integer, 8), sources, earned_take,
            least(wallet, total - earned_take));

    insert into public.inference_batch_items (batch_id, idx, custom_id, input, max_tokens, input_tokens, max_cost_micro)
    select new_id, (i->>'idx')::integer, i->>'custom_id', i->'input', (i->>'max_tokens')::integer,
           (i->>'input_tokens')::integer, (i->>'max_cost_micro')::bigint
      from jsonb_array_elements(p_items) i;

    -- Move earnings in: debit providers in id order, then credit the balance.
    if earned_take > 0 then
        need := earned_take;
        for pr in select * from public.billing_earned_spendable(p_user_id, false) loop
            exit when need <= 0;
            take := least(need, pr.spendable_micro);
            continue when take <= 0;
            insert into public.provider_earnings (job_id, transfer_id, provider_id, kind, role, share, output_tokens,
                    gross_usd, fee_usd, amount_usd, status, confirmed_at, metadata)
            values (null, new_id, pr.provider_id, 'spent_on_compute', 'single', 1, 0,
                    -(take::numeric / 1000000), 0, -(take::numeric / 1000000), 'confirmed', now(),
                    jsonb_build_object('source', 'batch_funding', 'batch_id', new_id, 'user_id', p_user_id, 'micro', take));
            need := need - take;
        end loop;
        if need > 0 then
            raise exception 'earned funding changed under lock (short by %)', need;
        end if;
        insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, batch_id)
            values (p_user_id, 'transfer_in', earned_take, 'batch:' || new_id || ':earned_in', new_id);
        update public.billing_accounts set balance_micro = balance_micro + earned_take where user_id = p_user_id;
    end if;

    insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, batch_id)
        values (p_user_id, 'hold', total, 'batch:' || new_id || ':hold', new_id);
    update public.billing_accounts set held_micro = held_micro + total, updated_at = now()
     where user_id = p_user_id;

    if nullif(p_batch->>'quote_id', '') is not null then
        update public.inference_batch_quotes set used_batch_id = new_id
         where id = (p_batch->>'quote_id')::uuid and used_batch_id is null;
    end if;

    return jsonb_build_object('ok', true, 'batch_id', new_id, 'existing', false, 'hold_micro', total,
                              'earned_micro', earned_take, 'funding', to_jsonb(sources));
end $$;

-- Claim up to (max_in_flight - dispatched) queued items of a running batch for
-- dispatch. The batch row lock makes the in-flight bound exact.
create or replace function public.inference_claim_items(p_batch_id uuid)
returns setof public.inference_batch_items
language plpgsql
as $$
declare
    b        public.inference_batches;
    inflight integer;
begin
    select * into b from public.inference_batches where id = p_batch_id for update;
    if not found or b.status <> 'running' or b.cancelled_at is not null then
        return;
    end if;
    select count(*) into inflight from public.inference_batch_items
     where batch_id = p_batch_id and status = 'dispatched';
    if inflight >= b.max_in_flight then
        return;
    end if;
    return query
    update public.inference_batch_items it
       set status = 'dispatched', dispatched_at = now(), attempts = it.attempts + 1, updated_at = now()
     where it.id in (
            select id from public.inference_batch_items
             where batch_id = p_batch_id and status = 'queued'
             order by idx
             limit (b.max_in_flight - inflight)
             for update skip locked)
    returning it.*;
end $$;

-- Settle one item, exactly once: charge min(cost, the item's max) when it
-- completed (0 otherwise), release the rest of its hold. p_status:
--   'completed' | 'failed'  only from 'dispatched' (or 'queued' for failed)
--   'cancelled'             only from 'queued' (a running item settles normally)
--   'requeue'               back to 'queued' (no provider was free), no money moves
-- When the batch has no open item left it is finished (completed or
-- cancelled) and any leftover hold is released.
create or replace function public.inference_settle_item(
    p_item_id uuid, p_status text, p_output_tokens integer default null,
    p_cost_micro bigint default 0, p_error text default null, p_job_id uuid default null)
returns jsonb
language plpgsql
as $$
declare
    it       public.inference_batch_items;
    b        public.inference_batches;
    charge   bigint := 0;
    rel      bigint := 0;
    open_n   integer;
    leftover bigint;
    done     boolean := false;
begin
    if p_status not in ('completed', 'failed', 'cancelled', 'requeue') then
        raise exception 'bad status %', p_status;
    end if;
    -- Lock order everywhere: batch row, then account, then item.
    select b2.* into b from public.inference_batches b2
      join public.inference_batch_items i2 on i2.batch_id = b2.id
     where i2.id = p_item_id for update of b2;
    if not found then
        return jsonb_build_object('settled', false, 'reason', 'not_found');
    end if;
    perform 1 from public.billing_accounts where user_id = b.user_id for update;
    select * into it from public.inference_batch_items where id = p_item_id for update;

    if it.settled_at is not null then
        return jsonb_build_object('settled', false, 'reason', 'already', 'status', it.status, 'cost_micro', it.cost_micro);
    end if;
    if p_job_id is not null and it.job_id is distinct from p_job_id then
        return jsonb_build_object('settled', false, 'reason', 'stale_job');
    end if;
    if p_status = 'requeue' then
        if it.status <> 'dispatched' then
            return jsonb_build_object('settled', false, 'reason', 'not_dispatched');
        end if;
        update public.inference_batch_items
           set status = 'queued', job_id = null, error = left(p_error, 500), updated_at = now()
         where id = p_item_id;
        return jsonb_build_object('settled', false, 'requeued', true);
    end if;
    if p_status = 'cancelled' and it.status <> 'queued' then
        return jsonb_build_object('settled', false, 'reason', 'not_queued');
    end if;
    if p_status = 'completed' and it.status <> 'dispatched' then
        return jsonb_build_object('settled', false, 'reason', 'not_dispatched');
    end if;

    if p_status = 'completed' then
        charge := least(greatest(coalesce(p_cost_micro, 0), 0), it.max_cost_micro);
    end if;
    rel := it.max_cost_micro - charge;

    if charge > 0 then
        insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, batch_id, item_id)
            values (b.user_id, 'charge', charge, 'item:' || it.id || ':charge', b.id, it.id);
    end if;
    if rel > 0 then
        insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, batch_id, item_id)
            values (b.user_id, 'release', rel, 'item:' || it.id || ':release', b.id, it.id);
    end if;
    update public.billing_accounts
       set balance_micro = balance_micro - charge,
           held_micro = held_micro - it.max_cost_micro,
           updated_at = now()
     where user_id = b.user_id;

    update public.inference_batch_items
       set status = p_status, cost_micro = charge,
           output_tokens = case when p_status = 'completed' then greatest(coalesce(p_output_tokens, 0), 0) else 0 end,
           error = left(p_error, 500), settled_at = now(), updated_at = now()
     where id = p_item_id;

    update public.inference_batches
       set charged_micro = charged_micro + charge, released_micro = released_micro + rel, updated_at = now()
     where id = b.id
    returning * into b;

    select count(*) into open_n from public.inference_batch_items where batch_id = b.id and settled_at is null;
    if open_n = 0 and b.status = 'running' then
        leftover := b.hold_micro - b.charged_micro - b.released_micro;
        if leftover > 0 then
            insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, batch_id)
                values (b.user_id, 'release', leftover, 'batch:' || b.id || ':final_release', b.id)
                on conflict (idem_key) do nothing;
            if found then
                update public.billing_accounts set held_micro = held_micro - leftover, updated_at = now()
                 where user_id = b.user_id;
                update public.inference_batches set released_micro = released_micro + leftover where id = b.id;
            end if;
        end if;
        select * into b from public.inference_batches where id = b.id;
        perform public.billing_return_earned(b.id);
        update public.inference_batches
           set status = case when cancelled_at is not null then 'cancelled' else 'completed' end,
               completed_at = now(), updated_at = now()
         where id = b.id;
        done := true;
    end if;

    return jsonb_build_object('settled', true, 'status', p_status, 'charged_micro', charge,
                              'released_micro', rel, 'batch_done', done);
end $$;

-- Batch end: earned funds the batch did not spend go back to the node
-- earnings they came from (charges use the earned part first), as far as the
-- compute balance is not already held by another batch. Called with the
-- batch and account rows locked (from inference_settle_item). Idempotent.
create or replace function public.billing_return_earned(p_batch_id uuid)
returns bigint
language plpgsql
as $$
declare
    b    public.inference_batches;
    a    public.billing_accounts;
    ret  bigint;
    left_ bigint;
    take bigint;
    d    record;
begin
    select * into b from public.inference_batches where id = p_batch_id;
    if b.funded_earned_micro <= 0 or b.returned_earned_micro > 0 then
        return 0;
    end if;
    select * into a from public.billing_accounts where user_id = b.user_id;
    ret := least(b.funded_earned_micro - least(b.charged_micro, b.funded_earned_micro), a.balance_micro - a.held_micro);
    if ret <= 0 then
        return 0;
    end if;
    -- Lock the providers the debits came from, like a payout would.
    perform 1 from public.providers where id in (
        select provider_id from public.provider_earnings
         where transfer_id = p_batch_id and kind = 'spent_on_compute' and amount_usd < 0) order by id for update;
    insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, batch_id)
        values (b.user_id, 'transfer_out', ret, 'batch:' || b.id || ':earned_return', b.id)
        on conflict (idem_key) do nothing;
    if not found then
        return 0;
    end if;
    left_ := ret;
    for d in select provider_id, (-(amount_usd) * 1000000)::bigint as micro from public.provider_earnings
              where transfer_id = p_batch_id and kind = 'spent_on_compute' and amount_usd < 0 order by provider_id desc loop
        exit when left_ <= 0;
        take := least(left_, d.micro);
        insert into public.provider_earnings (job_id, transfer_id, provider_id, kind, role, share, output_tokens,
                gross_usd, fee_usd, amount_usd, status, confirmed_at, metadata)
        values (null, p_batch_id, d.provider_id, 'spent_on_compute', 'single', 1, 0,
                take::numeric / 1000000, 0, take::numeric / 1000000, 'confirmed', now(),
                jsonb_build_object('source', 'batch_unused_return', 'batch_id', p_batch_id, 'micro', take));
        left_ := left_ - take;
    end loop;
    update public.billing_accounts set balance_micro = balance_micro - ret, updated_at = now() where user_id = b.user_id;
    update public.inference_batches set returned_earned_micro = ret where id = b.id;
    return ret;
end $$;

-- Cancel: stop dispatching and release every queued item's hold. Items
-- already dispatched run to completion and settle normally.
create or replace function public.inference_cancel_batch(p_batch_id uuid, p_user_id text)
returns jsonb
language plpgsql
as $$
declare
    b   public.inference_batches;
    r   record;
    n   integer := 0;
begin
    update public.inference_batches
       set cancelled_at = coalesce(cancelled_at, now()), updated_at = now()
     where id = p_batch_id and user_id = p_user_id
    returning * into b;
    if not found then
        return jsonb_build_object('ok', false, 'reason', 'not_found');
    end if;
    for r in select id from public.inference_batch_items
              where batch_id = p_batch_id and status = 'queued' and settled_at is null order by idx loop
        perform public.inference_settle_item(r.id, 'cancelled', 0, 0, 'cancelled by the customer');
        n := n + 1;
    end loop;
    return jsonb_build_object('ok', true, 'cancelled_items', n);
end $$;

do $$
declare f text;
begin
    foreach f in array array[
        'public.billing_credit_topup(uuid, text)',
        'public.inference_submit_batch(text, text, jsonb, jsonb)',
        'public.inference_claim_items(uuid)',
        'public.inference_settle_item(uuid, text, integer, bigint, text, uuid)',
        'public.inference_cancel_batch(uuid, text)',
        'public.billing_return_earned(uuid)',
        'public.billing_earned_spendable(text, boolean)',
        'public.billing_funding_preview(text)',
        'public.provider_available_usd(uuid)',
        'public.payout_requests_guard()'] loop
        execute format('revoke all on function %s from public, anon, authenticated', f);
        execute format('grant execute on function %s to service_role', f);
    end loop;
end $$;

notify pgrst, 'reload schema';
