-- Finance chat daily AI token cap (Step 2, 2026-09). Run in the Supabase SQL
-- Editor after schema.sql. See src/lib/chat-usage.js for the JS side.
--
-- Tracked per AUTHENTICATED user id (never a shared space's id) — a space
-- member asking the chat about a shared space must not be able to drain the
-- space OWNER's daily cap, so this table is keyed on whoever is actually
-- signed in, independent of which space they're viewing.

create table if not exists public.ai_usage (
  user_id       text not null,
  day           date not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  requests      int not null default 0,
  updated_at    timestamptz not null default now(),
  primary key (user_id, day)
);

alter table public.ai_usage enable row level security;

-- Read-only for the owning user, mirroring the auth.jwt()->>'sub' convention
-- every other table in this app uses (see collab.sql/accounts.sql/goals.sql).
-- No insert/update policy: every write goes through supabaseAdmin (the
-- service-role client, src/lib/plaid-server.js), which bypasses RLS
-- entirely — see plaid.sql for the same "deny-all except service role"
-- posture on a table nothing client-side should ever write directly.
drop policy if exists "own rows" on public.ai_usage;
create policy "own rows" on public.ai_usage
  for select to authenticated
  using ((select auth.jwt()->>'sub') = user_id);

-- Upsert-add used by src/lib/chat-usage.js's recordUsage() via
-- supabaseAdmin.rpc(...) so two concurrent requests from the same user on
-- the same day never lose a write to a read-modify-write race (a plain
-- select-then-update from the JS side would).
create or replace function public.increment_ai_usage(p_user_id text, p_day date, p_input bigint, p_output bigint)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.ai_usage (user_id, day, input_tokens, output_tokens, requests, updated_at)
  values (p_user_id, p_day, p_input, p_output, 1, now())
  on conflict (user_id, day) do update
    set input_tokens  = public.ai_usage.input_tokens + excluded.input_tokens,
        output_tokens = public.ai_usage.output_tokens + excluded.output_tokens,
        requests      = public.ai_usage.requests + 1,
        updated_at    = now();
$$;

grant execute on function public.increment_ai_usage(text, date, bigint, bigint) to authenticated;
