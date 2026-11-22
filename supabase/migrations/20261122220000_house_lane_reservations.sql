-- House-lane reservations: confidential, per-user-billed inference on
-- Profullstack-operated nodes only.
--
-- A reservation with house_lane = true:
--   * serves only a trusted client (X-Infernet-Client-Key: ifc_...) that names
--     the person paying (X-Infernet-Billed-Subject). Each request is charged to
--     that person's compute balance at the ordinary per-token price, and a
--     caller with no balance is refused (402) rather than served free;
--   * runs pinned to the reservation's node with no fallback (no re-pick, no
--     c0mpute auction, no hosted/NIM fallback): if that node is down, 503;
--   * keeps no content: jobs it creates carry no_retain = true, so the prompt
--     (input_spec.messages), the answer (result) and the token stream
--     (job_events) are purged as soon as the request finishes, and a cron
--     sweep purges anything a crash left behind. Billing keeps only counts.
--
-- A standing house lane outlives the 30-day cap a resold reservation has, so
-- house-lane reservations may run up to 366 days (8784 hours). The cap for
-- everything else stays 720 hours in lib/reservations/core.js.

alter table public.reservations
    add column if not exists house_lane boolean not null default false;

alter table public.reservations drop constraint if exists reservations_hours_check;
alter table public.reservations
    add constraint reservations_hours_check check (hours between 1 and 8784);

alter table public.jobs
    add column if not exists no_retain boolean not null default false;
alter table public.jobs
    add column if not exists content_purged_at timestamptz;

create index if not exists jobs_no_retain_unpurged_idx
    on public.jobs (created_at)
    where no_retain and content_purged_at is null;

-- PostgREST caches the schema: reload it so the API sees house_lane (on dev2 a
-- notify was not enough once; restart infernetprotocol-com-supabase-rest then).
notify pgrst, 'reload schema';
