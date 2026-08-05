-- Plaid bank connections.
--
-- This table is server-only: it holds long-lived Plaid access tokens, so it
-- must NEVER be reachable from the browser Supabase client (the one created
-- with the user's Clerk session token in src/lib/supabase.js).
--
-- RLS is enabled below but NO policies are created on purpose. Enabling RLS
-- with zero policies denies every request by default, including from the
-- anon and authenticated roles. The ONLY way to read or write this table is
-- with the Supabase service-role key, which bypasses RLS entirely and is
-- only ever used from server routes (src/lib/plaid-server.js), never sent to
-- the browser. Do not add an "own rows" policy here like the other tables.
--
-- Run in the Supabase SQL Editor after schema.sql.

create table if not exists public.plaid_items (
  id           text primary key default gen_random_uuid()::text,
  user_id      text not null,
  item_id      text not null unique,
  access_token text not null,
  institution  text,
  accounts     jsonb not null default '[]',
  cursor       text,
  last_synced  timestamptz,
  created_at   timestamptz not null default now()
);

create index if not exists plaid_items_user on public.plaid_items (user_id);

-- Deny-all RLS: enabled, no policies. Server routes must use the
-- service-role key (supabaseAdmin in src/lib/plaid-server.js), which
-- bypasses RLS, to touch this table.
alter table public.plaid_items enable row level security;
