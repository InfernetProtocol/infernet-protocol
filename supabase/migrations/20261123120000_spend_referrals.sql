-- Spend referrals: referrers also earn on what the PEOPLE they refer spend.
--
-- Anthony, 2026-11-23 ("yes"). The node program (20261122120000) pays a
-- referrer 5% of the house fee on jobs a referred NODE serves. Nothing paid
-- on a referred person's spending. Now it does:
--
--   commission = spend_commission_pct_of_house_fee (default 50) percent of
--                the house fee actually collected on each fee-bearing credit
--                a referred person paid for.
--
-- At today's 5% fee that is 2.5% of what they spend. It is computed from the
-- credit's fee_usd (what the house kept on that job), never from gross, so
-- it can never come out of the operator's 95%, and a job that earned the house
-- nothing (free tier, subsidy, unpriced) earns nothing.
--
-- No double count: every paid surface (Infernet chat/API, c0mpute.com chat
-- and API bridged here, images, usage charges, prepaid batches) settles as
-- exactly one provider_earnings credit per (job, provider), with its own
-- fee. c0mpute's native market jobs collect no fee yet (market settlement has
-- not launched), so there is no second fee to stack. Commissions are keyed
-- (source_earning_id, kind): one node commission and one spend commission at
-- most per credit, and together they are capped at the credit's fee.
--
-- Attribution (referral_user_attributions): first touch, recorded when the
-- referred person's account is created or first signs in (link-trusted from
-- c0mpute.com, or a sign-in here with the referral_code cookie), only while
-- the account is new and has never been charged. Never changed afterwards and
-- never added later by the person. Self-referral (same account, same CoinPay
-- identity, a shared payout wallet) and house accounts are refused.
--
-- Payouts: the same referral_commissions ledger, so referral_available_usd,
-- payout_requests (same minimum, auto-approve cap, CoinPay send) and every
-- view already count it.
--
-- Settings (row 'referrals', added only where missing):
--   spend_enabled                       true
--   spend_commission_pct_of_house_fee   50     (0..100)
--   spend_term_months                   0      (0 = no expiry; else months
--                                               from attribution)
--   house_user_ids                      []     (accounts that never earn)
--
-- Idempotent: safe to re-run.

-- ----------------------------------------------------------- attributions --
create table if not exists public.referral_user_attributions (
    referred_user_id  uuid primary key references auth.users(id) on delete cascade,
    referrer_user_id  uuid not null references auth.users(id) on delete cascade,
    code              text not null,
    via               text not null check (via in ('infernet-signin', 'c0mpute-signin')),
    ip24              text,
    attributed_at     timestamptz not null default now(),
    first_spend_at    timestamptz,
    constraint referral_user_not_self check (referred_user_id <> referrer_user_id)
);
create index if not exists referral_user_attributions_referrer_idx
    on public.referral_user_attributions (referrer_user_id);

alter table public.referral_user_attributions enable row level security;
revoke all on table public.referral_user_attributions from anon, authenticated;

-- ---------------------------------------------------------- commissions ----
alter table public.referral_commissions
    add column if not exists kind text not null default 'node';
alter table public.referral_commissions
    add column if not exists referred_user_id uuid references auth.users(id) on delete set null;
alter table public.referral_commissions drop constraint if exists referral_commissions_kind_check;
alter table public.referral_commissions
    add constraint referral_commissions_kind_check check (kind in ('node', 'spend'));
-- A spend commission has no referred node and no A/B arm.
alter table public.referral_commissions alter column node_key drop not null;
alter table public.referral_commissions alter column arm drop not null;
alter table public.referral_commissions drop constraint if exists referral_commissions_shape;
alter table public.referral_commissions
    add constraint referral_commissions_shape check (
        (kind = 'node' and node_key is not null and arm is not null)
        or (kind = 'spend' and referred_user_id is not null)
    );
-- One commission of each kind per source credit (was: one per credit).
alter table public.referral_commissions drop constraint if exists referral_commissions_source_earning_id_key;
create unique index if not exists referral_commissions_source_kind_key
    on public.referral_commissions (source_earning_id, kind);
