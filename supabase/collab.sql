-- Shared workspaces (collab). Run in Supabase SQL Editor after schema.sql.
--
-- A workspace id (ws_...) acts as the user_id on data rows. Members of a
-- workspace can read and write those rows exactly like their own. Joining
-- happens through single-use-style invite tokens that expire in 7 days.

create table if not exists public.workspaces (
  id         text primary key,
  name       text not null default 'Shared finances',
  owner_id   text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.workspace_members (
  workspace_id text not null references public.workspaces(id) on delete cascade,
  user_id      text not null,
  created_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create table if not exists public.workspace_invites (
  token        text primary key,
  workspace_id text not null references public.workspaces(id) on delete cascade,
  created_by   text not null,
  expires_at   timestamptz not null default (now() + interval '7 days')
);

alter table public.workspaces        enable row level security;
alter table public.workspace_members enable row level security;
alter table public.workspace_invites enable row level security;

-- Is the signed-in user a member of workspace w?
-- SECURITY DEFINER so it can read workspace_members inside policies without recursion.
create or replace function public.is_member(w text) returns boolean
language sql stable security definer set search_path = public as
$$ select exists (select 1 from workspace_members m
                  where m.workspace_id = w
                    and m.user_id = (auth.jwt()->>'sub')) $$;
grant execute on function public.is_member(text) to authenticated;

-- workspaces
drop policy if exists "member read" on public.workspaces;
create policy "member read" on public.workspaces for select to authenticated
  using (owner_id = (select auth.jwt()->>'sub') or public.is_member(id));
drop policy if exists "owner create" on public.workspaces;
create policy "owner create" on public.workspaces for insert to authenticated
  with check (owner_id = (select auth.jwt()->>'sub'));

-- workspace_members
drop policy if exists "member read" on public.workspace_members;
create policy "member read" on public.workspace_members for select to authenticated
  using (user_id = (select auth.jwt()->>'sub') or public.is_member(workspace_id));
drop policy if exists "owner self add" on public.workspace_members;
create policy "owner self add" on public.workspace_members for insert to authenticated
  with check (user_id = (select auth.jwt()->>'sub')
              and exists (select 1 from public.workspaces w
                          where w.id = workspace_id
                            and w.owner_id = (select auth.jwt()->>'sub')));

-- workspace_invites
drop policy if exists "member create" on public.workspace_invites;
create policy "member create" on public.workspace_invites for insert to authenticated
  with check (public.is_member(workspace_id) and created_by = (select auth.jwt()->>'sub'));
drop policy if exists "member read" on public.workspace_invites;
create policy "member read" on public.workspace_invites for select to authenticated
  using (public.is_member(workspace_id));

-- Join a workspace from an invite link. SECURITY DEFINER: validates the token
-- and adds the caller as a member. Returns 'ws_id|name', or null when invalid.
create or replace function public.join_workspace(invite_token text) returns text
language plpgsql security definer set search_path = public as $$
declare ws text; nm text;
begin
  select workspace_id into ws from workspace_invites
   where token = invite_token and expires_at > now();
  if ws is null then return null; end if;
  insert into workspace_members (workspace_id, user_id)
  values (ws, auth.jwt()->>'sub')
  on conflict do nothing;
  select name into nm from workspaces where id = ws;
  return ws || '|' || coalesce(nm, 'Shared finances');
end $$;
grant execute on function public.join_workspace(text) to authenticated;

-- Data tables: workspace members use rows whose user_id is that workspace id.
do $$
declare t text;
begin
  foreach t in array array['debts','payments','budgets','recurring','transactions','settings'] loop
    execute format('drop policy if exists "own rows" on public.%I', t);
    execute format($p$
      create policy "own rows" on public.%I
        for all to authenticated
        using ((select auth.jwt()->>'sub') = user_id or public.is_member(user_id))
        with check ((select auth.jwt()->>'sub') = user_id or public.is_member(user_id))
    $p$, t);
  end loop;
end $$;

-- Admin portal can see workspace metadata
drop policy if exists "admin read" on public.workspaces;
create policy "admin read" on public.workspaces for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.jwt()->>'sub')));
drop policy if exists "admin read" on public.workspace_members;
create policy "admin read" on public.workspace_members for select to authenticated
  using (exists (select 1 from public.admins a where a.user_id = (select auth.jwt()->>'sub')));
