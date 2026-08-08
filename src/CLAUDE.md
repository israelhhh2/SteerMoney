# SteerMoney — Claude Session Notes

> **Claude: read this file FIRST every time you touch this project. Update the
> "Session Log" at the bottom before ending any session.**

## Operating rules

- **Fable is always the PM.** The main (Fable) model plans, coordinates, and
  reviews. It does not grind through bulk implementation itself.
- **Sonnet agents do the work.** Delegate exploration, implementation, and
  verification to Sonnet subagents (`model: sonnet`), run in parallel when
  independent. Fable reviews their output before accepting.
- Keep Israel's preference: concise, direct communication.

## Project snapshot

Next.js (App Router, JS/JSX) personal-finance app.
- **Auth:** Clerk (`middleware.js`, ClerkProvider in `app/layout.jsx`)
- **DB:** Supabase Postgres. Client via Clerk-authed `lib/supabase.js`;
  server-only admin client in `lib/plaid-server.js` (service role — only thing
  allowed to touch `plaid_items`, which has RLS with no policies).
- **State:** single context in `store.jsx` — localStorage cache + debounced
  diff-sync to Supabase. Tables: debts, payments, budgets, recurring,
  transactions, goals, accounts, settings, workspaces/invites, plaid_items.
- **Views:** `views/*.jsx` (Dashboard, Accounts, Debts, Budgets, Goals,
  Charts, Simulator, Transactions, Settings, Admin). UI primitives in
  `components/ui/`.
- `seed.json` = manual seed data (debts/budgets/transactions), NOT Plaid mock.

## Plaid integration (current state — sandbox, working; production code done)

- `lib/plaid-server.js` — Plaid client; `PLAID_ENV` defaults to `sandbox`;
  `plaidConfigured` gate → routes 503 if creds missing. `getAppUrl(req)`
  resolves the app's base URL (NEXT_PUBLIC_APP_URL → VERCEL_URL → request
  Host header → null) for building `redirect_uri`/`webhook` params.
- `lib/plaid-sync.js` — `syncPlaidItem(item)` (per-item transactionsSync
  cursor loop + upsert + balance refresh, extracted so both the sync route
  and the webhook route share one implementation) and `setItemStatus(rowId,
  status)` (defensive against a missing `status` column).
- `lib/plaid-client.js` — client-side `exchangeAndSync()` shared by
  `connect-bank.jsx` and `app/(app)/plaid-oauth/page.jsx` so both onSuccess
  paths behave identically; `PLAID_LINK_TOKEN_KEY` sessionStorage key used to
  survive the OAuth redirect round-trip.
- `app/api/plaid/link-token` — linkTokenCreate; products `['transactions']`,
  US; passes `redirect_uri`/`webhook` when `getAppUrl()` resolves; accepts
  `{ item_id }` in the POST body for update-mode (re-auth) link tokens
  (ownership verified against the signed-in Clerk user).
- `app/api/plaid/exchange` — public_token → access_token, stores row in
  `plaid_items` (token never sent to client). Unchanged this round — update
  mode doesn't call this (no new access_token is issued).
- `app/api/plaid/sync` — thin wrapper looping `syncPlaidItem()` over this
  user's items.
- `app/api/plaid/items` — GET list (now includes `status`, defensive if the
  column isn't migrated) / DELETE (itemRemove + row delete) / PATCH (sets
  `status`, used by the update-mode re-auth flow to clear `reauth_required`
  back to `ok`).
- `app/api/plaid/webhook` (new) — public route (see middleware.js), verifies
  Plaid's JWT (`plaid-verification` header, ES256, via dynamic `jose`
  import — needs `npm install jose`, unconfirmed as a dependency this
  session; falls back to a shape+known-item_id check and logs loudly if
  `jose` isn't available) then handles `SYNC_UPDATES_AVAILABLE` (runs
  `syncPlaidItem`), `ITEM_LOGIN_REQUIRED`/`PENDING_EXPIRATION`/`ERROR` (sets
  `status='reauth_required'`), `USER_PERMISSION_REVOKED` (sets
  `status='revoked'`). Always resolves fast; verification failures on an
  unrecognized payload return 401, everything else 200.
