-- Rented-GPU orders on more than one cloud (docs/prd/16-managed-endpoints.md,
-- "Rented GPU providers").
--
-- Salad arrived first and wrote its container group into salad_group /
-- salad_state. Vast.ai and Thunder Compute rent the same way but are not Salad,
-- so the three provider-neutral columns below replace that pair:
--
--   rental_provider  which cloud is serving this order (salad | vast | thunder)
--   rental_ref       the cloud's own id for what we created (container group
--                    name, Vast contract id, Thunder instance id)
--   rental_state     where it is in its lifecycle
--
-- The states differ from Salad's three because a Vast or Thunder instance bills
-- from the moment it is rented, so it cannot be created at payment time the way
-- a stopped Salad group can:
--
--   pending   paid, nothing rented yet (the cron rents it during warm-up)
--   created   rented, not serving yet (a Salad group exists but is stopped)
--   started   serving: the endpoint answers and the model is loaded
--   deleted   torn down, the window is over
--
-- salad_group and salad_state are left in place and backfilled from, not
-- dropped: a rollback to the previous release has to keep working.

alter table public.reservation_orders add column if not exists rental_provider text
    check (rental_provider is null or rental_provider in ('salad', 'vast', 'thunder'));
alter table public.reservation_orders add column if not exists rental_ref text;
alter table public.reservation_orders add column if not exists rental_state text
    check (rental_state is null or rental_state in ('pending', 'created', 'started', 'deleted'));

-- Existing Salad orders carry on under the new columns.
update public.reservation_orders
   set rental_provider = 'salad',
       rental_ref = salad_group,
       rental_state = salad_state
 where salad_group is not null
   and rental_ref is null;

create index if not exists reservation_orders_rental_idx
    on public.reservation_orders (rental_state)
    where rental_provider is not null;

-- A rented order's reservation gets its endpoint once the box is up, so the
-- URL and its secret have to be patchable after the row is created.
comment on column public.reservations.endpoint_url is
    'OpenAI-compatible base URL. For a rented-GPU order this is a placeholder until the cron resolves the rented instance address during warm-up.';
