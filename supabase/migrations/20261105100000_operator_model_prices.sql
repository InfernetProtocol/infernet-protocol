-- Operator-set model prices, with a house default and a house band.
--
-- Until now a model's price came only from the `inference_pricing` settings
-- row, and a model missing from it was served FREE (free_when_unpriced). So
-- every model added to the network gave compute away until someone remembered
-- to price it: on 2026-11-05 that was 9 of the 12 models actually being
-- served, including all three of our own fine-tuned agents.
--
-- Two changes:
--   * a default price applies to any model nobody has priced, so adding a
--     model is never an accidental giveaway (settings: default_model_price)
--   * a node operator can set their own price for the models their node
--     serves, inside a house band (settings: operator_price_min/max_per_m_usd)
--
-- Resolution order at charge time is operator, then house, then default.
-- The band is enforced when an operator writes a price AND applied again when
-- one is read, so narrowing the band later cannot leave a stale price outside
-- it. See apps/web/lib/billing/operator-prices.js.
--
-- The price actually used is recorded in provider_earnings.metadata
-- (price_source, input_per_m_usd, output_per_m_usd) so a receipt still makes
-- sense after the operator changes their price.

create table if not exists public.provider_model_prices (
    provider_id        uuid not null references public.providers(id) on delete cascade,
    -- The model id as the node advertises it in specs.served_models.
    model              text not null check (length(model) between 1 and 200),
    -- USD per 1M tokens. The bounds live in settings, not here: they are
    -- policy and they change, while these are just numbers. Non-negative is
    -- structural and stays a constraint.
    input_per_m_usd    numeric(12, 6) not null check (input_per_m_usd >= 0),
    output_per_m_usd   numeric(12, 6) not null check (output_per_m_usd >= 0),
    -- Who last wrote it, for an audit trail on a money-affecting row.
    set_by             text,
    created_at         timestamptz not null default now(),
    updated_at         timestamptz not null default now(),
    primary key (provider_id, model)
);

create index if not exists provider_model_prices_model_idx
    on public.provider_model_prices (model);

alter table public.provider_model_prices enable row level security;
revoke all on table public.provider_model_prices from anon, authenticated;
grant select, insert, update, delete on table public.provider_model_prices to service_role;