- `app/(app)/plaid-oauth/page.jsx` (new) — OAuth redirect landing page: reads
  the link_token from sessionStorage, reopens Plaid Link with
  `receivedRedirectUri`, runs the same `exchangeAndSync()` on success, then
  routes to `/accounts`.
- Client: `components/connect-bank.jsx` (react-plaid-link). Consumers:
  Accounts.jsx, Debts.jsx (fuzzy match via `lib/finance.js`), Settings.jsx
  (also has `FixConnectionButton` — update-mode re-auth UI, shown when an
  item's status is `reauth_required`/`revoked`).

## Production roadmap (Plaid)

Ordered; check off as done.

- [ ] **1. Plaid production access** — apply in Plaid Dashboard (company info,
      use case, security questionnaire). Approval can take days–weeks; start now.
      Optionally use **Limited Production / Development** tier first.
- [ ] **2. Env switch** — set `PLAID_ENV=production` + production
      `PLAID_CLIENT_ID`/`PLAID_SECRET` in hosting env (Vercel). Never client-side.
- [x] **3. OAuth support** — code-complete (needs dashboard config). See
      2026-08-08 session log entry.
- [x] **4. Webhook route** — code-complete (needs dashboard config + `npm
      install jose`). See 2026-08-08 session log entry.
- [x] **5. Update mode (re-auth)** — code-complete. See 2026-08-08 session
      log entry.
- [ ] **6. Encrypt access tokens at rest** — currently plaintext in
      `plaid_items.access_token` (service-role only, but encrypt anyway:
      pgsodium/pgcrypto or app-level AES with a KMS/env key).
- [ ] **7. Background sync** — cron (Vercel cron or Supabase scheduled
      function) as fallback to webhooks; store per-item sync status/errors.
- [ ] **8. Verify DB migration applied** — `supabase/plaid.sql` (repo root,
      outside src/) actually run against prod DB; RLS on `plaid_items` confirmed.
- [ ] **9. Hardening** — rate limiting on plaid routes, error states in UI
      (item error badge), handle pending transactions or accept the gap,
      monitoring for failed syncs.
- [ ] **10. Nice-to-have** — add `liabilities` product to auto-fill APR/min
      payment/due date on Debts (replaces fuzzy matching guesswork).

Costs note: production Plaid is pay-per-item/product — check current pricing
before flipping the switch.

## Session log (newest first)

### 2026-08-08
- **Plaid production-readiness code: roadmap items 3, 4, 5** (Sonnet worker).
  Plaid production access was approved; this is the code those roadmap items
  called for, written to degrade to today's exact sandbox behavior whenever
  the required config isn't present yet (no APP_URL → no redirect_uri/webhook,
  no `jose` → defensive fallback verification, no `status` column → treated
  as `'ok'`/skipped).
  - **Item 3 (OAuth redirect support):** `app/api/plaid/link-token/route.js`
    now passes `redirect_uri: ${APP_URL}/plaid-oauth` (and `webhook`, see
    item 4) whenever `getAppUrl(req)` (new, in `lib/plaid-server.js`)
    resolves an app URL — priority `NEXT_PUBLIC_APP_URL` env → `VERCEL_URL`
    → the request's own Host header → `null` (omitted entirely). New
    `lib/plaid-client.js` holds `exchangeAndSync()` (the exchange+sync
    sequence) and the `PLAID_LINK_TOKEN_KEY` sessionStorage key, shared by
    `components/connect-bank.jsx` (now persists the link_token to
    sessionStorage right before Link opens) and the new
    `app/(app)/plaid-oauth/page.jsx` (reads that token back, reopens Link
    with `receivedRedirectUri: window.location.href`, auto-opens on ready,
    routes to `/accounts` on success, shows a clear "couldn't find your
    session" state if sessionStorage is empty).
  - **Item 4 (webhook route):** new `app/api/plaid/webhook/route.js` (POST,
    unauthenticated — added to `middleware.js`'s public matcher since Plaid
    calls it server-to-server). Verifies the `plaid-verification` JWT
    (ES256) via `plaidClient.webhookVerificationKeyGet` + a dynamic `import('jose')`
    wrapped in try/catch (jose's presence as a dependency couldn't be
    confirmed — package.json is outside the mounted `src/` root); if
    verification can't run, falls back to a shape check + confirming the
    `item_id` exists in `plaid_items` before proceeding, and logs loudly
    either way. Handles `SYNC_UPDATES_AVAILABLE` (runs the new
    `syncPlaidItem()` helper), `ITEM_LOGIN_REQUIRED`/`PENDING_EXPIRATION`/
    `ERROR` (→ `status='reauth_required'`), `USER_PERMISSION_REVOKED` (→
    `status='revoked'`). Always 200 except a genuine verification failure
    (401). Extracted the per-item sync loop out of
    `app/api/plaid/sync/route.js` into `lib/plaid-sync.js`
    (`syncPlaidItem(item)`, `setItemStatus(rowId, status)`) so the sync route
    and the webhook route share one implementation instead of duplicating
    the upsert/balance-refresh code — the sync route is now a thin loop over
    it, byte-identical behavior to before.
  - **Item 5 (update mode / re-auth):** `link-token` route accepts an
    optional `{ item_id }` JSON body — looks up that `plaid_items` row,
    verifies `user_id` matches the signed-in Clerk user, and creates the
    link token with `access_token` (update mode) instead of `products`.
    `app/api/plaid/items/route.js` GET now selects/returns `status`
    (defaulting to `'ok'` if the column or its value is missing) and gained
    a PATCH handler (`{ item_id, status }`) for flipping it back after a
    successful re-auth. `views/Settings.jsx`'s Connected Banks list shows an
    amber "Needs attention" / red "Access revoked" badge and swaps the
    "Sync now" button for a new `FixConnectionButton` when
    `status !== 'ok'` — fetches an update-mode link token, opens Plaid Link
    directly (a second, narrower `usePlaidLink` usage; not routed through
    `ConnectBankButton` since update-mode's onSuccess is genuinely different
    — no new access_token is issued, so there's nothing to exchange, just a
    PATCH back to `'ok'` + a normal sync).
  - **Manual steps for Israel (nothing above works end-to-end without
    these):**
    1. Register `https://steer-money-nine.vercel.app/plaid-oauth` in Plaid
       Dashboard → Team Settings → API → Allowed redirect URIs (or whatever
       the final custom domain is, if that lands first).
    2. Confirm/whitelist the webhook URL
       `https://steer-money-nine.vercel.app/api/plaid/webhook` — Plaid
       doesn't require pre-registration the way redirect URIs do, but
       double-check it's reachable (not blocked by any auth/proxy) once
       deployed — `curl -X POST .../api/plaid/webhook -d '{}'` should return
       200, not a Clerk redirect/401.
    3. Set Vercel env vars: `PLAID_ENV=production`, production
       `PLAID_CLIENT_ID`/`PLAID_SECRET` (never client-side), and
       `NEXT_PUBLIC_APP_URL=https://steer-money-nine.vercel.app` (or the
       custom domain) — without the last one, `getAppUrl()` falls back to
       `VERCEL_URL`/request Host, which usually works on Vercel but is worth
       setting explicitly so OAuth/webhook URLs don't silently point at a
       preview-deployment URL.
    4. Run the two outstanding migrations against the prod DB (both written
       defensively into the code above, so nothing breaks if these are
       delayed — sync/webhook just silently skip the new columns until
       then):
       - `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id text;`
         (already noted in the 2026-08-05 (2) entry below, still outstanding)
       - `ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS status text
         DEFAULT 'ok';`
    5. `npm install jose` (webhook JWT verification needs it — see item 4
       above; the route works without it via the defensive fallback, but
       that fallback is not cryptographic verification).
  - **Left off / not verified:** nothing here ran against a real Plaid
    sandbox/production webhook or an actual OAuth bank (no dev server, no
    npm installs, per standing instructions) — the JWT verification path,
    the `receivedRedirectUri` handoff, and the update-mode Link flow are
    all implemented to spec but unexercised. Prioritize a real end-to-end
    test (sandbox OAuth institution + Plaid's webhook test endpoint) before
    trusting this in production.

### 2026-08-05 (3)
- **Per-account detail pages + Notion-style modal navigation** (Sonnet
  worker). Clicking a specific credit-card row on the Dashboard, or an
  account row on Accounts, now opens *that account's* detail instead of the
  top of `/debts`.
  - **`lib/accounts.js`** (new): extracted the merged-inventory logic that
    used to live inline in `Accounts.jsx` (series/history math, the
    Credit cards/Loans/Depository builder, `accountHistorySeries`,
    `pctChange`/`pctChange30`, `matchesBankAccount`-based Plaid dedup) into
    `buildAccountInventory(state, plaidItems)` plus a shared
    `usePlaidItems()` fetch hook, so `Accounts.jsx` and the new
    `AccountDetail.jsx` build the identical list instead of duplicating ~200
    lines. Added the canonical, URL-safe id: Plaid accounts → their
    `account_id`; manual debts/accounts → `debt_<id>` / `acc_<id>`
    (`accountUrlId(row)`, `debtUrlId(id)`, `manualAcctUrlId(id)`,
    `findAccountByUrlId(id, state, plaidItems)` for the reverse lookup).
  - **`views/AccountDetail.jsx`** (new): the Copilot-style detail content —
    centered `CardChip size="lg"`, name, 3 stat columns (BALANCE/LIMIT/
    UTILIZED or AVAILABLE/CURRENT/CHANGE), balance-history `AreaChart` with
    its own 1W/1M/3M/YTD/1Y pills, "Latest update received…" line, a
    Manage/Edit action, and that account's own transactions inline (grouped
    by date, capped at 60 rows, "View all in Transactions ›" for Plaid
    accounts). Manual accounts have no `account_id` so they show a muted
    "don't have linked transactions" empty state instead of a broken filter.
    Used byte-identical in both the full page and the modal (see below).
  - **`app/(app)/accounts/[id]/page.jsx`** (new): standalone full page — "←
    Back" button (`router.back()`, falls back to `/accounts` if there's no
    history to pop) + `<AccountDetail>`.
  - **Notion-style popup**: `app/(app)/@modal/default.jsx` (returns null) +
    `app/(app)/@modal/(.)accounts/[id]/page.jsx` (intercepting route — same
    `/accounts/[id]` URL, rendered as a dim-backdrop overlay: bottom sheet on
    mobile, centered panel ≥sm, X button + backdrop click + Esc → 
    `router.back()`, "Open full page ↗" does a hard
    `window.location.assign` since a `router.push` to the same URL would just
    hit the interceptor again). `app/(app)/layout.jsx` now takes a `modal`
    prop and renders it inside `Frame` alongside `children`. Net effect:
    clicking a row from Dashboard/Accounts pops the overlay in place (URL
    changes under it); refreshing or opening that URL directly renders the
    real full page.
  - **Rewired click targets**: Dashboard's Credit Cards card no longer wraps
    the whole `Card` in one `<Link href="/debts">` (that made per-row links
    impossible — nested `<a>`s); the card header now carries `href="/debts"`
    via `SectionHead`, and each row is its own `<Link href="/accounts/{debtUrlId(d.id)}">`.
    `Accounts.jsx`'s `CardRow`/`LoanRow`/`DepositoryRow` swapped their
    `onClick`-opens-Sheet behavior for `<Link href="/accounts/{accountUrlId(a)}">`
    — the modal now plays the old bottom-sheet's role, so `AccountSheet` and
    its `selected` state were deleted from `Accounts.jsx`.
  - **`/accounts?edit=<id>`**: added so `AccountDetail`'s "Edit account"
    button (manual accounts only) can reuse the existing `AccountDialog`
    instead of re-implementing an edit form — `app/(app)/accounts/page.jsx`
    now reads the query param via `useSearchParams` (wrapped in `Suspense`,
    matching the existing `transactions/page.jsx` pattern) and `Accounts.jsx`
    opens the dialog once, then clears the param.
  - `components/ui/sheet.jsx` is now unused. Tried to delete it outright but
    the sandboxed filesystem this session ran in only allowed rename, not
    unlink (`rm` returned "Operation not permitted" on an owned file in a
    FUSE mount) — it's renamed to `components/ui/sheet.jsx.bak` so nothing
    imports it; **someone with normal shell access should just delete that
    `.bak` file** next time they're in the repo.
  - **Left off / risks**: none of this ran in a dev server (per
    no-npm-installs/no-dev-server instruction) — needs a real browser check:
    the intercepting-route modal specifically (never verified parallel +
    intercepting routes actually resolve against this project's installed
    Next.js version — couldn't find `package.json`, it's outside the mounted
    `src/` root), the bottom-sheet-on-mobile / centered-panel-on-desktop CSS
    at a real ~390px viewport, and that `router.back()` from the modal lands
    back on Dashboard/Accounts rather than skipping past them. Also: the
    modal's `usePlaidItems()` fires its own `/api/plaid/items` fetch
    independent of the page underneath it (harmless double-fetch, not
    deduped — fine for now, worth a shared cache later if it's ever
    noticeable).

