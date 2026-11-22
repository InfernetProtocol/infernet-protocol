-- Usage charges: bill a balance for metered, non-inference work.
--
-- c0mpute Live (p2p live streaming) meters relay bytes per node; the streamer
-- pays per GB from the same compute balance chat is charged to, and the node
-- that relayed is credited like a node that served a chat (a 'paid'
-- provider_earnings row, so the platform_fee and referral triggers, payouts
-- and every earnings view apply unchanged). POST /api/v1/billing/usage-charge.
--
-- The one thing the existing charge cannot do is refuse. An interactive
-- request is charged after it ran, so billing_charge_interactive caps the
-- charge at whatever the balance holds and the house absorbs the rest. A
-- usage charge is an amount the caller states up front and pays a node 95% of,
-- so a partial charge would either short the node or have the house pay it.
-- It is all or nothing instead:
--
--   billing_charge_exact  charge exactly p_cost_micro, or charge nothing and
--                         say 'insufficient_balance'
--
-- It adds no ledger of its own: it takes the same account lock, checks the
-- balance (plus confirmed node earnings when p_allow_earned), and then calls
-- billing_charge_interactive, which writes the same 'charge' row under the
-- same unique idem key and pulls earnings the same way.
--
-- Idempotent on p_idem: a repeat returns reason 'already_charged' with the
-- amount and account of the original charge, and moves nothing.
--
-- Returns jsonb: { charged, reason, charged_micro, spendable_micro, user_id,
--                  balance_micro, available_micro, earned_pulled_micro }
-- spendable_micro is what the account can spend after this call: balance not
-- held by a batch, plus confirmed node earnings when p_allow_earned.
--
-- Safe to re-run.

create or replace function public.billing_charge_exact(
    p_user_id text, p_idem text, p_cost_micro bigint,
    p_allow_earned boolean default true, p_job_id uuid default null)
returns jsonb
language plpgsql
as $$
declare
    cost     bigint := greatest(coalesce(p_cost_micro, 0), 0);
    allowed  boolean := coalesce(p_allow_earned, true);
    acct     public.billing_accounts;
    prior    public.billing_ledger;
    avail    bigint := 0;
    earned   bigint := 0;
    result   jsonb;
begin
    if p_idem is null or length(p_idem) = 0 then
        raise exception 'idem key is required';
    end if;
    if p_user_id is null or length(p_user_id) = 0 then
        raise exception 'user id is required';
    end if;
    if cost = 0 then
        return jsonb_build_object('charged', false, 'charged_micro', 0, 'reason', 'nothing_to_charge');
    end if;

    -- The account lock serialises two calls for the same person, so a retry
    -- racing its original waits here and then finds the ledger row below.
    insert into public.billing_accounts (user_id) values (p_user_id) on conflict (user_id) do nothing;
    select * into acct from public.billing_accounts where user_id = p_user_id for update;
    avail := greatest(acct.balance_micro - acct.held_micro, 0);

    select * into prior from public.billing_ledger where idem_key = p_idem;
    if found then
        if allowed then
            select coalesce(sum(spendable_micro), 0) into earned
              from public.billing_earned_spendable(p_user_id, false);
        end if;
        return jsonb_build_object(
            'charged', false,
            'reason', 'already_charged',
            'charged_micro', prior.amount_micro,
            'user_id', prior.user_id,
            'spendable_micro', avail + earned);
    end if;

    -- Lock the provider rows only when earnings are needed: the same lock a
    -- payout request takes, so the same dollars cannot also be withdrawn.
    if allowed then
        select coalesce(sum(spendable_micro), 0) into earned
          from public.billing_earned_spendable(p_user_id, avail < cost);
    end if;

    if avail + earned < cost then
        return jsonb_build_object(
            'charged', false,
            'reason', 'insufficient_balance',
            'charged_micro', 0,
            'user_id', p_user_id,
            'spendable_micro', avail + earned);
    end if;

    result := public.billing_charge_interactive(p_user_id, p_idem, cost, allowed, p_job_id);

    -- All or nothing. The check above makes a short charge impossible while
    -- the locks are held; if it ever happens anyway, raising undoes it.
    if coalesce((result->>'charged_micro')::bigint, 0) <> cost then
        raise exception 'usage charge % was not charged in full (% of %)',
            p_idem, coalesce(result->>'charged_micro', '0'), cost;
    end if;

    earned := 0;
    if allowed then
        select coalesce(sum(spendable_micro), 0) into earned
          from public.billing_earned_spendable(p_user_id, false);
    end if;
    return result || jsonb_build_object(
        'user_id', p_user_id,
        'spendable_micro', coalesce((result->>'available_micro')::bigint, 0) + earned);
end $$;

revoke all on function public.billing_charge_exact(text, text, bigint, boolean, uuid) from public, anon, authenticated;
grant execute on function public.billing_charge_exact(text, text, bigint, boolean, uuid) to service_role;

notify pgrst, 'reload schema';
