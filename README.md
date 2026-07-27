# SteerMoney

Steer your money to financial freedom. Debts, budgets, recurring bills, transactions,
charts and payoff simulators, with Clerk sign-in and Supabase storage (per-user RLS).

Next.js 15 (App Router) · JSX · Tailwind · Recharts · Clerk · Supabase

## Local setup

### 1. Supabase tables
Supabase project → SQL Editor → run `supabase/schema.sql`
(creates debts, payments, budgets, recurring, transactions, settings, all with
row-level security keyed to the Clerk user id). If the linter warns about RLS,
choose **Run and enable RLS**: the script enables it inside a DO block the linter
cannot see.

Then run `supabase/admin.sql` to create the `admins` table and the read-all
policies that power the admin portal. Put your own Clerk user id in it.

### 2. Clerk ↔ Supabase
Supabase must trust Clerk's session tokens:
1. Clerk Dashboard → **Configure → Integrations → Supabase** → activate, copy the Clerk domain.
2. Supabase → **Authentication → Sign In / Providers → Third-Party Auth** → **Add provider → Clerk** → paste the domain.

### 3. Environment
```bash
cp .env.local.example .env.local
```
- `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` / `CLERK_SECRET_KEY` from Clerk → API Keys
- `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` from Supabase → Project Settings → API
  (the new-style `sb_publishable_...` key goes in `ANON_KEY`; never use the secret key here)

### 4. Run
```bash
npm install
npm run dev
```

## Deploying to production (Vercel)

1. **Push this repo to GitHub** (private recommended).
2. **Vercel** → New Project → import the repo. Framework auto-detects as Next.js.
3. **Environment variables** in Vercel → Settings → Environment Variables. Add the same
   four keys from `.env.local`, but use the **production** Clerk keys (see next step).
4. **Clerk production instance**: Clerk Dashboard → top-left environment switcher →
   **Production**. It requires a domain you own and a few DNS records (Clerk shows
   exactly which). Copy the `pk_live_` / `sk_live_` keys into Vercel.
5. **Point Supabase at the production Clerk domain**: Supabase → Authentication →
   Third-Party Auth → update (or add) the Clerk provider with the production domain
   (e.g. `https://clerk.yourdomain.com`). Keep the dev one if you still develop locally.
6. Deploy.

### Gotcha: user ids change between Clerk environments
Clerk's development and production instances have **separate user pools**. Your
production account gets a **new user id**, so data written under the dev id will not
be visible, and your `admins` row will not match. After signing in to production once:

```sql
-- make the production account an admin
insert into admins (user_id) values ('user_NEW_PRODUCTION_ID');

-- optional: move existing rows from the dev account to the production one
update debts        set user_id = 'user_NEW' where user_id = 'user_OLD';
update payments     set user_id = 'user_NEW' where user_id = 'user_OLD';
update budgets      set user_id = 'user_NEW' where user_id = 'user_OLD';
update recurring    set user_id = 'user_NEW' where user_id = 'user_OLD';
update transactions set user_id = 'user_NEW' where user_id = 'user_OLD';
update settings     set user_id = 'user_NEW' where user_id = 'user_OLD';
```

## How it works

- `src/views/` — the 8 pages (Dashboard, Debts, Recurring, Budgets, Charts, Simulator,
  Transactions, Admin)
- `src/app/` — App Router: `/home` is the public landing page, everything else is
  behind Clerk auth via `src/middleware.js`
- `src/store.jsx` — `useApp()`: loads a user's rows once, caches them in localStorage for
  instant loads on new tabs, then diff-syncs edits (debounced 400 ms). A "Sync failed"
  badge appears in the header if a write fails.
- `src/lib/wescom.js` — Wescom CSV import: parses the bank's History export,
  auto-categorizes (learning from past transactions first, keyword rules second),
  and flags duplicates. Other banks would each get their own parser here.
- `src/lib/reminders.js` + `src/components/reminders.jsx` — payments due in 7 days,
  with optional browser notifications
- Admin portal (`/admin`) — read-only view of every customer plus "View as" support
  mode. Gated by the `admins` table, enforced by RLS, not just the UI.

New accounts start empty (default spending categories only) and get a two-step
onboarding: language + profile, then tips.
