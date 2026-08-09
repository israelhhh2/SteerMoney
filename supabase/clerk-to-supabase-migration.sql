-- ============================================================================
-- Clerk -> Supabase Auth data migration (single-user cutover)
-- ============================================================================
-- Run this ONCE in the Supabase SQL Editor (as the postgres/service role, so
-- RLS doesn't block reading/deleting other users' rows). See
-- supabase/MIGRATION-RUNBOOK.md for the full step-by-step, including the
-- BACKUP step you must do before this.
--
-- Context: this app used Clerk for auth, so every user-scoped row is keyed
-- by a Clerk id (text, e.g. 'user_3H3...'). We're cutting over to Supabase
-- Auth, where the identity is a UUID from auth.users. The owner (Israel,
-- israelhhh2@gmail.com, Clerk id 'user_3H3fpmzHTG9CRHSmeshmJVCq3zc') is the
-- ONLY user being kept — every other user's data is deleted outright
-- (product decision: simplify rather than migrate everyone).
--
-- SET THIS before running:
--   new_id below -> the new Supabase Auth UUID for Israel, obtained by
--   signing up fresh in the new app and then running:
--     select id, email from auth.users;
--   Paste that UUID (as text) in place of <<PASTE_NEW_UUID_HERE>>.
--
-- What this script does, in order, inside a single transaction:
--   a. Sanity-checks that new_id is a real, already-registered auth.users row.
--   b. DELETEs every row belonging to anyone who isn't Israel: his old Clerk
--      id, his new UUID, or a workspace (shared space) HE owns are kept —
--      everything else (other users' personal data, other users' owned
--      workspaces and their data, other users' admin/membership/feedback
--      rows) is removed.
--   c. UPDATEs every remaining Clerk-id column from old_id to new_id.
--   d. Prints a per-table row-count report and asserts zero rows anywhere
--      still reference the old Clerk id.
--
-- Idempotent: after a successful run, old_id no longer appears anywhere, so
-- every statement below matches zero rows on a re-run (harmless no-op).
--
-- IMPORTANT: run this immediately after Israel's first sign-in, before any
-- new data is created under new_id — the updates below assume new_id starts
-- with zero rows in every table, so there's nothing for the remapped rows
-- to collide with on primary keys like (user_id, id).
-- ============================================================================

begin;

do $migration$
declare
  old_id               text := 'user_3H3fpmzHTG9CRHSmeshmJVCq3zc';
  new_id               text := '<<PASTE_NEW_UUID_HERE>>';
  kept_workspace_ids   text[];
  t                    text;
  n                    bigint;
  remaining            bigint := 0;

  -- Tables where user_id is "dual purpose": either the real user id (Clerk
  -- id today, Supabase UUID after this script) or a shared workspace id
  -- (see supabase/collab.sql's "own rows" policies, which check
  -- `user_id = auth.jwt()->>'sub' OR is_member(user_id)`). debts must
  -- precede payments in both loops below because of the non-deferrable FK
  -- payments(user_id, debt_id) -> debts(user_id, id): the parent row's
  -- user_id has to already be new_id before the child row's is changed to
  -- match it (delete order doesn't matter here — cascade handles it — but
  -- update order does).
  core_delete_order    text[] := array['payments','debts','budgets','recurring','transactions','settings','accounts','goals','plaid_items'];
  core_update_order    text[] := array['debts','payments','budgets','recurring','transactions','settings','accounts','goals','plaid_items'];
  -- Newer tables (account_tags, account_colors) that may not have been
  -- migrated into every environment yet (see src/CLAUDE.md) — guarded with
  -- to_regclass() so this script doesn't fail on a project where they don't
  -- exist. Same dual-purpose user_id convention as the core tables above.
  optional_dual_tables text[] := array['account_tags','account_colors'];
