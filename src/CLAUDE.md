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
  status)` (defensive against a missing `status` column). Stores pending
  transactions too (not filtered out), and categorizes via
  `lib/plaid-categories.js`'s `mapPlaidCategory()` (Plaid's
  `personal_finance_category`, not just name-keyword guessing). See
  2026-08-08 (5) session log entry.
- `lib/plaid-categories.js` — `mapPlaidCategory(tx, fallback)` maps Plaid's
  `personal_finance_category` (primary/detailed) onto this app's category
  ids (`housing`, `groceries`, `dining`, `auto`, `utilities`, `debt`,
  `income`, `transfer`, `other`). See 2026-08-08 (5).
- `lib/plaid-client.js` — client-side `exchangeAndSync()` shared by
  `connect-bank.jsx` and `app/(app)/plaid-oauth/page.jsx` so both onSuccess
  paths behave identically; `PLAID_LINK_TOKEN_KEY` sessionStorage key used to
  survive the OAuth redirect round-trip.
- `app/api/plaid/link-token` — linkTokenCreate; products `['transactions']`,
  US; requests `transactions: { days_requested: 730 }` (Plaid's max) on new
  connections so a fresh Item backfills as much real history as the
  institution allows, not the 90-day default (see 2026-08-08 (5); only set
  on the new-connection branch — update mode can't change history depth on
  an Item that already has Transactions added); passes `redirect_uri`/
  `webhook` when `getAppUrl()` resolves; accepts `{ item_id }` in the POST
  body for update-mode (re-auth) link tokens (ownership verified against the
  signed-in Clerk user).
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

### 2026-08-08 (7)
- **"View all in Transactions" left the account modal open over the new
  page** (Fable): it was a `<Link>` soft nav; navigating to a
  non-intercepted route doesn't reset the `@modal` parallel slot (Next
  keeps the slot's previous content mounted), so /transactions rendered
  underneath the still-open overlay. Converted to a hard
  `window.location.assign(txHref)` button — same pattern as "Manage
  connection" (2026-08-08 (6) Bug 2).
- **Disconnect didn't refresh the Accounts list** (Fable, 1-line fix):
  `views/AccountDetail.jsx`'s Plaid disconnect ended in `router.push('/accounts')`,
  but Accounts fetches `/api/plaid/items` once on mount (`usePlaidItems`), so
  the just-disconnected bank kept rendering until a manual refresh. Replaced
  with `setTimeout(() => window.location.assign('/accounts'), 900)` — hard
  navigation (matches every other connect/disconnect path's reload pattern),
  delayed so the "disconnected" centerToast is visible first.
- **Production status this session:** Plaid production fully working
  end-to-end (link → exchange → sync verified live with Wescom). Root causes
  fixed today, in order: env-var race with redeploys; duplicate hidden Plaid
  Link iframes eating clicks; missing `SUPABASE_SERVICE_ROLE_KEY` in Vercel
  (the persistent "Plaid is not configured yet" — exchange/items routes gate
  on `supabaseAdmin`). Clerk is still on DEV keys in production (console
  warning) — needs production Clerk instance before real users.
- Migrations still outstanding on prod DB (run in Supabase SQL editor):
  `ALTER TABLE transactions ADD COLUMN IF NOT EXISTS account_id text;` and
  `ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS status text DEFAULT 'ok';`

### 2026-08-08 (6)
- **Three production UX bugs fixed** (Sonnet worker): an invisible/frozen
  confirm dialog over the account modal, a dead "Manage connection" button,
  and lingering native `confirm()` dialogs.
  - **Bug 1 — ConfirmDialog invisible over the @modal account overlay.**
    Root cause confirmed by tracing z-index/DOM order, not guessed: the
    Notion-style intercepting-route overlay
    (`app/(app)/@modal/(.)accounts/[id]/page.jsx`) is an always-mounted
    `fixed inset-0 z-[60]` div rendered directly in the React tree (inside
    `Frame` in `app/(app)/layout.jsx`, via the `{modal}` slot) — it is *not*
    a Radix portal. `components/ui/dialog.jsx`'s `DialogContent` **is** a
    Radix `Portal`, so it always mounts as a fresh child appended straight
    onto `document.body`, as a sibling — at the browser's root stacking
    context — of that `z-[60]` modal div. Both `DialogOverlay` and
    `DialogContent` were `z-50`. Since 50 < 60, the modal's opaque
    `bg-black/70 backdrop-blur` div painted **on top of** the fully-open,
    `opacity:1`, `data-state=open` Radix dialog every time — hence "clicking
    the invisible button via JS works, paint doesn't." This only showed up
    for confirms triggered *outside* another already-open Dialog (i.e. from
    `AccountDetail.jsx`, used both standalone and inside `@modal`) — the
    pre-existing Budgets/Goals/Accounts "delete" flows nest a `ConfirmDialog`
    *inside* an already-open edit `Dialog`, so both were `z-50` siblings
    appended back-to-back and resolved correctly via DOM order alone; there
    was no `z-[60]` sibling in that case to lose to.
    **Fix:** bumped `components/ui/dialog.jsx`'s `DialogOverlay` to
    `z-[65]` and `DialogContent` to `z-[70]` (both still above the
    `@modal`'s `z-[60]`, and `Content` above `Overlay` as before). Bumped
    `components/toast.jsx`'s `centerToast` div from `z-[70]` to `z-[80]` so
    it still paints above the now-higher dialog (a `centerToast` call often
    fires in the same tick a `ConfirmDialog` closes). Corner toasts left at
    `z-[60]` (untouched, not implicated — they're appended after the modal
    in DOM order inside `ToastProvider`, so ties already resolved in their
    favor; not part of this bug).
    **Final z-index ladder (low → high):** `@modal` backdrop+panel
    `z-[60]` < `ui/dialog.jsx` `DialogOverlay` `z-[65]` <
    `ui/dialog.jsx` `DialogContent` `z-[70]` < `toast.jsx` centerToast
    `z-[80]`. (Corner toasts sit at `z-[60]`, tied with the modal but
    DOM-ordered after it — unchanged, not part of the ladder above.)
  - **Bug 2 — "Manage connection" did nothing when the modal opened over
    /settings.** `views/AccountDetail.jsx`'s Plaid "Manage connection"
    button was a plain `<Link href="/settings">`. When the account modal is
    opened while `/settings` is already the page underneath it, the URL bar
    shows `/accounts/[id]` (interception), so there's no reliable way for a
    soft client-side nav to know "the target route is already rendered
    behind you" — it just sat there, looking broken. Changed that one
    button (Plaid rows only — `/debts` and the manual-account edit link are
    untouched, not reported as broken) to `onClick={() =>
    window.location.assign('/settings')}` — an unconditional hard
    navigation. This always tears down the whole app and reloads straight
    into `/settings`, which reliably closes the modal and lands on the
    right page in both the standalone full-page and `@modal` contexts, at
    the cost of a full reload for this one, infrequent action (chosen over
    trying to detect "are we already logically on /settings" from inside
    the intercepted route, which `usePathname()` can't tell you — it
    reports the intercepting URL, not the page underneath it).
  - **Bug 3 — native `confirm()`/`alert()` still in use.** Grepped all of
    `src/**/*.jsx`; found five `confirm(` call sites (no `alert(` calls
    anywhere) and replaced every one with `components/shared.jsx`'s
    `ConfirmDialog` + a busy spinner + `components/toast.jsx`'s
    `useCenterToast()` success/error toast, matching the exact pattern
    already established in `views/Accounts.jsx`'s `AccountDialog.del` (the
    2026-08-08 (4) session): `setDeleting(true)` → deliberate `await new
    Promise(r => setTimeout(r, 350))` (these are synchronous store
    mutations; the delay makes the spinner actually visible) → mutate →
    `centerToast(...)` → close. Behavior otherwise identical (same rows
    still delete via the same store `update(fn)` mutator).
    - `views/Debts.jsx` — `DebtCard`'s "Delete" button. Moved the confirm
      state (`confirmDel`/`deleting`) and a new `handleDelete` into
      `DebtCard` itself (it owns the button); the parent `Debts` component's
      `onDelete` prop is now just `() => deleteDebt(update, d.id)` (no more
      inline `confirm()` + `toast()` in the parent). Wrapped `DebtCard`'s
      return in a fragment so the `ConfirmDialog` can render as a sibling of
      the `<Card>`.
    - `views/Transactions.jsx` — the per-row delete `X` button. Added
      `confirmDelId`/`deleting` state to the top-level component, a
      `handleDeleteTx`, and a `ConfirmDialog` rendered alongside the
      existing `TxDialog`/`ImportDialog`.
    - `views/Recurring.jsx` — same pattern, `confirmDelId` resolved back to
      the bill via `state.recurring.find(...)` (`confirmDelBill`) so the
      dialog title can show its `desc`.
    - `views/Budgets.jsx`'s `BudgetDialog` and `views/Goals.jsx`'s
      `GoalEditorDialog` — these already nest their delete confirm inside
      an already-open edit `Dialog` (same shape as `Accounts.jsx`'s
      `AccountDialog`), so converted `del()` to the same
      busy-state-then-mutate-then-centerToast shape and added a nested
      `ConfirmDialog`, gated on new local `confirmDel`/`deleting` state
      instead of firing `window.confirm()` synchronously.
  - **Left off / not verified:** no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — the z-index fix is
    reasoned from the actual DOM structure and CSS stacking rules (confirmed
    by reading every relevant file: `ui/dialog.jsx`, the `@modal` route,
    `toast.jsx`, `app/(app)/layout.jsx`), not observed live. Next session
    should reproduce the exact original repro (open an account modal, click
    Disconnect/Delete, confirm the dialog now paints and is clickable in the
    real DOM) and click through all five converted delete flows
    (debt/transaction/recurring/budget/goal) to confirm the spinner and
    centered toast both show correctly.

### 2026-08-08 (5)
- **"Connect a bank should bring all the transactions/data and populate
  everything else"** (Sonnet worker), per Israel's verbatim request. Read
  `lib/plaid-sync.js`, `app/api/plaid/link-token/route.js`, `store.jsx`
  (row↔state mapping, the once-per-userId initial load effect), and every
  view that derives from `state.transactions` (Dashboard's category donut,
  Charts, Budgets, Transactions) before changing anything.
  - **Max history (roadmap-adjacent):** `app/api/plaid/link-token/route.js`
    now sets `params.transactions = { days_requested: 730 }` (Plaid's cap)
    on the new-connection branch only — confirmed via Plaid's docs that this
    field lives at the top level of the `/link/token/create` request body
    (`transactions.days_requested`, not under `options`), and that setting
    it via `/transactions/sync` instead doesn't work once an Item already
    has Transactions initialized, which is exactly the update-mode
    (`item_id`) branch, so it's deliberately omitted there.
  - **Confirmed the existing upsert already writes every field the client's
    `mappers.transactions.fromRow` (store.jsx) expects** (id, date,
    description, amount, type, account_id) with the correct sign convention
    (amount always stored positive via `Math.abs`, direction via
    `type: 'income'|'expense'`, matching how manual transactions are
    entered in Transactions.jsx) — no mismatch found, no fix needed there.
  - **Category mapping (new): `lib/plaid-categories.js`** —
    `mapPlaidCategory(tx, fallback)` reads Plaid's `personal_finance_category`
    (confirmed via Plaid's docs that `transactionsSync` returns this by
    default, no `options` flag needed, unlike e.g.
    `include_original_description`) and maps it onto this app's *existing*
    category ids: `detailed` checked first for the primaries that straddle
    more than one app category (`RENT_AND_UTILITIES` → `housing` vs.
    `utilities` depending on rent/mortgage vs. the bill sub-types;
    `TRANSPORTATION` sub-types; groceries, which Plaid files under
    `GENERAL_MERCHANDISE` not `FOOD_AND_DRINK`), then `primary` as a coarser
    fallback (`INCOME`→`income`, `TRANSFER_IN`/`TRANSFER_OUT`→`transfer`,
    `LOAN_PAYMENTS`→`debt`, `FOOD_AND_DRINK`→`dining`,
    `TRANSPORTATION`→`auto`, `RENT_AND_UTILITIES`/`HOME_IMPROVEMENT`→
    `housing`), else `'other'`. The `income`/`transfer`/`debt` ids aren't
    guesses — `store.jsx`'s `catInfo()` already special-cases exactly those
    three non-budget ids, and every spending view (Dashboard, Charts,
    Budgets) already explicitly excludes `t.cat === 'transfer'`/`'debt'`
    from expense totals — so this mapping plugs directly into logic that
    was seemingly built anticipating this. `lib/plaid-sync.js`'s old
    keyword-regex `guessCategory()` is kept, demoted to a defensive fallback
    only used when Plaid returns no `personal_finance_category` at all.
  - **Pending transactions are no longer dropped.** `syncPlaidItem()`
    previously `.filter((tx) => !tx.pending)`'d both `added` and `modified`
    before upserting, so a charge was invisible until it fully settled.
    Removed that filter — verified this is safe without any new
    bookkeeping (no `pending` column exists or was added): when a pending
    transaction posts, Plaid either sends a `modified` entry for the *same*
    `transaction_id` with `pending: false` (upserts over the already-stored
    row) or sends the old pending id in `removed` plus a new posted
    transaction in `added` (the existing removed-handling deletes the stale
    pending row either way — a harmless no-op delete if that id was never
    stored under the old filtered behavior, a real cleanup now). `added`/
    `modified` counts returned from `syncPlaidItem()` (surfaced in the
    "Synced: N new transactions" toast) now count pending rows too.
  - **Post-connect refresh without a manual hard refresh:** traced
    `store.jsx`'s load effect — it only fetches from Supabase once per
    `userId` (`freshFor` ref), so anything that reaches `/accounts` via a
    client-side `router.push` after a sync keeps rendering the pre-sync
    state. `components/connect-bank.jsx`'s `ConnectBankButton` already
    handled this correctly for the non-OAuth path (`window.location.reload()`
    as its default `onDone`, and `Settings.jsx`'s Connected Banks list
    passes its own `onDone` that also ends in a reload) — the gap was
    `app/(app)/plaid-oauth/page.jsx`'s `handleSuccess`, which did
    `router.push('/accounts')` after `exchangeAndSync()`, landing on Accounts
    with stale data until the user refreshed by hand. Changed it to
    `window.location.assign('/accounts')` — a full navigation, remounting
    the app and re-running the load effect against the just-synced rows —
    matching the reload-based refresh every other connect path already used.
  - **Files changed:** `app/api/plaid/link-token/route.js`,
    `lib/plaid-sync.js`, `lib/plaid-categories.js` (new),
    `app/(app)/plaid-oauth/page.jsx`.
  - **Left off / not verified:** no dev server, no npm installs, nothing
    clicked in a real browser or against a real Plaid Link session (standing
    instruction) — none of this ran against sandbox or production. Next
    session should connect a real test bank and confirm: (a) the historical
    backfill actually pulls back further than 90 days (institution-dependent
    — Plaid's `days_requested` is a request ceiling, not a guarantee); (b)
    a sampling of synced transactions land in sensible categories on the
    Dashboard donut/Charts/Budgets, not all dumped into "Other"; (c) a
    pending charge shows up immediately in Transactions and cleanly
    disappears/reconciles (no duplicate) once it posts a day or two later;
    (d) the OAuth connect path (a bank that forces the redirect, e.g. Chase
    sandbox) lands on `/accounts` already showing the new transactions with
    no manual refresh. Deliberately did not add a `pending` UI indicator/
    column — out of scope for "bring the data in," flagged here in case a
    later session wants to distinguish pending from posted in the UI.

### 2026-08-08 (4)
- **Deletion feedback (spinner + centered result toast) + Settings "Danger
  zone: Erase all data"** (Sonnet worker), per Israel's verbatim request:
  "when deleting something add a little spinning thing so we know its
  working and then a toast modal in the middle saying successful or
  unsuccessful."
  - **`components/toast.jsx`**: added a second context/provider pair inside
    the existing `ToastProvider` — `CenterToastCtx` / `useCenterToast()` —
    alongside the original corner `useToast()`. `centerToast(message,
    variant)` renders a small card dead-center of the screen (`fixed inset-0
    z-[70] flex items-center justify-center`, above the corner toast's
    `z-[60]` and Radix Dialog's `z-50`, so it's visible even if it fires
    right as a `ConfirmDialog` closes): green `CheckCircle2` on success, red
    `XCircle` on error, auto-dismisses after 1.6s with a 250ms
    opacity/scale fade-out before unmounting. Kept `useToast()`'s corner
    toasts untouched and still used for routine (non-destructive)
    confirmations — `centerToast` is only wired into delete/disconnect/erase
    flows per the request, not a blanket replacement.
  - **`components/shared.jsx`**'s `ConfirmDialog` now renders a spinning
    `Loader2` in the confirm button whenever `busy=true` (previously `busy`
    only disabled the buttons and blocked backdrop/Esc close — it didn't
    change the button's contents). This is the one shared confirm dialog
    (Accounts.jsx, AccountDetail.jsx, and the new Danger Zone below all use
    it), so the spinner fix applies everywhere `busy` is already wired.
  - **`views/AccountDetail.jsx`**: `handleDelete` now calls `centerToast`
    instead of the corner `toast` for every outcome (Plaid disconnect
    success/failure, debt delete, manual account delete). The Plaid path was
    already async (`await fetch`) so `deleting`/`busy` covered it; the local
    (manual account / debt) delete path is a synchronous store mutation, so
    added a deliberate `await new Promise(r => setTimeout(r, 350))` after
    `setDeleting(true)` before doing the actual delete — otherwise the
    spinner would never be visible for an instant, in-memory mutation. Swapped
    `useToast` for `useCenterToast` (no more corner toasts fired from this
    file).
  - **`views/Accounts.jsx`**'s `AccountDialog.del` (manual account delete
    from the edit dialog): same treatment — added a `deleting` state, the
    same 350ms deliberate delay, wired `busy={deleting}` into its
    `ConfirmDialog`, and switched to `centerToast('Account deleted')` /
    `centerToast(err, 'error')`. `save()` in the same component still uses
    the corner `useToast()` for "Enter a name"/"Account updated" — those
    aren't part of this feature.
  - **`views/Settings.jsx`**: new `DangerZoneSection` (red-bordered `Card`,
    `border-destructive/40 bg-destructive/[0.04]`, matching Debts.jsx's
    destructive styling convention), rendered last on the page. "Erase all
    data" button → `ConfirmDialog` (title "Erase all data?", the exact
    warning copy requested, `confirmLabel="Erase everything"`, `busy` wired
    to a real async operation this time, not a fake delay) → `eraseAll()`:
    1. `GET /api/plaid/items`, then loops `DELETE /api/plaid/items` per
       connected bank (skipped entirely if the list is empty); failures on
       individual banks are collected but don't abort the rest of the loop
       or the data wipe.
    2. Clears every user-data slice through the single store `update(fn)`
       mutator: `s.debts = []; s.budgets = []; s.recurring = [];
       s.transactions = []; s.goals = []; s.accounts = []`. Deliberately
       does **not** touch `s.sim`/`s.mSim` (the `settings` table) or any
       workspace/space state — those are configuration, not user data, and
       out of scope per the request.
    3. `centerToast('All data erased')` on full success, or a softer
       "Data erased — one bank connection needs manual removal" message if
       only the bank-disconnect loop had a failure (the local wipe still
       ran) — otherwise a hard error toast if the wipe itself threw.
  - **Confirmed (by reading, not by running) how store.jsx's diff-sync
    handles the mass deletion**: `payments` isn't its own state slice — it's
    derived per-render from `s.debts[].payments` (see `flatPayments` in
    store.jsx) — so emptying `s.debts` also empties the derived `payments`
    rows fed into the sync effect, no separate handling needed. The sync
    effect (store.jsx, the `debounced diff sync` `useEffect`) calls
    `diffRows(prevRows[table], nextRows[table])` per table, which is a pure
    id-set diff: `deletes = prev.filter(r => !nextIds.has(r.id))`. With
    `nextRows[table] === []`, `nextIds` is empty, so **every** row that
    existed in `prev` for that table becomes a delete — confirmed this is
    exactly the mechanism, not an assumption. Deletes already run before
    upserts and in FK-safe order (`payments, transactions, budgets,
    recurring, goals, accounts, debts` — payments/children before the debts
    they reference), so this needed no changes to the sync logic itself,
    only to what Settings.jsx puts into `update(fn)`.
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — the spinner timing,
    the centered toast's fade transition, the erase-all confirm→busy→toast
    round trip, and (most importantly) an actual Supabase round-trip
    confirming the mass-delete diff really issues the DELETE statements
    against a real project are all unexercised. Next session should erase a
    disposable/test account's data for real and check the `debts` /
    `transactions` / etc. tables in Supabase directly afterward.

### 2026-08-08 (3)
- **Account deletion added to the Accounts experience** (Sonnet worker) —
  previously there was no way to delete an account from `/accounts` at all;
  deletion only existed inside the old `AccountDialog`'s edit form and on
  `Debts.jsx`'s debt cards. Deletion now also lives in `AccountDetail.jsx`
  (the per-account detail used by both the full page and the `@modal`
  intercepting overlay — see 2026-08-05 (3)), placed right below the
  existing Manage/Edit action, red/destructive-styled to match Debts.jsx's
  delete button (`bg-destructive/15 text-red-400 border-destructive/30`,
  same classes the shared `Button variant="destructive"` uses).
  - **Manual account** (`acc_<id>`): "Delete account" → confirm dialog
    ("Delete `<name>`? This removes it and its history from SteerMoney.") →
    removed from the store → toast → navigates back.
  - **Manual debt** (`debt_<id>`): "Delete debt" → same confirm-dialog flow
    → removed from the store → toast → navigates back.
  - **Plaid account**: "Disconnect bank" → confirm dialog ("Disconnect
    `<institution>`? All its accounts stop syncing. Existing transactions
    stay.") → `DELETE /api/plaid/items` with that account's item_id → toast
    → `router.push('/accounts')` (not the back-fallback, per spec — a
    disconnected bank shouldn't be "back"-able to).
  - **No duplicated business logic**: added `deleteManualAccount(update, id)`
    and `deleteDebt(update, id)` to `lib/accounts.js`, and rewired the two
    places that already deleted these inline — `Accounts.jsx`'s
    `AccountDialog.del` (was `s.accounts = s.accounts.filter(...)`) and
    `Debts.jsx`'s `DebtCard onDelete` (was `s.debts.splice(i, 1)`, now looks
    the row up by `id` instead of relying on list index) — to call the same
    two functions AccountDetail uses. **The store itself has no dedicated
    `deleteAccount`/`deleteDebt` action** — like every other mutation in this
    app, deletion goes through the single generic `update(fn)` mutator in
    `store.jsx`; these two new functions are just named, reusable wrappers
    around the exact mutations that already existed inline, not a new store
    layer.
  - Extracted the standalone detail page's back-button fallback
    (`router.back()` if there's history, else `router.push('/accounts')`)
    into `backToAccounts(router)` in `lib/accounts.js` so `AccountDetail`'s
    post-delete navigation and `app/(app)/accounts/[id]/page.jsx`'s Back
    button share it — this is also what makes "router.back() from the modal,
    /accounts from the full page" work for free: AccountDetail doesn't know
    which context it's rendering in, but the modal only ever opens via an
    in-app Link click, so `window.history.length > 1` is always true there.
  - Added a `ConfirmDialog` to `components/shared.jsx` (title/desc/
    confirmLabel/busy/onConfirm/onClose) and pointed `Accounts.jsx`'s
    `AccountDialog` at it instead of its own local copy, so there's one
    confirm-dialog implementation instead of two near-identical ones.
    Debts.jsx's own delete button still uses the browser's native
    `confirm()` — untouched, out of scope, only its deletion *logic* was
    extracted.
  - `lib/accounts.js`'s `buildAccountInventory` now carries `item_id` on
    unmatched-Plaid inventory rows (`unmatchedPlaid` mapping) — needed so
    `AccountDetail` knows which `plaid_items` row to DELETE for "Disconnect
    bank"; wasn't there before since nothing needed the raw item id at that
    layer until now.
  - Deliberately did **not** add row-level delete buttons to `Accounts.jsx`'s
    list rows (`CardRow`/`LoanRow`/`DepositoryRow`) — deletion lives only in
    the detail view, per the requirement to avoid cluttering the list.
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — the delete/disconnect
    flow, the confirm dialog, and the post-delete navigation (especially
    from inside the `@modal` overlay) are all unexercised. Next session
    should click through all three delete paths (manual account, manual
    debt, Plaid disconnect) from both the modal and the full page before
    trusting this.

### 2026-08-08 (2)
- **Critical bug fix: Plaid Link clicks swallowed by a duplicate hidden
  iframe** (Sonnet worker, diagnosed from live DOM inspection on the
  deployed site — production-blocking, users could open Link but every
  click did nothing, `/api/plaid/exchange` never fired, no `plaid_items` row
  created). Root cause: `usePlaidLink` creates a hidden fullscreen "initial"
  iframe (`#plaid-link-iframe-N`, `position:fixed`, `z-index 2147483647`)
  the instant the hook runs — even with `token: null`. Three call sites each
  held their own always-mounted `usePlaidLink`
  (`components/connect-bank.jsx`'s `ConnectBankButton`,
  `views/Settings.jsx`'s `FixConnectionButton` — one per connected-bank
  row — and `app/(app)/plaid-oauth/page.jsx`), so every idle instance
  stacked another fullscreen click-eating iframe on top of the real one.
  **Fix:** extracted the only `usePlaidLink` call in the app into a new
  `PlaidLinkRunner({ token, receivedRedirectUri, onSuccess, onExit })` in
  `components/connect-bank.jsx` (returns `null`, calls `open()` in a ready
  effect, persists `token` to sessionStorage under `PLAID_LINK_TOKEN_KEY`
  right before opening — same OAuth-survival behavior as before). All three
  call sites now hold their link_token in state and render
  `{linkToken && <PlaidLinkRunner .../>}` — nothing calls `usePlaidLink`
  unconditionally anymore, so at most one hidden/open iframe can exist on
  the page at any moment, and only while a flow is actually in progress;
  unmounting on success/exit tears the iframe down immediately.
  `plaid-oauth/page.jsx` additionally gates the runner on `status ===
  'connecting'` (not just a truthy token) so a failed/canceled OAuth
  round-trip also unmounts it instead of leaving a dead iframe sitting
  around. Added failure visibility per the diagnosis: `onExit` now toasts a
  friendly error (`err.display_message || err.error_message || '...'`) in
  `ConnectBankButton` and `FixConnectionButton` whenever Link exits with an
  error object (mirroring what the OAuth page already did) — a plain user
  cancel still exits silently. Grepped the whole `src/` tree afterward;
  `components/connect-bank.jsx` is the only file importing `usePlaidLink`.
- **Small feature, same pass — account source badges**: new
  `SourceBadge({ accountId, institution })` in `components/shared.jsx` — a
  tiny muted uppercase pill, "Manual" (Pencil icon) when there's no
  `account_id`, "Plaid · {institution}" (Link2 icon, indigo tint) when
  there is. Uses the exact same `!!account_id` truth-check
  `lib/accounts.js`'s `buildAccountInventory` already relies on for
  matching manual debts to connected Plaid accounts, so a manual debt that
  fuzzy-matches a Plaid account correctly shows as Plaid-linked with no new
  branching logic. Wired into `views/Accounts.jsx`'s `CardRow`/`LoanRow`/
  `DepositoryRow` (centered, above the stats) and `views/AccountDetail.jsx`
  (above the "Latest update received…" line).
- **Left off / not verified:** none of this ran in a browser or against a
  live Plaid Link session (no npm installs, no dev server, per standing
  instructions) — the DOM diagnosis that found the bug was from the
  deployed site, but this fix itself is unverified there yet. Priority next
  step: deploy and click "Connect a bank" for real, confirm only one
  `#plaid-link-iframe-*` ever exists in the DOM at a time and that a click
  inside the visible Link UI actually registers.

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