create index if not exists referral_commissions_referred_idx
    on public.referral_commissions (referred_user_id) where referred_user_id is not null;

-- --------------------------------------------------------------- config ----
update public.settings
   set value = jsonb_build_object(
                   'spend_enabled', true,
                   'spend_commission_pct_of_house_fee', 50,
                   'spend_term_months', 0,
                   'house_user_ids', '[]'::jsonb) || value
 where key = 'referrals';
insert into public.settings (key, value)
values ('referrals', jsonb_build_object(
    'enabled', true, 'commission_pct_of_house_fee', 5, 'term_months_12m', 12,
    'spend_enabled', true, 'spend_commission_pct_of_house_fee', 50, 'spend_term_months', 0,
    'house_user_ids', '[]'::jsonb))
on conflict (key) do nothing;

-- Is this account one of ours (never earns a commission)?
create or replace function public.referral_is_house_user(p_user_id uuid)
returns boolean
language sql
stable
as $$
    select coalesce(
        (select (public.referral_config()->'house_user_ids') ? p_user_id::text
           where jsonb_typeof(public.referral_config()->'house_user_ids') = 'array'),
        false)
$$;

-- Who paid for a credit: the billed person on interactive / usage / image
-- credits, the batch owner on prepaid batches, else the job's billed user.
-- Reservation orders are bought without an account, so they have no payer.
create or replace function public.referral_payer_user_id(e public.provider_earnings)
returns uuid
language plpgsql
stable
as $$
declare
    raw text;
    uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
begin
    raw := e.metadata->>'billed_user_id';
    if raw is null and e.metadata ? 'batch_id' and (e.metadata->>'batch_id') ~* uuid_re then
        select b.user_id into raw from public.inference_batches b where b.id = (e.metadata->>'batch_id')::uuid;
    end if;
    if raw is null and e.job_id is not null then
        select j.billed_user_id into raw from public.jobs j where j.id = e.job_id;
    end if;
    if raw is null or raw !~* uuid_re then return null; end if;
    return raw::uuid;
end $$;

-- ------------------------------------------------- node accrual (rekeyed) --
-- Unchanged rules; only the lookup and the conflict target name kind 'node'
-- now that a credit can carry a spend commission too.
create or replace function public.post_referral_commission(e public.provider_earnings)
returns void
language plpgsql
as $$
declare
    cfg        jsonb;
    pct        numeric;
    term       integer;
    a          public.referral_attributions;
    existing   public.referral_commissions;
    v_node_key text;
    v_pubkey   text;
    owner_id   uuid;
    payer      text;
    payout     text;
    first_at   timestamptz;
    fee        numeric := coalesce(e.fee_usd, 0);