begin
  -- --------------------------------------------------------------------
  -- guard: make sure new_id was actually edited before running
  -- --------------------------------------------------------------------
  if new_id like '%<<%' or new_id = '' then
    raise exception 'Set new_id to the real Supabase Auth UUID before running this script (see MIGRATION-RUNBOOK.md step 6). It still contains a placeholder: %', new_id;
  end if;

  -- --------------------------------------------------------------------
  -- (a) sanity checks
  -- --------------------------------------------------------------------
  if not exists (select 1 from auth.users u where u.id::text = new_id) then
    raise exception 'auth.users has no row with id = %. Sign up first (see MIGRATION-RUNBOOK.md step 4), then re-check: select id, email from auth.users;', new_id;
  end if;

  if exists (
    select 1 from auth.users u
    where u.email = 'israelhhh2@gmail.com' and u.id::text <> new_id
  ) then
    raise warning 'auth.users has a row for israelhhh2@gmail.com whose id does NOT match new_id = % — double-check you copied the right UUID.', new_id;
  end if;

  -- Workspaces Israel owns: kept in full (including their data rows, keyed
  -- by the workspace id itself, not by old_id/new_id).
  select coalesce(array_agg(id), array[]::text[]) into kept_workspace_ids
    from public.workspaces where owner_id = old_id;

  raise notice '--- starting migration: old_id=%  new_id=%  kept_workspace_ids=% ---', old_id, new_id, kept_workspace_ids;

  -- ======================================================================
  -- (b) DELETE every other user's data
  -- ======================================================================

  -- Other users' owned workspaces: cascades to their workspace_members and
  -- workspace_invites rows (both declared "on delete cascade" against
  -- workspaces(id) in collab.sql).
  delete from public.workspaces where owner_id not in (old_id, new_id);

  -- Any remaining membership rows for other users — including other
  -- people's memberships INSIDE workspaces Israel owns and keeps. Those
  -- members lose access; Israel would need to re-invite them post-cutover.
  delete from public.workspace_members where user_id not in (old_id, new_id);

  -- Any remaining invites created by other users (e.g. a non-owner member
  -- of one of Israel's kept spaces who generated an invite link).
  delete from public.workspace_invites where created_by not in (old_id, new_id);

  -- Admin flags for anyone but Israel.
  delete from public.admins where user_id not in (old_id, new_id);

  -- Feedback rows from other users. feedback.user_id is always a real user
  -- id (never a workspace id — it's a one-way inbox, not shared app state;
  -- see src/CLAUDE.md's feedback.sql notes), so no kept_workspace_ids
  -- exception is needed here.
  if to_regclass('public.feedback') is not null then
    delete from public.feedback where user_id not in (old_id, new_id);
  end if;

  -- Core user-scoped data tables: keep old_id, new_id, and any workspace
  -- Israel owns; delete everything else (other users' personal data, and
  -- their data inside workspaces that were just deleted above — the latter
  -- would already be gone if it had a workspace FK, but these tables don't
  -- FK to workspaces, so it needs this explicit filter too).
  foreach t in array core_delete_order loop
    execute format('delete from public.%I where user_id <> all ($1) and user_id <> all ($2)', t)
      using array[old_id, new_id], kept_workspace_ids;
  end loop;

  foreach t in array optional_dual_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('delete from public.%I where user_id <> all ($1) and user_id <> all ($2)', t)
        using array[old_id, new_id], kept_workspace_ids;
    end if;
  end loop;

  -- ======================================================================
  -- (c) UPDATE: remap old_id -> new_id everywhere it still appears
  -- ======================================================================
  foreach t in array core_update_order loop
    execute format('update public.%I set user_id = $1 where user_id = $2', t) using new_id, old_id;
  end loop;

  foreach t in array optional_dual_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('update public.%I set user_id = $1 where user_id = $2', t) using new_id, old_id;
    end if;
  end loop;

  if to_regclass('public.feedback') is not null then
    update public.feedback set user_id = new_id where user_id = old_id;
  end if;

  update public.workspaces set owner_id = new_id where owner_id = old_id;
  update public.workspace_members set user_id = new_id where user_id = old_id;
  update public.workspace_invites set created_by = new_id where created_by = old_id;
  update public.admins set user_id = new_id where user_id = old_id;

  -- ======================================================================
  -- (d) integrity report + final assertion
  -- ======================================================================
  raise notice '--- per-table rows now under new_id % ---', new_id;

  foreach t in array core_update_order loop
    execute format('select count(*) from public.%I where user_id = $1', t) into n using new_id;
    raise notice '  %: %', t, n;
  end loop;

  foreach t in array optional_dual_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('select count(*) from public.%I where user_id = $1', t) into n using new_id;
      raise notice '  %: %', t, n;
    end if;
  end loop;

  if to_regclass('public.feedback') is not null then
    select count(*) into n from public.feedback where user_id = new_id;
    raise notice '  feedback: %', n;
  end if;

  select count(*) into n from public.workspaces where owner_id = new_id;
  raise notice '  workspaces (owned): %', n;
  select count(*) into n from public.workspace_members where user_id = new_id;
  raise notice '  workspace_members: %', n;
  select count(*) into n from public.admins where user_id = new_id;
  raise notice '  admins: %', n;

  -- Final assertion: old_id must not appear ANYWHERE anymore.
  foreach t in array core_update_order loop
    execute format('select count(*) from public.%I where user_id = $1', t) into n using old_id;
    remaining := remaining + n;
  end loop;

  foreach t in array optional_dual_tables loop
    if to_regclass(format('public.%I', t)) is not null then
      execute format('select count(*) from public.%I where user_id = $1', t) into n using old_id;
      remaining := remaining + n;
    end if;
  end loop;

  if to_regclass('public.feedback') is not null then
    select count(*) into n from public.feedback where user_id = old_id;
    remaining := remaining + n;
  end if;

  select count(*) into n from public.workspaces where owner_id = old_id; remaining := remaining + n;
  select count(*) into n from public.workspace_members where user_id = old_id; remaining := remaining + n;
  select count(*) into n from public.workspace_invites where created_by = old_id; remaining := remaining + n;
  select count(*) into n from public.admins where user_id = old_id; remaining := remaining + n;

  if remaining > 0 then
    raise exception 'Migration incomplete: % row(s) still reference old_id % somewhere — rolling back.', remaining, old_id;
  end if;

  raise notice '--- migration complete: % fully remapped to %, zero rows remain under the old Clerk id ---', old_id, new_id;
end $migration$;

commit;
