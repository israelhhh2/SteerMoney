-- Finance Dashboard schema (Supabase + Clerk third-party auth)
-- Run in Supabase SQL Editor.
-- RLS uses auth.jwt()->>'sub' = the Clerk user id, so every row is private
-- to the signed-in Clerk user.

create table if not exists public.debts (
  user_id      text not null default (auth.jwt()->>'sub'),
  id           text not null,
  name         text not null,
  balance      numeric not null default 0,
  apr          text,
  min_payment  numeric not null default 0,
  due_day      int,
  credit_limit numeric,
  note         text,
  position     int not null default 0,
  created_at   timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.payments (
  user_id    text not null default (auth.jwt()->>'sub'),
  id         text not null,
  debt_id    text not null,
  date       date not null,
  amount     numeric not null,
  note       text,
  created_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, debt_id) references public.debts (user_id, id) on delete cascade
);

create table if not exists public.budgets (
  user_id       text not null default (auth.jwt()->>'sub'),
  id            text not null,
  name          text not null,
  monthly_limit numeric not null default 0,
  position      int not null default 0,
  created_at    timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.recurring (
  user_id        text not null default (auth.jwt()->>'sub'),
  id             text not null,
  description    text not null,
  amount         numeric not null default 0,
  due_day        int,
  category       text not null default 'other',
  active         boolean not null default true,
  every_n_months int not null default 1,
  position       int not null default 0,
  created_at     timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.transactions (
  user_id     text not null default (auth.jwt()->>'sub'),
  id          text not null,
  date        date not null,
  description text not null,
  amount      numeric not null,
  type        text not null check (type in ('income','expense')),
  category    text not null default 'other',
  created_at  timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.settings (
  user_id    text primary key default (auth.jwt()->>'sub'),
  sim        jsonb,
  m_sim      jsonb,
  updated_at timestamptz not null default now()
);

create index if not exists transactions_user_date on public.transactions (user_id, date desc);
create index if not exists payments_user_debt on public.payments (user_id, debt_id);

-- Row Level Security: each Clerk user sees only their own rows
do $$
declare t text;
begin
  foreach t in array array['debts','payments','budgets','recurring','transactions','settings'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format($p$
      create policy "own rows" on public.%I
        for all to authenticated
        using ((select auth.jwt()->>'sub') = user_id)
        with check ((select auth.jwt()->>'sub') = user_id)
    $p$, t);
  end loop;
end $$;