begin
    if e.kind not in ('paid', 'reservation') then return; end if;

    select * into existing from public.referral_commissions where source_earning_id = e.id and kind = 'node';
    if found then
        update public.referral_commissions
           set status = case when fee <= 0 then 'void' else e.status end,
               fee_usd = greatest(fee, 0),
               amount_usd = case when fee <= 0 then 0
                                 else least(round(fee * commission_pct / 100, 8), fee) end,
               confirmed_at = e.confirmed_at
         where id = existing.id
           and (status is distinct from (case when fee <= 0 then 'void' else e.status end)
                or fee_usd is distinct from greatest(fee, 0)
                or confirmed_at is distinct from e.confirmed_at);
        return;
    end if;

    if fee <= 0 or e.status = 'void' then return; end if;

    cfg := public.referral_config();
    if coalesce((cfg->>'enabled')::boolean, true) is not true then return; end if;
    pct := coalesce(nullif(cfg->>'commission_pct_of_house_fee', '')::numeric, 5);
    if pct is null or pct <= 0 then return; end if;
    pct := least(pct, 100);
    term := coalesce(nullif(cfg->>'term_months_12m', '')::integer, 12);

    select p.node_id, p.public_key into v_node_key, v_pubkey from public.providers p where p.id = e.provider_id;
    if v_node_key is null then return; end if;
    select * into a from public.referral_attributions where referral_attributions.node_key = v_node_key for update;
    if not found then return; end if;
    if e.earned_at < a.attributed_at then return; end if;

    first_at := coalesce(a.first_settled_at, e.earned_at);
    if a.first_settled_at is null or e.earned_at < a.first_settled_at then
        update public.referral_attributions
           set first_settled_at = least(coalesce(first_settled_at, e.earned_at), e.earned_at),
               provider_id = coalesce(provider_id, e.provider_id)
         where referral_attributions.node_key = a.node_key;
        first_at := least(first_at, e.earned_at);
    end if;

    if v_pubkey is not null then
        select l.user_id into owner_id from public.pubkey_links l
         where l.pubkey = v_pubkey and l.role = 'provider' limit 1;
        if owner_id = a.referrer_user_id then return; end if;
    end if;
    if a.node_owner_user_id = a.referrer_user_id then return; end if;
    payer := e.metadata->>'billed_user_id';
    if payer is not null and (payer = a.referrer_user_id::text
                              or payer = coalesce(owner_id, a.node_owner_user_id)::text) then
        return;
    end if;
    select lower(c.payout_address) into payout from public.referral_codes c where c.user_id = a.referrer_user_id;
    if payout is not null and exists (select 1 from public.provider_payouts pp
                                       where pp.provider_id = e.provider_id and lower(pp.address) = payout) then
        return;
    end if;

    if a.arm = '12m' and e.earned_at >= first_at + make_interval(months => term) then return; end if;

    insert into public.referral_commissions (kind, source_earning_id, referrer_user_id, node_key, provider_id,
            job_id, reservation_id, arm, fee_usd, commission_pct, amount_usd, status, earned_at, confirmed_at)
    values ('node', e.id, a.referrer_user_id, a.node_key, e.provider_id, e.job_id, e.reservation_id, a.arm,
            fee, pct, least(round(fee * pct / 100, 8), fee), e.status, e.earned_at, e.confirmed_at)
    on conflict (source_earning_id, kind) do nothing;
end $$;

-- ---------------------------------------------------------- spend accrual --
-- Post (or bring up to date) the spend commission for one credit.
create or replace function public.post_spend_referral_commission(e public.provider_earnings)
returns void
language plpgsql
as $$
declare
    cfg       jsonb;
    pct       numeric;
    months    integer;
    payer     uuid;
    a         public.referral_user_attributions;
    existing  public.referral_commissions;
    other     numeric;
    amount    numeric;
    r_wallet  text;
    fee       numeric := coalesce(e.fee_usd, 0);
