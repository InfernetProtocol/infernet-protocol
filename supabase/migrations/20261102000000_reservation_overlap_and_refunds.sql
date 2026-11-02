-- Reservation money safety (2026-11-02).
--
-- 1. A node's hours can be sold once. pickNode() works from a snapshot and a
--    late webhook can fulfil an order after its hold expired, so the database
--    is the lock: inserting or rescheduling a scheduled node reservation that
--    overlaps another scheduled one on the same provider raises, serialized
--    per provider by an advisory lock. (No btree_gist on this server, so this
--    is a trigger rather than an EXCLUDE constraint.)
-- 2. Paid orders that could not be booked are a refund queue, not a log line.

create or replace function public.reservations_refuse_overlap() returns trigger
language plpgsql as $$
begin
    if new.target_kind is distinct from 'node' or new.provider_id is null or new.status is distinct from 'scheduled' then
        return new;
    end if;
    perform pg_advisory_xact_lock(hashtextextended('reservation:' || new.provider_id::text, 0));
    if exists (
        select 1 from public.reservations r
        where r.provider_id = new.provider_id
          and r.target_kind = 'node'
          and r.status = 'scheduled'
          and r.id is distinct from new.id
          and r.start_at < new.start_at + make_interval(hours => new.hours)
          and new.start_at < r.start_at + make_interval(hours => r.hours)
    ) then
        raise exception 'node % is already booked for an overlapping window', new.provider_id
            using errcode = 'exclusion_violation';
    end if;
    return new;
end;
$$;

drop trigger if exists reservations_refuse_overlap on public.reservations;
create trigger reservations_refuse_overlap
    before insert or update of provider_id, start_at, hours, status, target_kind on public.reservations
    for each row execute function public.reservations_refuse_overlap();

alter table public.reservation_orders
    add column if not exists refund_state text check (refund_state in ('due', 'refunded')),
    add column if not exists refund_note text;

-- Orders that already failed after payment are owed a refund too.
update public.reservation_orders
   set refund_state = 'due'
 where status = 'failed' and paid_at is not null and refund_state is null;

create index if not exists reservation_orders_refund_due_idx
    on public.reservation_orders (created_at) where refund_state = 'due';
