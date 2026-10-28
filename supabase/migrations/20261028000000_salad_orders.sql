-- Consumer-GPU orders on SaladCloud (docs/prd/16-managed-endpoints.md,
-- "Consumer GPUs on SaladCloud").
--
-- A Salad order has no network node: the reservation targets the order's own
-- container group (an OpenAI endpoint behind Salad's gateway), so provider_id
-- is null and the group's name and lifecycle state live on the order. The
-- gpu_class lists are checked in the app (lib/reservations/pricing.js), which
-- now also sells the consumer cards.

alter table public.reservation_orders alter column provider_id drop not null;
alter table public.reservation_orders drop constraint if exists reservation_orders_gpu_class_check;
alter table public.reservation_orders add column if not exists salad_group text;
alter table public.reservation_orders add column if not exists salad_state text
    check (salad_state is null or salad_state in ('created', 'started', 'deleted'));

alter table public.reservations drop constraint if exists reservations_gpu_class_check;

create index if not exists reservation_orders_salad_idx on public.reservation_orders (salad_state)
    where salad_group is not null;
