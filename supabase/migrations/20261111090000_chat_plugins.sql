-- Chat plugins: remote MCP servers a person adds to /chat (and the CLI, MCP,
-- desktop) by pasting a URL or picking one from the catalog. Sign-in is OAuth
-- 2.1 with dynamic client registration, done by the server for them.
--
-- Tokens are sealed (AES-256-GCM, @profullstack/chat-plugins sealToken) under a
-- key derived from INFERNET_DB_ENCRYPTION_KEY before they reach this table, so a
-- database dump holds ciphertext only. Service role only, like billing.

create table if not exists public.chat_plugins (
    id             uuid primary key default gen_random_uuid(),
    user_id        text not null,
    slug           text not null,
    name           text not null,
    url            text not null,
    auth           text not null default 'none' check (auth in ('none', 'oauth', 'optional')),
    enabled        boolean not null default true,
    tokens_sealed  text,
    tools          jsonb not null default '[]'::jsonb,
    tools_at       timestamptz,
    instructions   text,
    last_error     text,
    created_at     timestamptz not null default now(),
    updated_at     timestamptz not null default now(),
    unique (user_id, slug)
);
create index if not exists chat_plugins_user_idx on public.chat_plugins (user_id, created_at);

-- Registered OAuth clients, one per (issuer, redirect_uri), shared by everyone:
-- a client id is public and carries no user data.
create table if not exists public.chat_plugin_clients (
    key         text primary key,
    client      jsonb not null,
    created_at  timestamptz not null default now()
);

-- A sign-in in flight: state -> sealed PKCE verifier etc. Short-lived.
create table if not exists public.chat_plugin_auth_pending (
    state           text primary key,
    user_id         text not null,
    slug            text not null,
    pending_sealed  text not null,
    return_to       text,
    created_at      timestamptz not null default now()
);
create index if not exists chat_plugin_auth_pending_created_idx on public.chat_plugin_auth_pending (created_at);

-- A destructive tool call waiting on the person's OK (an approval card).
create table if not exists public.chat_plugin_approvals (
    id              uuid primary key default gen_random_uuid(),
    user_id         text not null,
    model_name      text,
    pending_sealed  text not null,
    created_at      timestamptz not null default now()
);
create index if not exists chat_plugin_approvals_user_idx on public.chat_plugin_approvals (user_id, created_at);

do $$
declare t text;
begin
    foreach t in array array['chat_plugins', 'chat_plugin_clients', 'chat_plugin_auth_pending', 'chat_plugin_approvals'] loop
        execute format('alter table public.%I enable row level security', t);
        execute format('revoke all on table public.%I from anon, authenticated', t);
        execute format('grant select, insert, update, delete on table public.%I to service_role', t);
    end loop;
end $$;
