-- Admin access: members of public.admins can READ every user's rows.
-- Run in Supabase SQL Editor (after schema.sql).

create table if not exists public.admins (
  user_id    text primary key,
  created_at timestamptz not null default now()
);
alter table public.admins enable row level security;

-- users may check their own admin status (needed by the app's admin gate)
drop policy if exists "read own admin row" on public.admins;
create policy "read own admin row" on public.admins
  for select to authenticated
  using (user_id = (select auth.jwt()->>'sub'));

-- read-only visibility into all customer data for admins
do $$
declare t text;
begin
  foreach t in array array['debts','payments','budgets','recurring','transactions','settings'] loop
    execute format('drop policy if exists "admin read" on public.%I', t);
    execute format($p$
      create policy "admin read" on public.%I
        for select to authenticated
        using (exists (select 1 from public.admins a where a.user_id = (select auth.jwt()->>'sub')))
    $p$, t);
  end loop;
end $$;

-- Israel = admin
insert into public.admins (user_id) values ('user_3H3fpmzHTG9CRHSmeshmJVCq3zc')
on conflict (user_id) do nothing;
