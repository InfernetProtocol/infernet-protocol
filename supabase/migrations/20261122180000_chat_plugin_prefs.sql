-- Per-plugin settings that outlive a chat_plugins row:
--   seeded       a default plugin (Mercury, CoinPay) was added for this account
--                once; removing it keeps it gone.
--   trading_mode brokerage plugins (moomoo): 'paper' (default) or 'live'.
-- Service role only, like the other chat plugin tables.

create table if not exists public.chat_plugin_prefs (
    user_id    text not null,
    slug       text not null,
    key        text not null,
    value      text not null,
    updated_at timestamptz not null default now(),
    primary key (user_id, slug, key)
);

alter table public.chat_plugin_prefs enable row level security;
revoke all on table public.chat_plugin_prefs from anon, authenticated;
grant select, insert, update, delete on table public.chat_plugin_prefs to service_role;

notify pgrst, 'reload schema';
