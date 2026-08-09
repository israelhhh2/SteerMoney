# Clerk → Supabase Auth cutover runbook

Scope: one user (Israel, israelhhh2@gmail.com). Every other user's data is
deleted by design (see `clerk-to-supabase-migration.sql`). Do these steps
in order, on the **production** Supabase project.

---

## 0. Back up the database FIRST

Do this before touching anything else — it's your undo button if a step
below goes wrong.

**Dashboard:** Project → Database → Backups → "Create backup now" (or confirm
a recent automatic backup exists and note its timestamp).

**Or via `pg_dump`** (get the connection string from Project Settings →
Database → Connection string → URI):

```bash
pg_dump "postgresql://postgres:[PASSWORD]@[HOST]:5432/postgres" \
  --schema=public -f steermoney-backup-$(date +%Y%m%d-%H%M).sql
```

Keep this file somewhere safe until you've verified step 7 below.

---

## 1. Enable Email + Google sign-in

**Dashboard → Authentication → Providers**

- **Email**
  - Toggle **Email** to enabled.
  - "Confirm email" — up to you (off is fine for a single-user app; on if
    you want the confirmation-link flow).

- **Google**
  - Toggle **Google** to enabled.
  - You need a **Google OAuth client ID + secret**. Create one at
    [Google Cloud Console → APIs & Services → Credentials](https://console.cloud.google.com/apis/credentials):
    1. Create (or reuse) a project.
    2. "Create Credentials" → "OAuth client ID" → Application type: **Web application**.
    3. Under **Authorized redirect URIs**, add exactly:
       ```
       https://<project-ref>.supabase.co/auth/v1/callback
       ```
       (Replace `<project-ref>` with your Supabase project ref — visible in
       the dashboard URL or Project Settings → General.)
    4. Save, copy the **Client ID** and **Client secret**.
  - Paste the Client ID and Client secret into the Supabase Google provider
    fields, then Save.

---

## 2. Set Site URL + redirect URLs

**Dashboard → Authentication → URL Configuration**

- **Site URL**: your production Vercel URL, e.g. `https://steermoney.vercel.app`
- **Redirect URLs** (add both):
  - `https://steermoney.vercel.app/**` (your actual production URL)
  - `http://localhost:3000/**`

---

## 3. Deploy the code branch

Deploy `supabase-auth-migration` (or whatever it's merged into) to
production — the Supabase-Auth sign-in/sign-up pages, middleware, and
provider need to be live before anyone can sign up.

Confirm these env vars are set in Vercel (production):
- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` (or `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`)
- `SUPABASE_SERVICE_ROLE_KEY`
- (Clerk env vars can stay for now — remove only after step 8.)

---

## 4. Sign up as israelhhh2@gmail.com

Visit the deployed app, sign up fresh with `israelhhh2@gmail.com` (email/password
or "Continue with Google" — either works, both land in the same
`auth.users` table).

---

## 5. Get the new UUID

**Dashboard → SQL Editor**, run:

```sql
select id, email from auth.users;
```

Copy the `id` (a UUID) for the `israelhhh2@gmail.com` row.

---

## 6. Run the migration script

Open `supabase/clerk-to-supabase-migration.sql`, find this line near the top
of the `do $migration$` block:

```sql
new_id text := '<<PASTE_NEW_UUID_HERE>>';
```

Replace `<<PASTE_NEW_UUID_HERE>>` with the UUID from step 5 (keep the quotes),
e.g.:

```sql
new_id text := 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
```

Paste the **entire file** into the SQL Editor and run it. It:
- deletes every other user's data (personal rows, owned workspaces, admin
  and membership rows, feedback),
- remaps every row that belongs to the old Clerk id (`user_3H3fpmzHTG9CRHSmeshmJVCq3zc`)
  over to the new UUID,
- prints a `NOTICE` row-count report per table,
- raises an exception (rolling back everything) if any row anywhere still
  references the old Clerk id when it's done.

Check the **Results/Logs** panel for the `NOTICE` lines — you should see
non-zero counts for `debts`, `transactions`, etc. under the new UUID, and the
final line `migration complete: ... zero rows remain under the old Clerk id`.

If it raises an exception instead, nothing was changed (single transaction) —
read the error, fix the cause, and re-run. The script is idempotent, so
re-running after a partial failure is safe.

---

## 7. Verify checklist

Sign in as `israelhhh2@gmail.com` and confirm:

- [ ] **Transactions** tab shows the existing transaction history
- [ ] **Debts** tab shows the existing debts + payment history
- [ ] **Budgets / Recurring / Goals / Accounts** all show existing data
- [ ] **Shared spaces** (Settings → Shared spaces) still lists any space
      Israel owned before the cutover, with its data intact
- [ ] **Admin tab is visible** (confirms `admins` table has a row for the
      new UUID, not the old Clerk id)
- [ ] Plaid-connected banks (if any) still show up and sync (confirms
      `plaid_items.user_id` was remapped)
- [ ] No console errors referencing `user_3H3fpmzHTG9CRHSmeshmJVCq3zc`

If anything looks wrong, restore from the step 0 backup and investigate
before retrying.

---

## 8. Delete the Clerk application

Once step 7 is fully green and you've used the app for a bit without issues:

- Clerk Dashboard → your app → Settings → Delete application.
- Remove the Clerk env vars from Vercel (`NEXT_PUBLIC_CLERK_*`,
  `CLERK_SECRET_KEY`, etc.) and redeploy.
- Remove the `@clerk/*` packages from `package.json` if the code sweep
  (removing Clerk hooks from `src/`) is complete.