### 2026-08-05 (2)
- **Accounts page rebuilt as a faithful Copilot Money clone** (Sonnet worker,
  full read-then-rewrite of `views/Accounts.jsx`). Net-worth header card:
  Assets/Debt stat columns with red/green % pills, smooth glowing
  Assets(blue)/Debt(orange) `AreaChart` with end-point dots, 1W/1M/3M/YTD/1Y
  range pills (reused `Segmented`). Collapsible sections (Credit cards, Loans,
  Depository) built from a merged inventory: manual `state.debts`/
  `state.accounts` + unmatched Plaid accounts from `/api/plaid/items` (dedup
  via the existing `matchesBankAccount`/`acctKey` logic). Credit-card rows
  show BALANCE/LIMIT/UTILIZED or an amber "Credit limit needed" pill when no
  limit is known (Plaid doesn't give us a credit limit today — `liabilities`
  product, roadmap item 10, would fix this). Depository rows show
  AVAILABLE/CURRENT/CHANGE — "available" isn't actually stored by the sync
  route (only `balances.current`), so it currently falls back to CURRENT;
  flagged as a data limitation, not faked.
  Extracted Dashboard's local credit-card chip into `components/shared.jsx`
  as `CardChip`/`cardHue` (generalized with institution/mask/size; Dashboard
  now passes `size="dash"` and renders byte-identical to before).
  New `components/ui/sheet.jsx` (Radix Dialog-based bottom sheet, centered
  dialog on ≥sm) powers the account detail view: chip, name, 3 stats,
  balance-history `AreaChart` with its own range pills, "Latest update
  received {relative time}" (or "Manual account"), "View transactions" /
  "Manage connection" (or "Edit account" for manual rows, opening the
  existing `AccountDialog`) buttons.
  **Data limitation — balance history for Plaid accounts:** no per-account
  history is stored, so the sheet derives one by walking backward from the
  current balance using that account's own transactions
  (`accountHistorySeries` in Accounts.jsx); falls back to a flat line at the
  current balance if no transactions are in range. Never synthetic/random
  data.
