-- Aggregators phase 1 (independent provider verification), node location for
-- /nodes/[id], and the silent-node email (docs/prd/01-live-supply.md req 4).

-- One row per (aggregator, provider) probe. Pruned to 7 days by the
-- maintenance cron (lib/maintenance.js).
create table if not exists public.provider_probes (
    id            bigserial primary key,
    aggregator_id uuid not null references public.aggregators(id) on delete cascade,
    provider_id   uuid not null references public.providers(id) on delete cascade,
    reachable     boolean not null,
    rtt_ms        integer,
    error         text,
    probed_at     timestamptz not null default now()
);
create index if not exists provider_probes_provider_time on public.provider_probes (provider_id, probed_at desc);
create index if not exists provider_probes_aggregator_time on public.provider_probes (aggregator_id, probed_at desc);
alter table public.provider_probes enable row level security;

-- Coarse location from an IP lookup, refreshed only when geo_ip changes.
-- Shape: { country, country_code, region, city, network }.
alter table public.providers   add column if not exists geo jsonb;
alter table public.providers   add column if not exists geo_ip text;
alter table public.aggregators add column if not exists geo jsonb;
alter table public.aggregators add column if not exists geo_ip text;
alter table public.aggregators add column if not exists specs jsonb;

-- Last "your node went silent" email, so an outage mails its owner once.
alter table public.providers   add column if not exists silence_emailed_at timestamptz;
alter table public.aggregators add column if not exists silence_emailed_at timestamptz;
