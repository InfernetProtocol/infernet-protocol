-- Self-serve reservation orders (docs/prd/16-managed-endpoints.md, "Self-serve orders").
--
-- Anyone, person or agent, can book a managed endpoint without an admin: the
-- API picks an online node that fits the GPU class and serves the models,
-- quotes the list price, takes payment up front (x402 in USDC, or a CoinPay
-- checkout for any coin CoinPay takes or PayPal) and creates the reservation
-- the moment the payment is confirmed.
--
-- The buyer token is minted when the order is placed and returned once; only
-- its hash is kept here, and the reservation is created with that same hash,
-- so the token that tracks the order is the token that reads the reservation.

create table if not exists public.reservation_orders (
    id uuid primary key default gen_random_uuid(),
    status text not null default 'awaiting_payment'
        check (status in ('awaiting_payment', 'fulfilled', 'failed', 'expired')),
    rail text not null check (rail in ('x402', 'checkout')),
    gpu_class text not null check (gpu_class in ('l40s', 'a100', 'h100', 'h100x2')),
    models text[] not null check (array_length(models, 1) >= 1),
    provider_id uuid not null references public.providers(id) on delete restrict,
    operator_name text not null,
    start_at timestamptz not null check (date_trunc('hour', start_at) = start_at),
    hours integer not null check (hours between 1 and 168),
    price_per_hour numeric(14, 4) not null check (price_per_hour >= 0),
    setup_fee numeric(14, 4) not null check (setup_fee >= 0),
    total_usd numeric(14, 4) not null check (total_usd > 0),
    name text not null,
    email text,
    buyer_token_hash text not null,
    -- CoinPay checkout session / payment id, or the x402 settlement tx hash.
    -- Unique so one payment can never fulfil two orders.
    payment_ref text unique,
    payer text,
    reservation_id uuid references public.reservations(id) on delete set null,
    error text,
    created_at timestamptz not null default now(),
    paid_at timestamptz,
    updated_at timestamptz not null default now()
);

create index if not exists reservation_orders_provider_idx on public.reservation_orders (provider_id, start_at);

alter table public.reservation_orders enable row level security;