- **Transactions ↔ Accounts linkage**: `transactions` had no account
  linkage at all. Added `account_id` to the upsert in
  `app/api/plaid/sync/route.js` (Plaid tx objects carry it), with a
  defensive fallback retry (strips `account_id` and re-upserts) if the
  column doesn't exist yet on `public.transactions` — **so this needs a
  migration**: `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id
  text;` (or add it to `supabase/plaid.sql`), otherwise every sync silently
  falls back to not storing it. `store.jsx`'s transactions mapper now passes
  `accountId`/`account_id` through in both directions, but only when the key
  is actually present — omitting it entirely otherwise — so normal
  (non-Plaid) transaction saves are unaffected either way.
  `/transactions` now reads a `?account=` query param (Plaid `account_id`) —
  wired in `app/(app)/transactions/page.jsx`, filtered in
  `views/Transactions.jsx` against `t.accountId`, with a removable pill chip
  (fetches `/api/plaid/items` to resolve a mask for the label). The
  Accounts detail sheet's "View transactions" button links to
  `/transactions?account={plaid_account_id}`; manual accounts/debts with no
  Plaid link go to plain `/transactions` (filtering by mask wouldn't match
  anything real, so it's skipped rather than showing a chip that always
  finds zero transactions).
- **Left off:** none of this was run in a dev server (per no-npm-installs/
  no-dev-server instruction) — needs a real browser check, especially the
  sheet on an actual ~390px viewport and the AreaChart glow/dot rendering.
  Also worth deciding whether to run the `account_id` migration now or
  leave the sync route's fallback carrying the load for a while.

