-- Accounts feature. Run in Supabase SQL Editor after schema.sql, collab.sql, and admin.sql
-- (this file relies on public.is_member() from collab.sql and public.admins from admin.sql).

create table if not exists public.accounts (
  user_id     text not null default (auth.jwt()->>'sub'),
  id          text not null,
  name        text not null,
  type        text not null default 'depository' check (type in ('depository', 'credit', 'loan', 'investment', 'other')),
  institution text,
  mask        text,
  balance     numeric not null default 0,
  history     jsonb not null default '[]',
  position    int not null default 0,
  created_at  timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.accounts enable row level security;

-- Own rows or a shared workspace's rows (mirrors the "own rows" policy collab.sql
-- applies to debts/payments/budgets/recurring/transactions/settings)
drop policy if exists "own rows" on public.accounts;
create policy "own rows" on public.accounts
  for all to authenticated
  using ((select auth.jwt()->>'sub') = user_id or public.is_member(user_id))
  with check ((select auth.jwt()->>'sub') = user_id or public.is_member(user_id));

-- Admin portal: read-only visibility into every customer's accounts (mirrors admin.sql)
drop policy if exists "admin read" on public.accounts;
create policy "admin read" on public.accounts
  for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.jwt()->>'sub')));
