-- Lets a shared space's owner rename it. Run in the Supabase SQL Editor
-- after collab.sql. collab.sql only grants workspaces select/insert
-- policies, so without this, owner_id-only rename updates from the app
-- are silently rejected by RLS.

drop policy if exists "owner update" on public.workspaces;
create policy "owner update" on public.workspaces for update to authenticated
  using (owner_id = (select auth.jwt()->>'sub'))
  with check (owner_id = (select auth.jwt()->>'sub'));