### 2026-08-05
- **Plaid production application (roadmap item 1) filled out and submitted**:
  products Transactions + Liabilities, use case "Personal budgeting and
  financial advice". Security questionnaire answered honestly (MFA on all
  admin systems: Vercel/Supabase/GitHub/Plaid; consumer MFA = No for now,
  Clerk gates it behind Pro $25/mo — revisit later; Dependabot enabled for
  vuln management). Wrote `Information-Security-Policy.docx` (in src/, also
  attached to Plaid app: infosec, access controls, retention questions).
- **Privacy policy shipped**: `app/privacy/page.jsx` (public route added to
  `middleware.js` matcher, footer link on /home). Live at
  https://steer-money-nine.vercel.app/privacy — used for Plaid Q9.
- Second overflow fix: root cause was grid items defaulting to
  `min-width:auto` — the bottom-widget Cards themselves grew past the
  viewport. Added `min-w-0` on the Cards + header rows, `shrink-0
  whitespace-nowrap` on amounts/badges. Added empty state to "This Month by
  Category" donut ("Nothing recorded in this period.").
- **Copilot-inspired dashboard redesign + clickable cards**: all dashboard
  cards/tiles Link to their pages (income/spending→/charts, debt→/debts,
  fixed→/recurring, due-14d→/recurring, credit cards→/debts,
  budgets→/budgets, category→/charts); Segmented pills stopPropagation.
  Visuals: superscript-$ `Money` hero numbers, uppercase micro-labels,
  `CardChip` gradient credit-card visuals, slim `Bar thin`, scrollable
  Segmented pills, bar-chart glow. Files: Dashboard.jsx, shared.jsx
  (SectionHead href/total/chevron, Kpi href, Bar thin — all opt-in,
  backward compatible), ui/segmented.jsx (scroll mode + stopPropagation).
