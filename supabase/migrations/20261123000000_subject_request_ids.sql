-- Signed billed subjects: accept each request id once (replay protection).
--
-- A trusted client signs "<subject>|<ts>|<request id>"; the signature is good
-- for five minutes either side of our clock. Without remembering the ids, a
-- captured request could be replayed inside that window. The app keeps a
-- memory cache too; this table catches a replay after a restart or on another
-- instance. Rows older than the window decide nothing and are pruned as we go.

create table if not exists public.subject_request_ids (
    key     text primary key,
    seen_at timestamptz not null default now()
);
create index if not exists subject_request_ids_seen_idx on public.subject_request_ids (seen_at);

alter table public.subject_request_ids enable row level security;
revoke all on table public.subject_request_ids from anon, authenticated;
grant select, insert, delete on table public.subject_request_ids to service_role;

-- true the first time a key is seen, false on a replay.
create or replace function public.subject_request_claim(p_key text)
returns boolean
language plpgsql
as $$
declare
    inserted integer;
begin
    if p_key is null or length(p_key) = 0 or length(p_key) > 300 then
        return false;
    end if;
    -- Cheap pruning: one call in fifty clears what is past the window.
    if random() < 0.02 then
        delete from public.subject_request_ids where seen_at < now() - interval '15 minutes';
    end if;
    insert into public.subject_request_ids (key) values (p_key)
    on conflict (key) do nothing;
    get diagnostics inserted = row_count;
    return inserted = 1;
end $$;

revoke all on function public.subject_request_claim(text) from public, anon, authenticated;
grant execute on function public.subject_request_claim(text) to service_role;
