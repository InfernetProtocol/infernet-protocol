-- Pay-as-you-go for interactive inference.
--
-- 20261102020000_paid_batch_inference.sql gave the site a real prepaid
-- balance: billing_accounts in integer micro-USD, a top-up rail, per-model
-- prices, and 'earned' as a funding source (confirmed node earnings move into
-- the compute balance as a negative provider_earnings row of
-- kind 'spent_on_compute', which payout_requests_guard then refuses to pay
-- out). All of it was reachable only by submitting a BATCH.
--
-- Interactive inference — the /chat playground, /v1/chat/completions, the CLI,
-- c0mpute.com's chat — stayed free and IP-rate-limited. That is the gap this
-- closes. Two functions, both reusing the ledger and invariants above:
--
--   billing_fund_from_earned  move earnings into the compute balance on their
--                             own, with no batch involved
--   billing_charge_interactive charge one finished request, once
--
-- There is no hold: an interactive request is charged after it has run, from
-- the balance it was authorised against. Tokens are only known afterwards, so
-- a thin balance can be overrun; the charge is capped at the balance and the
-- remainder recorded, which keeps billing_accounts_nonneg true and never
-- leaves a consumer owing money.

-- Move `p_amount_micro` of confirmed node earnings into the compute balance.
-- Extracted from inference_submit_batch so earnings can fund interactive use
-- (and a plain "move my earnings to compute" action) rather than only a batch.
--
-- Locks the provider rows first, which is the same lock a payout request
-- takes, so a concurrent withdrawal of the same dollars waits and then fails
-- its own availability check. Returns the micro actually moved, which may be
-- less than asked when the earnings are not all there.
create or replace function public.billing_pull_earned(
    p_user_id text, p_amount_micro bigint, p_ref uuid, p_source text)
returns bigint
language plpgsql
as $$
declare
    need   bigint := greatest(coalesce(p_amount_micro, 0), 0);
    moved  bigint := 0;
    take   bigint;
    pr     record;
begin
    if need <= 0 then return 0; end if;
    -- Lock in provider-id order (billing_earned_spendable with p_lock).
    perform 1 from public.billing_earned_spendable(p_user_id, true);
    for pr in select * from public.billing_earned_spendable(p_user_id, false) loop
        exit when need <= 0;
        take := least(need, pr.spendable_micro);
        continue when take <= 0;
        insert into public.provider_earnings (job_id, transfer_id, provider_id, kind, role, share, output_tokens,
                gross_usd, fee_usd, amount_usd, status, confirmed_at, metadata)
        values (null, p_ref, pr.provider_id, 'spent_on_compute', 'single', 1, 0,
                -(take::numeric / 1000000), 0, -(take::numeric / 1000000), 'confirmed', now(),
                jsonb_build_object('source', p_source, 'ref', p_ref, 'user_id', p_user_id, 'micro', take));
        moved := moved + take;
        need := need - take;
    end loop;

    if moved > 0 then
        insert into public.billing_accounts (user_id) values (p_user_id)
            on conflict (user_id) do nothing;
        insert into public.billing_ledger (user_id, kind, amount_micro, idem_key)
            values (p_user_id, 'transfer_in', moved, 'earned:' || p_ref || ':in');
        update public.billing_accounts
           set balance_micro = balance_micro + moved, updated_at = now()
         where user_id = p_user_id;
    end if;
    return moved;
end $$;

-- "Move my node earnings into my compute balance." p_amount_micro null or 0
-- means everything confirmed and not already spoken for.
create or replace function public.billing_fund_from_earned(
    p_user_id text, p_amount_micro bigint default null)
returns jsonb
language plpgsql
as $$
declare
    want  bigint;
    moved bigint;
    ref   uuid := gen_random_uuid();
    acct  public.billing_accounts;
begin
    perform 1 from public.billing_accounts where user_id = p_user_id for update;
    select coalesce(sum(spendable_micro), 0) into want
      from public.billing_earned_spendable(p_user_id, false);
    if coalesce(p_amount_micro, 0) > 0 then
        want := least(want, p_amount_micro);
    end if;
    if want <= 0 then
        return jsonb_build_object('moved_micro', 0, 'reason', 'nothing_confirmed');
    end if;

    moved := public.billing_pull_earned(p_user_id, want, ref, 'fund_from_earned');
    select * into acct from public.billing_accounts where user_id = p_user_id;
    return jsonb_build_object(
        'moved_micro', moved,
        'ref', ref,
        'balance_micro', coalesce(acct.balance_micro, 0),
        'available_micro', coalesce(acct.balance_micro - acct.held_micro, 0));
