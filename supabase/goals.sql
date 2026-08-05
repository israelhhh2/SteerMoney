-- Goals feature. Run in Supabase SQL Editor after schema.sql, collab.sql, and admin.sql
-- (this file relies on public.is_member() from collab.sql and public.admins from admin.sql).

create table if not exists public.goals (
  user_id     text not null default (auth.jwt()->>'sub'),
  id          text not null,
  name        text not null,
  icon        text,
  target      numeric not null default 0,
  target_date text,
  status      text not null default 'active' check (status in ('active', 'archived')),
  txs         jsonb not null default '[]',
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.goals enable row level security;

-- Own rows or a shared workspace's rows (mirrors the "own rows" policy collab.sql
-- applies to debts/payments/budgets/recurring/transactions/settings)
drop policy if exists "own rows" on public.goals;
create policy "own rows" on public.goals
  for all to authenticated
  using ((select auth.jwt()->>'sub') = user_id or public.is_member(user_id))
  with check ((select auth.jwt()->>'sub') = user_id or public.is_member(user_id));

-- Admin portal: read-only visibility into every customer's goals (mirrors admin.sql)
drop policy if exists "admin read" on public.goals;
create policy "admin read" on public.goals
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.jwt()->>'sub')));