begin
    if e.kind not in ('paid', 'reservation') then return; end if;

    -- Never more than the house collected, counting the node commission.
    select coalesce(sum(amount_usd), 0) into other
      from public.referral_commissions
     where source_earning_id = e.id and kind <> 'spend' and status <> 'void';

    select * into existing from public.referral_commissions where source_earning_id = e.id and kind = 'spend';
    if found then
        amount := case when fee <= 0 then 0
                       else greatest(least(round(fee * existing.commission_pct / 100, 8), fee - other), 0) end;
        update public.referral_commissions
           set status = case when fee <= 0 then 'void' else e.status end,
               fee_usd = greatest(fee, 0),
               amount_usd = amount,
               confirmed_at = e.confirmed_at
         where id = existing.id
           and (status is distinct from (case when fee <= 0 then 'void' else e.status end)
                or fee_usd is distinct from greatest(fee, 0)
                or amount_usd is distinct from amount
                or confirmed_at is distinct from e.confirmed_at);
        return;
    end if;

    if fee <= 0 or e.status = 'void' then return; end if;

    cfg := public.referral_config();
    if coalesce((cfg->>'enabled')::boolean, true) is not true then return; end if;
    if coalesce((cfg->>'spend_enabled')::boolean, true) is not true then return; end if;
    pct := coalesce(nullif(cfg->>'spend_commission_pct_of_house_fee', '')::numeric, 50);
    if pct is null or pct <= 0 then return; end if;
    pct := least(pct, 100);
    months := coalesce(nullif(cfg->>'spend_term_months', '')::integer, 0);

    payer := public.referral_payer_user_id(e);
    if payer is null then return; end if;
    select * into a from public.referral_user_attributions where referred_user_id = payer for update;
    if not found then return; end if;
    if e.earned_at < a.attributed_at then return; end if;
    if a.referrer_user_id = payer then return; end if;
    if public.referral_is_house_user(a.referrer_user_id) then return; end if;
    if months > 0 and e.earned_at >= a.attributed_at + make_interval(months => months) then return; end if;

    -- A shared payout wallet means the same person: re-checked on every credit,
    -- since either side can set a wallet after the attribution.
    select lower(c.payout_address) into r_wallet from public.referral_codes c where c.user_id = a.referrer_user_id;
    if r_wallet is not null and exists (
        select 1 from public.referral_codes c2
         where c2.user_id = payer and lower(c2.payout_address) = r_wallet
        union all
        select 1 from public.provider_payouts pp
          join public.providers p on p.id = pp.provider_id
          join public.pubkey_links l on l.pubkey = p.public_key and l.role = 'provider'
         where l.user_id = payer and lower(pp.address) = r_wallet) then
        return;
    end if;

    amount := greatest(least(round(fee * pct / 100, 8), fee - other), 0);
    if amount <= 0 then return; end if;

    if a.first_spend_at is null or e.earned_at < a.first_spend_at then
        update public.referral_user_attributions
           set first_spend_at = least(coalesce(first_spend_at, e.earned_at), e.earned_at)
         where referred_user_id = payer;
    end if;

    insert into public.referral_commissions (kind, source_earning_id, referrer_user_id, referred_user_id,
            node_key, provider_id, job_id, reservation_id, arm, fee_usd, commission_pct, amount_usd,
            status, earned_at, confirmed_at)
    values ('spend', e.id, a.referrer_user_id, payer, null, e.provider_id, e.job_id, e.reservation_id, null,
            fee, pct, amount, e.status, e.earned_at, e.confirmed_at)
    on conflict (source_earning_id, kind) do nothing;
end $$;

-- Both programs from the one trigger; each failure is a WARNING on its own,
-- never a failed credit.
create or replace function public.provider_earnings_post_referral_commission()
returns trigger
language plpgsql
as $$
begin
    begin
        perform public.post_referral_commission(new);
    exception when others then
        raise warning 'referral commission for earning % skipped: %', new.id, sqlerrm;
    end;
    begin
        perform public.post_spend_referral_commission(new);
    exception when others then
        raise warning 'spend referral commission for earning % skipped: %', new.id, sqlerrm;
    end;
    return null;
end $$;

drop trigger if exists provider_earnings_referral_commission on public.provider_earnings;
create trigger provider_earnings_referral_commission
    after insert or update of status, fee_usd, confirmed_at on public.provider_earnings
    for each row
    when (new.kind in ('paid', 'reservation'))
    execute function public.provider_earnings_post_referral_commission();

revoke all on function public.post_spend_referral_commission(public.provider_earnings) from public;
revoke all on function public.referral_payer_user_id(public.provider_earnings) from public;
revoke all on function public.referral_is_house_user(uuid) from public;
do $grants$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on function public.post_spend_referral_commission(public.provider_earnings) from anon;
        revoke all on function public.referral_payer_user_id(public.provider_earnings) from anon;
        revoke all on function public.referral_is_house_user(uuid) from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on function public.post_spend_referral_commission(public.provider_earnings) from authenticated;
        revoke all on function public.referral_payer_user_id(public.provider_earnings) from authenticated;
        revoke all on function public.referral_is_house_user(uuid) from authenticated;
    end if;
end
$grants$;

notify pgrst, 'reload schema';