end $$;

-- Charge one finished interactive request.
--
-- Idempotent on p_idem (billing_ledger.idem_key is unique), so a retried
-- completion, or two completion paths racing for the same job, charge once.
--
-- With p_allow_earned the shortfall is pulled from confirmed node earnings
-- first, which is what makes "spend what my nodes earned" work without the
-- user moving money by hand.
--
-- Returns jsonb: { charged, charged_micro, shortfall_micro, balance_micro,
--                  earned_pulled_micro, reason }
create or replace function public.billing_charge_interactive(
    p_user_id text, p_idem text, p_cost_micro bigint,
    p_allow_earned boolean default true, p_job_id uuid default null)
returns jsonb
language plpgsql
as $$
declare
    cost      bigint := greatest(coalesce(p_cost_micro, 0), 0);
    acct      public.billing_accounts;
    avail     bigint := 0;
    pulled    bigint := 0;
    charge    bigint := 0;
    short     bigint := 0;
    ref       uuid := gen_random_uuid();
begin
    if p_idem is null or length(p_idem) = 0 then
        raise exception 'idem key is required';
    end if;
    if cost = 0 then
        return jsonb_build_object('charged', false, 'charged_micro', 0, 'reason', 'nothing_to_charge');
    end if;
    -- Already charged? The unique idem key is the record.
    perform 1 from public.billing_ledger where idem_key = p_idem;
    if found then
        return jsonb_build_object('charged', false, 'reason', 'already_charged');
    end if;

    insert into public.billing_accounts (user_id) values (p_user_id) on conflict (user_id) do nothing;
    select * into acct from public.billing_accounts where user_id = p_user_id for update;
    avail := greatest(acct.balance_micro - acct.held_micro, 0);

    if avail < cost and coalesce(p_allow_earned, true) then
        pulled := public.billing_pull_earned(p_user_id, cost - avail, ref, 'interactive_charge');
        if pulled > 0 then
            select * into acct from public.billing_accounts where user_id = p_user_id;
            avail := greatest(acct.balance_micro - acct.held_micro, 0);
        end if;
    end if;

    -- Cap at what is there. Held funds belong to a batch and are never taken.
    charge := least(cost, avail);
    short := cost - charge;

    if charge > 0 then
        insert into public.billing_ledger (user_id, kind, amount_micro, idem_key, item_id)
            values (p_user_id, 'charge', charge, p_idem, p_job_id);
        update public.billing_accounts
           set balance_micro = balance_micro - charge, updated_at = now()
         where user_id = p_user_id;
        select * into acct from public.billing_accounts where user_id = p_user_id;
    end if;

    return jsonb_build_object(
        'charged', charge > 0,
        'charged_micro', charge,
        'shortfall_micro', short,
        'earned_pulled_micro', pulled,
        'balance_micro', coalesce(acct.balance_micro, 0),
        'available_micro', greatest(coalesce(acct.balance_micro - acct.held_micro, 0), 0));
end $$;

revoke all on function public.billing_pull_earned(text, bigint, uuid, text) from public, anon, authenticated;
revoke all on function public.billing_fund_from_earned(text, bigint) from public, anon, authenticated;
revoke all on function public.billing_charge_interactive(text, text, bigint, boolean, uuid) from public, anon, authenticated;
grant execute on function public.billing_fund_from_earned(text, bigint) to service_role;
grant execute on function public.billing_charge_interactive(text, text, bigint, boolean, uuid) to service_role;

-- Whose balance pays for an interactive job. Stamped at creation when the
-- caller is identified (session, CLI token, ik_live_ key, or a trusted client
-- calling for a named user); null for the anonymous free tier, which bills
-- nobody. Completion charges this account and no other, so an
-- unauthenticated job can never be billed to a stranger.
alter table public.jobs add column if not exists billed_user_id text;
create index if not exists jobs_billed_user_idx on public.jobs (billed_user_id, created_at desc)
  where billed_user_id is not null;
