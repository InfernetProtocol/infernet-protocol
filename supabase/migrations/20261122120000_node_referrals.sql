-- Node referrals: a commission to whoever referred a node, paid out of the
-- house fee, never out of the node's earnings.
--
-- Anthony, 2026-11-22. Referrers earn on the nodes (providers) they bring in:
-- commission = commission_pct_of_house_fee (5) percent of the house fee
-- earned on each settled job a referred node serves. At a 5% house fee that
-- is 0.25% of the node's revenue; it can never exceed what the house earned
-- on that job, and a job that earned the house nothing (free / subsidy /
-- fee 0) earns nothing.
--
-- A/B test on the commission TERM: every referrer is assigned once, 50/50,
-- when their code is created, to arm '12m' (commission on a referred node for
-- 12 months from that node's first settled job) or 'lifetime'. Sticky.
--
-- Tables (service role only, like the rest of the money tables):
--   referral_codes        one per referrer account: code, arm, payout address
--   referral_attributions one per node (node_key = providers.node_id, which is
--                         the daemon's node id or `c0mpute:<peer id>`), set
--                         when the node registers and never changed after
--   referral_commissions  the commission ledger, one row per fee-bearing
--                         provider_earnings credit (source_earning_id unique)
--
-- Accrual is a trigger on provider_earnings, the same shape as the
-- platform_fee trigger (20261118170000), so every settle path (interactive
-- billing, c0mpute bridge, batches, reservations, CoinPay-paid jobs) is
-- covered and a retried settle cannot double-count: the commission is keyed
-- by the credit it came from, and the credit itself is unique per
-- (job, provider). The commission mirrors its source's status (pending ->
-- confirmed -> void), so a voided job voids its commission.
--
-- Payouts reuse payout_requests (same minimum, auto-approve cap and CoinPay
-- send): a referral request names referrer_user_id instead of provider_id,
-- and payout_requests_guard checks it against referral_available_usd().
--
-- Idempotent: safe to re-run.

-- ---------------------------------------------------------------- codes ----
create table if not exists public.referral_codes (
    user_id         uuid primary key references auth.users(id) on delete cascade,
    code            text not null unique check (code ~ '^[a-z0-9]{6,16}$'),
    arm             text not null check (arm in ('12m', 'lifetime')),
    created_ip24    text,                      -- sha256 of the creator's /24 (never the IP)
    payout_coin     text,
    payout_network  text,
    payout_address  text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- --------------------------------------------------------- attributions ----
create table if not exists public.referral_attributions (
    node_key            text primary key check (length(node_key) between 3 and 200),
    referrer_user_id    uuid not null references auth.users(id) on delete cascade,
    code                text not null,
    arm                 text not null check (arm in ('12m', 'lifetime')),
    via                 text not null check (via in ('infernet-register', 'c0mpute-node')),
    provider_id         uuid references public.providers(id) on delete set null,
    node_owner_user_id  uuid,
    ip24                text,
    attributed_at       timestamptz not null default now(),
    first_settled_at    timestamptz
);
create index if not exists referral_attributions_referrer_idx on public.referral_attributions (referrer_user_id);

-- ---------------------------------------------------------- commissions ----
create table if not exists public.referral_commissions (
    id                 uuid primary key default gen_random_uuid(),
    source_earning_id  uuid not null unique references public.provider_earnings(id) on delete cascade,
    referrer_user_id   uuid not null references auth.users(id) on delete cascade,
    node_key           text not null,
    provider_id        uuid not null,
    job_id             uuid,
    reservation_id     uuid,
    arm                text not null check (arm in ('12m', 'lifetime')),
    fee_usd            numeric(18, 8) not null check (fee_usd >= 0),
    commission_pct     numeric(8, 4) not null check (commission_pct >= 0 and commission_pct <= 100),
    amount_usd         numeric(18, 8) not null check (amount_usd >= 0),
    status             text not null check (status in ('pending_approval', 'pending', 'confirmed', 'void')),
    earned_at          timestamptz not null,
    confirmed_at       timestamptz,
    created_at         timestamptz not null default now(),
    -- Never more than the house earned on that job.
    constraint referral_commission_le_fee check (amount_usd <= fee_usd)
);
create index if not exists referral_commissions_referrer_idx on public.referral_commissions (referrer_user_id, earned_at desc);
create index if not exists referral_commissions_node_idx on public.referral_commissions (node_key);

alter table public.referral_codes        enable row level security;
alter table public.referral_attributions enable row level security;
alter table public.referral_commissions  enable row level security;
revoke all on table public.referral_codes, public.referral_attributions, public.referral_commissions from anon, authenticated;

-- -------------------------------------------------------------- config -----
-- One number: the percent of the house fee a referrer gets. Default 5.
insert into public.settings (key, value)
values ('referrals', jsonb_build_object('enabled', true, 'commission_pct_of_house_fee', 5, 'term_months_12m', 12))
on conflict (key) do nothing;

create or replace function public.referral_config()
returns jsonb
language sql
stable
as $$
    select coalesce((select value from public.settings where key = 'referrals'), '{}'::jsonb)
$$;

-- ---------------------------------------------------- payout requests -----
alter table public.payout_requests alter column provider_id drop not null;
alter table public.payout_requests
    add column if not exists referrer_user_id uuid references auth.users(id) on delete cascade;
alter table public.payout_requests drop constraint if exists payout_requests_one_payee;
alter table public.payout_requests
    add constraint payout_requests_one_payee check ((provider_id is null) <> (referrer_user_id is null));
create index if not exists payout_requests_referrer_idx on public.payout_requests (referrer_user_id, created_at desc) where referrer_user_id is not null;
create unique index if not exists payout_requests_one_open_referrer
    on public.payout_requests (referrer_user_id)
    where referrer_user_id is not null and status in ('requested', 'approved', 'sending');

-- Confirmed commissions less open and sent referral payouts.
create or replace function public.referral_available_usd(p_user_id uuid)
returns numeric
language sql stable
as $$
    select coalesce((select sum(amount_usd) from public.referral_commissions
                      where referrer_user_id = p_user_id and status = 'confirmed'), 0)
         - coalesce((select sum(amount_usd) from public.payout_requests
                      where referrer_user_id = p_user_id and status in ('requested', 'approved', 'sending', 'sent')), 0);
$$;

-- Same guard as before for node payouts; a referral payout is checked
-- against the referrer's commissions instead.
create or replace function public.payout_requests_guard()
returns trigger
language plpgsql
as $$
declare avail numeric;
begin
    if new.status not in ('requested', 'approved', 'sending', 'sent') then
        return new;
    end if;
    if tg_op = 'UPDATE' and new.amount_usd <= old.amount_usd
       and old.status in ('requested', 'approved', 'sending', 'sent') then
        return new;
    end if;
    if new.referrer_user_id is not null then
        perform 1 from public.referral_codes where user_id = new.referrer_user_id for update;
        avail := public.referral_available_usd(new.referrer_user_id)
               + case when tg_op = 'UPDATE' and old.status in ('requested', 'approved', 'sending', 'sent') then old.amount_usd else 0 end;
    else
        perform 1 from public.providers where id = new.provider_id for update;
        avail := public.provider_available_usd(new.provider_id)
               + case when tg_op = 'UPDATE' and old.status in ('requested', 'approved', 'sending', 'sent') then old.amount_usd else 0 end;
    end if;
    if new.amount_usd > avail then
        raise exception 'insufficient_earnings: payout % is more than the available %', new.amount_usd, greatest(avail, 0)
            using errcode = 'check_violation';
    end if;
    return new;
end $$;

-- ------------------------------------------------------------- accrual -----
-- Post (or bring up to date) the referral commission for one credit.
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

    select * into existing from public.referral_commissions where source_earning_id = e.id;
    if found then
        -- Follow the source: its status, and void if its fee went to 0.
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

    -- A job that earned the house nothing earns no commission.
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

    -- The term starts at the node's first settled (fee-bearing) job, whether
    -- or not that job itself pays a commission.
    first_at := coalesce(a.first_settled_at, e.earned_at);
    if a.first_settled_at is null or e.earned_at < a.first_settled_at then
        update public.referral_attributions
           set first_settled_at = least(coalesce(first_settled_at, e.earned_at), e.earned_at),
               provider_id = coalesce(provider_id, e.provider_id)
         where referral_attributions.node_key = a.node_key;
        first_at := least(first_at, e.earned_at);
    end if;

    -- Self-referral, re-checked on every job: the node now belongs to the
    -- referrer, the referrer bought the job, or they share a payout address.
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

    insert into public.referral_commissions (source_earning_id, referrer_user_id, node_key, provider_id,
            job_id, reservation_id, arm, fee_usd, commission_pct, amount_usd, status, earned_at, confirmed_at)
    values (e.id, a.referrer_user_id, a.node_key, e.provider_id, e.job_id, e.reservation_id, a.arm,
            fee, pct, least(round(fee * pct / 100, 8), fee), e.status, e.earned_at, e.confirmed_at)
    on conflict (source_earning_id) do nothing;
end $$;

create or replace function public.provider_earnings_post_referral_commission()
returns trigger
language plpgsql
as $$
begin
    -- A ledger side effect must never fail the node's own credit.
    begin
        perform public.post_referral_commission(new);
    exception when others then
        raise warning 'referral commission for earning % skipped: %', new.id, sqlerrm;
    end;
    return null;
end $$;

drop trigger if exists provider_earnings_referral_commission on public.provider_earnings;
create trigger provider_earnings_referral_commission
    after insert or update of status, fee_usd, confirmed_at on public.provider_earnings
    for each row
    when (new.kind in ('paid', 'reservation'))
    execute function public.provider_earnings_post_referral_commission();

revoke all on function public.post_referral_commission(public.provider_earnings) from public;
revoke all on function public.referral_available_usd(uuid) from public;
do $grants$
begin
    if exists (select 1 from pg_roles where rolname = 'anon') then
        revoke all on function public.post_referral_commission(public.provider_earnings) from anon;
        revoke all on function public.referral_available_usd(uuid) from anon;
        revoke all on function public.referral_config() from anon;
    end if;
    if exists (select 1 from pg_roles where rolname = 'authenticated') then
        revoke all on function public.post_referral_commission(public.provider_earnings) from authenticated;
        revoke all on function public.referral_available_usd(uuid) from authenticated;
        revoke all on function public.referral_config() from authenticated;
    end if;
end
$grants$;

notify pgrst, 'reload schema';
