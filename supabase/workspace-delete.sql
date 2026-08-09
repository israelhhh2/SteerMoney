-- Lets a shared space's owner permanently delete it. Run in the Supabase
-- SQL Editor after collab.sql. collab.sql only grants workspaces
-- select/insert (workspace-rename.sql later added update) — without this,
-- an owner-only delete from the app is silently rejected by RLS.
--
-- workspace_members and workspace_invites need no policy change: both
-- already reference workspaces(id) "on delete cascade" (see collab.sql), and
-- Postgres foreign-key referential-integrity actions — including cascading
-- deletes — always bypass row-level security, so deleting the workspaces
-- row here removes every membership and pending invite for it automatically.
-- (src/store.jsx's deleteSpace() deletes the space's data rows across every
-- other table BEFORE this, while the caller is still a recognized member —
-- see that function's comments for why the ordering matters.)

drop policy if exists "owner delete" on public.workspaces;
create policy "owner delete" on public.workspaces for delete to authenticated
  using (owner_id = (select auth.jwt()->>'sub'));