- **Left off:** redesign untested in browser (desktop Chrome couldn't shrink
  to 390px for verification). User to deploy + verify on phone. Remaining
  roadmap: items 2-10 (env switch pending Plaid approval; webhook route and
  OAuth support can be built now).

### 2026-08-04
- Fixed mobile horizontal-overflow bug (viewport ~390-430px): several flex
  rows (label + right-aligned value, or badge lists) had no `min-w-0` on the
  shrinkable child, so long labels forced the row wider than the viewport and
  the whole `<body>` panned right instead of the label truncating in place.
  Added `overflow-x: hidden` to `html, body` in `globals.css` as a backstop,
  then added `min-w-0` (+ `flex-1`) to the label/name span in every affected
  row: Dashboard.jsx (Due in 14 days, Credit Cards, Budgets rows, category
  legend, per-month cash-flow row), Debts.jsx (DebtCard title row — this was
  also what freed the APR/min/due-day/% pill row to wrap correctly and
  stopped the balance amount from getting pushed off-screen — plus the
  minimums breakdown, payoff order, and payment-history rows), Budgets.jsx
  (list row's name column changed from a fixed `w-32` to `min-w-0 flex-1`
  on mobile, `sm:w-44 sm:flex-none` back to the original fixed width at
  desktop widths — the fixed width alone was wider than an iPhone viewport
  once the mobile font-size clamp in globals.css scales rem-based widths up),
  Transactions.jsx, Simulator.jsx, Charts.jsx, Admin.jsx. Also removed
  `whitespace-nowrap` from `MoneyTile` (shared.jsx, used by Dashboard's Cash
  Flow tiles) and added `min-w-0` to its button, since it sat in a
  `grid-cols-3` row where nowrap text could exceed the grid track. Goals.jsx,
  Recurring.jsx, and Accounts.jsx already used the correct `min-w-0 flex-1`
  pattern — no changes needed there.
- **Left off:** no dev server was started per instructions; changes are
  untested in a real browser. Next session should sanity-check on an actual
  ~390px viewport (or browser devtools) before considering this closed.

### 2026-08-01
- Created this file. Established Fable-PM + Sonnet-workers protocol.
- Sonnet Explore agent surveyed full codebase; confirmed Plaid integration is
  real sandbox code (not mock data). Findings folded into sections above.
- **Left off:** production roadmap defined, nothing started. Next step is
  applying for Plaid production access (item 1) and building the webhook
  route (item 4) since it needs no approval to write.
