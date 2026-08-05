-- Shared workspace members: names/emails on membership rows, plus the
-- policies needed to list a space's members and let the owner remove one.
-- Run in the Supabase SQL Editor after collab.sql.

alter table public.workspace_members
  add column if not exists name  text,
  add column if not exists email text;

-- Note: the existing "member read" select policy on workspace_members
-- (from collab.sql) already covers this feature: it allows a row to be seen
-- by its own user_id OR by any member of that row's workspace, via the
-- security-definer public.is_member() helper. No select policy change needed.

-- Members can update their own row (used to backfill/refresh name + email).
drop policy if exists "self update" on public.workspace_members;
create policy "self update" on public.workspace_members for update to authenticated
  using (user_id = (select auth.jwt()->>'sub'))
  with check (user_id = (select auth.jwt()->>'sub'));

-- The workspace owner can remove any member; anyone can remove themselves (leave).
drop policy if exists "owner delete" on public.workspace_members;
create policy "owner delete" on public.workspace_members for delete to authenticated
  using (exists (select 1 from public.workspaces w
                 where w.id = workspace_id
                   and w.owner_id = (select auth.jwt()->>'sub')));
drop policy if exists "self delete" on public.workspace_members;
create policy "self delete" on public.workspace_members for delete to authenticated
  using (user_id = (select auth.jwt()->>'sub'));

-- join_workspace now optionally stores the joining user's name/email.
-- Dropped and recreated (rather than just "create or replace") because the
-- parameter list changed: keeping only the old (text) overload around would
-- make calls ambiguous between the two signatures.
drop function if exists public.join_workspace(text);
create or replace function public.join_workspace(invite_token text, p_name text default null, p_email text default null) returns text
language plpgsql security definer set search_path = public as $$
declare ws text; nm text;
begin
  select workspace_id into ws from workspace_invites
   where token = invite_token and expires_at > now();
  if ws is null then return null; end if;
  insert into workspace_members (workspace_id, user_id, name, email)
  values (ws, auth.jwt()->>'sub', p_name, p_email)
  on conflict (workspace_id, user_id) do update set
    name  = coalesce(excluded.name, workspace_members.name),
    email = coalesce(excluded.email, workspace_members.email);
  select name into nm from workspaces where id = ws;
  return ws || '|' || coalesce(nm, 'Shared finances');
end $$;
grant execute on function public.join_workspace(text, text, text) to authenticated;
