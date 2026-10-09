-- Managed endpoints / reservations (docs/prd/16-managed-endpoints.md).
--
-- A reservation pins exact model id(s) on ONE named operator target for a
-- block of whole UTC hours. A reseller issues per-reservation API keys to its
-- own customers; requests on those keys route only to the pinned target and
-- are held to per-key and shared rate/concurrency limits plus an included
-- token allowance. A per-minute prober records availability for every minute
-- of the window, traffic or not, and the per-hour compliance report plus the
-- post-paid invoice view are derived from those rows. No payment is executed.

create table if not exists public.reservations (
    id uuid primary key default gen_random_uuid(),
    name text not null,
    buyer text,                                   -- reseller label, e.g. "KAI"
    operator_name text not null,                  -- the identified operator
    -- Target: either a registered Infernet node (provider_id) or an
    -- operator-run OpenAI-compatible endpoint (endpoint_url). Exactly one.
    target_kind text not null check (target_kind in ('node', 'endpoint')),
    provider_id uuid references public.providers(id) on delete restrict,
    endpoint_url text,
    endpoint_secret jsonb,                        -- encryptJSON({ apiKey })
    models text[] not null check (array_length(models, 1) >= 1),
    start_at timestamptz not null,
    hours integer not null check (hours between 1 and 720),
    included_tokens bigint not null default 0 check (included_tokens >= 0),
    per_key_rps integer not null default 1 check (per_key_rps >= 1),
    per_key_concurrency integer not null default 1 check (per_key_concurrency >= 1),
    shared_rps integer not null default 5 check (shared_rps >= 1),
    shared_concurrency integer not null default 4 check (shared_concurrency >= 1),
    required_minutes_per_hour integer not null default 60
        check (required_minutes_per_hour between 1 and 60),
    probe_completion boolean not null default false,
    -- Post-paid pricing. Null means "not priced yet"; the invoice view says so
    -- instead of inventing an amount.
    currency text not null default 'USD',
    price_per_hour numeric(14, 4) check (price_per_hour is null or price_per_hour >= 0),
    status text not null default 'scheduled'
        check (status in ('scheduled', 'cancelled')),
    buyer_token_hash text not null,              -- sha256 of the buyer's read-only token
    tokens_used bigint not null default 0,
    created_by text,
    notes text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint reservations_start_whole_hour
        check (date_trunc('hour', start_at) = start_at),
    constraint reservations_target_shape check (
        (target_kind = 'node' and provider_id is not null and endpoint_url is null)
        or (target_kind = 'endpoint' and endpoint_url is not null and provider_id is null)
    )
);

create index if not exists reservations_window_idx on public.reservations (start_at);

create table if not exists public.reservation_keys (
    id uuid primary key default gen_random_uuid(),
    reservation_id uuid not null references public.reservations(id) on delete cascade,
    label text,
    key_prefix text not null,                     -- first 12 chars, for display
    key_hash text not null unique,                -- sha256(key)
    revoked_at timestamptz,
    created_at timestamptz not null default now()
);

create index if not exists reservation_keys_res_idx on public.reservation_keys (reservation_id);

-- One row per reservation-minute. ok=false rows are kept: a failed probe is
-- evidence too. A minute with no row at all counts as unconfirmed.
create table if not exists public.reservation_probes (
    reservation_id uuid not null references public.reservations(id) on delete cascade,
    minute timestamptz not null,
    ok boolean not null,
    latency_ms integer,
    detail text,
    probed_at timestamptz not null default now(),
    primary key (reservation_id, minute)
);

create table if not exists public.reservation_usage (
    id bigserial primary key,
    reservation_id uuid not null references public.reservations(id) on delete cascade,
    key_id uuid references public.reservation_keys(id) on delete set null,
    at timestamptz not null default now(),
    model text,
    -- ok | upstream_error | limit_rps | limit_concurrency | limit_tokens
    outcome text not null,
    limit_scope text,                             -- key | shared
    prompt_tokens integer not null default 0,
    completion_tokens integer not null default 0,
    tokens_estimated boolean not null default false,
    latency_ms integer,
    http_status integer
);

create index if not exists reservation_usage_res_at_idx on public.reservation_usage (reservation_id, at);

-- Atomic token counter so concurrent requests cannot both spend the last
-- of the allowance unseen.
create or replace function public.reservation_add_tokens(p_reservation_id uuid, p_tokens bigint)
returns bigint
language sql
as $$
    update public.reservations
       set tokens_used = tokens_used + greatest(p_tokens, 0),
           updated_at = now()
     where id = p_reservation_id
    returning tokens_used;
$$;

-- Service-role only, like the rest of the control-plane tables.
alter table public.reservations enable row level security;
alter table public.reservation_keys enable row level security;
alter table public.reservation_probes enable row level security;
alter table public.reservation_usage enable row level security;
revoke all on function public.reservation_add_tokens(uuid, bigint) from public, anon, authenticated;
grant execute on function public.reservation_add_tokens(uuid, bigint) to service_role;
