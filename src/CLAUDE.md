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
  transactions, goals, accounts, account_tags, account_colors, settings,
  workspaces/invites, plaid_items.
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

### 2026-08-08 (18)
- **Migration correction (Fable review):** every diff-sync upsert in
  `store.jsx` uses `onConflict: 'user_id,id'`, which requires a UNIQUE index
  on `(user_id, id)` on every synced table. The `account_tags` /
  `account_colors` migration SQL in entries (10)/(16) only declared
  `id text primary key` — without the composite index, every upsert to those
  tables fails (and, being OPTIONAL_TABLES, fails *silently*). The migration
  the user actually runs must include:
  ```sql
  create unique index if not exists account_tags_user_row_idx
    on public.account_tags (user_id, id);
  create unique index if not exists account_colors_user_row_idx
    on public.account_colors (user_id, id);
  ```

### 2026-08-08 (16)
- **"Let me edit the card to change color and stuff"** (Sonnet worker), per
  Israel's verbatim request — account cards (`CardChip`,
  `components/shared.jsx`) only ever got a deterministic auto color
  (`cardHue()`, hashed from institution/name). Read the account_tags
  precedent (CLAUDE.md 2026-08-08 (10)) first and followed the exact same
  shape.
  - **New store slice `accountColors`** (mirrors `accountTags`'s shape but
    is at most one row per account, not many): table `account_colors`, one
    row `{id, account_key, color}` per account. `account_key` is the same
    canonical `accountUrlId()` (`lib/accounts.js`) every other per-account
    slice already uses — manual accounts `acc_<id>`, manual debts
    `debt_<id>`, Plaid accounts their `account_id` — so a custom color
    works identically across every account type with no branching, and
    rides shared spaces for free (store.jsx already re-points the entire
    `state`, every slice included, at the active space's rows — nothing
    color-specific was needed for that part, same as tags before it).
    Added to `freshState()`/`normalize()`/`stateRows()`, and to
    `OPTIONAL_TABLES` (now `{'account_tags', 'account_colors'}`) so a
    missing/not-yet-migrated table degrades the same way account_tags
    already does: initial load logs a `console.warn` and falls back to
    `accountColors: []` (never sets `syncError` — this is a nicety, not
    core data), and the diff-sync delete/upsert loops skip-and-continue on
    a failure for this table instead of aborting every other table's sync
    that pass.
  - **`lib/accounts.js`**: `colorForAccount(state, accountKey)` returns the
    stored hue number or `null` (no override → caller falls back to
    `cardHue()`'s hash, unchanged); `setAccountColor(update, accountKey,
    color)` — unlike `addAccountTag` (appends), this always replaces any
    existing row for that key first, since a card has at most one color;
    passing `color` as `null`/`undefined` just removes the row entirely —
    that's the entire mechanism behind the "Auto" swatch, no separate reset
    flag anywhere. `deleteManualAccount`/`deleteDebt` now also strip
    `accountColors` rows for that key (orphan cleanup on delete, same as
    they already did for `accountTags`), and `AccountDetail.jsx`'s Plaid
    "Disconnect bank" cleanup now clears both tags and colors for that one
    `account_id`.
  - **UI — `components/shared.jsx`**: `CARD_COLOR_PRESETS` (9 curated hues —
    red/orange/amber/green/teal/blue/indigo/violet/pink — reusing
    `CardChip`'s existing gradient formula, factored into a small
    `cardGradient(hue)` helper shared by both the chip and the picker so
    presets always look like a real card, not a flat swatch). `CardChip`
    gained an optional `colorOverride` prop (a hue number) — when present
    it wins over the computed `cardHue()` hash (via `??`, so `0` — a
    legitimate hue — isn't mistaken for "no override"); every existing call
    site is unaffected when the prop is omitted. `CardColorPicker({
    accountKey })` — a row of 9 preset swatch buttons plus one "Auto"
    swatch (a muted circle with a `RotateCcw` icon) that calls
    `setAccountColor(update, accountKey, null)`; the currently-active
    swatch (or Auto, when no override exists) gets a `border-primary` ring.
    No free-form color picker — tap-to-select only, per the "keep it dead
    simple, non-tech users" brief every other account-detail control here
    already follows (same reasoning as `AccountTagsEditor`).
  - **UI — `views/AccountDetail.jsx`**: new "Card color" row right under the
    existing `AccountTagsEditor`, same `id` (`accountUrlId()`) as the tags
    editor takes — `<CardColorPicker accountKey={id} />` under a small
    uppercase "Card color" label matching the page's other micro-labels.
    The page's own `<CardChip ... size="lg" />` now passes
    `colorOverride={colorForAccount(state, id)}` so picking a swatch updates
    that same chip immediately (it's driven by the store, not local state).
  - **UI — `views/Accounts.jsx`**: `CardRow`/`LoanRow`/`DepositoryRow` each
    gained a `colorOverride` prop, threaded through to their `CardChip`;
    each of the three list-rendering call sites now passes
    `colorOverride={colorForAccount(state, accountUrlId(a))}` right next to
    the existing `tags={tagsByKey[...]}` prop — no new memoized map needed,
    `colorForAccount` is a cheap `.find()` over a small per-space array.
  - **UI — `views/Dashboard.jsx`**: the Credit Cards card's per-row
    `<CardChip name={d.name} size="dash" />` now also passes
    `colorOverride={colorForAccount(state, debtUrlId(d.id))}` — same
    lookup, so a color picked on a debt's detail page shows up on the
    Dashboard's small chip too, no separate wiring.
  - **Migration required — nothing above persists to Supabase until this
    runs.** Same situation as `account_tags.sql` (2026-08-08 (10)): this
    app's post-launch tables live in a `supabase/` folder outside the
    mounted `src/` root, so add `supabase/account_colors.sql` next to it
    and run in the Supabase SQL editor:
    ```sql
    create table if not exists public.account_colors (
      id text primary key,
      user_id text not null,
      account_key text not null,
      color integer not null,
      created_at timestamptz not null default now()
    );
    create unique index if not exists account_colors_user_account_idx
      on public.account_colors (user_id, account_key);
    create index if not exists account_colors_user_id_idx
      on public.account_colors (user_id);
    alter table public.account_colors enable row level security;
    -- IMPORTANT: copy the exact RLS policy the `account_tags` table already
    -- uses (Supabase Dashboard -> Authentication -> Policies ->
    -- account_tags), same shared-space predicate reasoning documented in
    -- that table's migration comment (2026-08-08 (10)) — don't hand-roll a
    -- new one.
    ```
    Until this runs, the app degrades exactly like account_tags did before
    its migration: colors work locally (localStorage cache, `update(fn)`)
    but silently fail to persist (logged via `console.warn`, not
    surfaced) — picking a swatch, refreshing the page, and seeing it
    revert is the expected symptom, not a bug, until the SQL above is run.
  - **How "Auto" reset works, precisely**: `colorForAccount()` returns
    `null` when no `account_colors` row exists for that key; `CardChip`
    does `colorOverride ?? cardHue(...)`, so `null`/`undefined` (via `??`,
    not plain falsiness — `0` is a legitimate hue, not a reset signal)
    falls straight through to the original hash-based color. Tapping "Auto"
    in the picker calls `setAccountColor(update, accountKey, null)`, which
    deletes any existing row for that key — there's no "auto" sentinel
    value stored anywhere; the absence of a row is the auto state.
  - **Files changed**: `store.jsx` (mapper, freshState/normalize/stateRows,
    OPTIONAL_TABLES, initial-load fetch + defensive fallback, diff-sync
    delete/upsert table lists, `update(fn)`'s defensive-init), `lib/accounts.js`
    (`colorForAccount`, `setAccountColor`, delete-cleanup wiring),
    `components/shared.jsx` (`CARD_COLOR_PRESETS`, `cardGradient`,
    `CardChip`'s `colorOverride` prop, new `CardColorPicker`),
    `views/AccountDetail.jsx` (picker + `colorOverride` on its chip + Plaid-
    disconnect cleanup), `views/Accounts.jsx` (`colorOverride` threaded
    through all three row types), `views/Dashboard.jsx` (`colorOverride` on
    the Credit Cards row chip).
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — all six changed/new
    files were checked with `npx esbuild <file> --bundle=false
    --outfile=/dev/null` and parse cleanly. Next session with real access
    should: (a) run the `account_colors.sql` migration above (copying the
    real RLS policy from `account_tags`, per the same caution documented
    there); (b) open an account's detail view, tap a preset swatch, and
    confirm the big chip updates immediately and the same account's row on
    Accounts/Dashboard picks up the color too; (c) tap "Auto" and confirm it
    reverts to the original hash color; (d) confirm the swatch row doesn't
    crowd a real ~390px viewport (9 presets + Auto = 10 small circles,
    `flex-wrap`ped — untested at a real width); (e) confirm deleting a
    colored manual account/debt, or disconnecting a colored Plaid bank,
    actually removes its `account_colors` row from Supabase, not just local
    state.

### 2026-08-08 (17)
- **"Let me share my personal [space] or let me add a new shared space but
  allow me to transfer all accounts"** (Sonnet worker), per Israel's
  verbatim request — creating a shared space always started empty; there
  was no way to bring existing personal data (debts, accounts, budgets,
  transactions, goals, recurring, tags, colors, connected banks) into it.
  Read store.jsx in full (row↔state mapping, the debounced diff-sync, how
  `setSpace`/`setViewAs` swap the effective `userId` and reset
  `freshFor`/`synced`), `views/Settings.jsx`'s `SharedSpacesSection`, every
  `app/api/plaid/*` route, and `lib/plaid-server.js` before changing
  anything.
  - **New store method `transferPersonalDataToSpace(targetSpaceId)`**
    (`store.jsx`, exposed via `useApp()`) — "Move my data into this space."
    Deliberately bypasses the reactive `state`/`update(fn)`/debounced
    diff-sync entirely and does its own direct Supabase reads/writes
    instead: relying on `update(fn)` + waiting for the diff-sync effect to
    settle would only work while Personal happened to be the active view,
    and would need a new "is the sync idle" signal that doesn't exist today.
    Doing it directly works correctly regardless of what's currently on
    screen (Personal, the target space, a third space — admin
    view-as is blocked outright, support mode is read-only everywhere else
    too).
    - **Sequence (all tables share the same `user_id,id` composite key
      every slice already upserts on — see `stateRows()` — so copying a row
      from personal to a space's `user_id` is never a collision with
      anything the space already has; no id-remapping needed anywhere):**
      1. Read every personal row for debts, payments, budgets, recurring,
         transactions, goals (`CORE_TRANSFER_TABLES`) and accounts,
         account_tags, account_colors (`OPTIONAL_TRANSFER_TABLES` — may not
         be migrated on an older project; a read failure on one of these is
         logged and treated as empty, not a hard error, matching how the
         initial-load effect already treats these same tables).
      2. Upsert every non-empty table into the target space
         (`user_id: targetSpaceId`), tracked per-table in a `moved` map. A
         `CORE_TRANSFER_TABLES` failure here **aborts the whole operation
         immediately, before anything is deleted** — "nothing cleared if
         the space write failed," per the explicit safety requirement. An
         `OPTIONAL_TRANSFER_TABLES` failure instead skip-and-warns (that one
         table is left in personal, real financial data still moves) —
         matches this app's existing lenient treatment of account_tags/
         account_colors (`OPTIONAL_TABLES` in the diff-sync effect) rather
         than blocking a whole data move over a color-picker table lagging
         a migration.
      3. Bank connections (`plaid_items`) are service-role only (RLS, no
         policies at all — see `lib/plaid-server.js`) — the client can't
         upsert that table directly like every other slice, so this step
         calls the new `POST /api/plaid/transfer` route instead (see
         below). A bank-transfer failure is reported back (`bankError`) but
         does **not** block or roll back the rest of the move — the
         financial data already safely landed in the space by this point.
      4. Delete personal rows, but **only for tables where step 2's `moved`
         map says the copy actually succeeded** — a skipped optional table
         keeps its personal rows untouched instead of being deleted with
         nowhere to go (this was a real bug caught before shipping: the
         first draft deleted based on what was *read* in step 1, not what
         was confirmed *written* in step 2 — if an optional table's upsert
         had failed and was skip-and-warned, that draft would have deleted
         the personal copy anyway, losing it). Delete order
         (`TRANSFER_DELETE_ORDER`) mirrors the diff-sync effect's own
         FK-safe convention: payments before debts.
      5. If either Personal or the target space is the *currently active*
         view (`userId === sourceId || userId === targetSpaceId`), force an
         immediate refetch — same `synced.current = null; freshFor.current
         = null; loadingFor.current = null; dirty.current = false;
         setState(null)` reset shape `setSpace()`/`setViewAs()` already use
         when switching contexts — so the UI reflects the move without a
         manual refresh. Also clears the personal cache
         (`localStorage.removeItem('fin-cache-' + sourceId)`) so a
         subsequent switch to Personal doesn't briefly flash stale cached
         data before the fresh (now-empty) fetch lands.
    - Explicitly does **not** move `settings` (sim/mSim) — same precedent as
      `DangerZoneSection`'s "Erase all data" (2026-08-08 (4)): that's
      configuration, not user data.
  - **New route `app/api/plaid/transfer/route.js`** (`POST { to_space_id
    }`) — reassigns every `plaid_items` row owned by the signed-in Clerk
    user to the target space's id. Verifies the caller is an actual member
    of that workspace (`workspace_members`) before doing anything; only
    rows whose `user_id` is literally the caller's own Clerk id are ever
    touched (never another member's connections, even inside the same
    target space). Not added to `middleware.js`'s public matcher — it's a
    normal Clerk-authed route like every other `app/api/plaid/*` route
    except `webhook`.
  - **Fixed a real bug this surfaced, not hypothetical**: every
    `app/api/plaid/*` route that looks up "this user's" `plaid_items`
    filtered with a flat `.eq('user_id', clerkUserId)`. After a transfer,
    that row's `user_id` is the space id, not the mover's own Clerk id — so
    without a fix, the moment someone moved their bank connection into a
    space, `/api/plaid/items` (Settings' Connected Banks list),
    `/api/plaid/sync` ("Sync now"), and the update-mode branch of
    `/api/plaid/link-token` (re-auth) would all stop finding it, making it
    permanently un-manageable from the very account that moved it (the
    webhook route was already fine — it looks items up purely by
    `item_id`, never by `user_id`). Fixed with a new shared helper,
    **`ownerIdsFor(clerkUserId)`** (`lib/plaid-server.js`) — resolves that
    user's own id plus every workspace they belong to
    (`workspace_members`), falling back to just their own id if the lookup
    fails — and switched every one of those lookups from `.eq('user_id',
    userId)` to `.in('user_id', ownerIds)`. `DELETE`/`PATCH` on
    `/api/plaid/items` now resolve the target row first via `ownerIds` +
    `item_id`, then act on the row's own primary key (`id`) rather than
    repeating a `user_id` equality check that would no longer match a
    transferred row.
  - **UI — `views/Settings.jsx`**'s `SharedSpacesSection`: each space row
    gained a "Move my data here" pill (`ArrowRightLeft` icon) next to "Copy
    invite link," `stopPropagation`'d the same way. Opens the shared
    `ConfirmDialog` with plain-language copy ("Your accounts, debts,
    budgets, recurring bills, transactions, goals, and bank connections will
    move into "`<space>`". Everyone in the space will be able to see them,
    and they'll no longer show up in your Personal space... don't close
    this page.") and a busy spinner (`ConfirmDialog`'s existing `busy` prop)
    while the move runs, then a `centerToast` — success, an optional-table
    warning, or a bank-specific warning, in that priority order (see
    `confirmMove`).
  - **Files changed**: `store.jsx` (`transferPersonalDataToSpace` + its
    `CORE_TRANSFER_TABLES`/`OPTIONAL_TRANSFER_TABLES`/
    `TRANSFER_DELETE_ORDER` constants, exposed via the `api` object),
    `lib/plaid-server.js` (`ownerIdsFor`), `app/api/plaid/transfer/route.js`
    (new), `app/api/plaid/items/route.js` (GET/DELETE/PATCH → `ownerIdsFor`),
    `app/api/plaid/sync/route.js` (→ `ownerIdsFor`),
    `app/api/plaid/link-token/route.js` (update-mode ownership check →
    `ownerIdsFor`), `views/Settings.jsx` (`SharedSpacesSection`).
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser, and none of this ran against a real Supabase
    project or a real second account (standing instruction) — all eight
    changed/new files were checked with `npx esbuild <file> --bundle=false
    --outfile=/tmp/out.js` and parse cleanly, but the actual multi-table
    read→write→delete sequence, the `ownerIdsFor` broadened lookups, and the
    `/api/plaid/transfer` route are all unexercised against live data. Also
    worth noting: `account_colors`' migration SQL (2026-08-08 (16)) declares
    `id text primary key` (not a composite `user_id,id` key), while every
    upsert against it in this codebase — including this session's transfer
    — uses `onConflict: 'user_id,id'`; if that mismatch makes a real upsert
    fail once the table is actually migrated, this session's optional-table
    skip-and-warn handling (see above) means a transfer would still succeed
    for everything else and just leave `account_colors` in personal with a
    warning — not silently lose data — but the underlying constraint
    mismatch itself is worth a dedicated look in a future session, not
    fixed here (out of scope for this feature). Next session with real
    two-account access should: (a) build up a full personal data set (a
    debt with payments, a budget, a transaction, a goal, a tagged/colored
    account, a connected sandbox bank), create a new shared space, click
    "Move my data here," and confirm every table actually landed under the
    space's `user_id` in Supabase and disappeared from personal; (b)
    confirm the second partner in that space can already see everything
    without needing to do anything on their end (shared spaces don't need
    a manual sync — see 2026-08-08 (10)'s confirmation of this); (c) after
    the move, click "Sync now" and "Fix connection" (if applicable) from
    Settings and confirm the transferred bank connection is still found and
    manageable (this is exactly the bug `ownerIdsFor` was written to close
    — confirm it actually is); (d) try moving into a space while that exact
    space is the currently-active view (header switcher), and try it while
    Personal is active, and confirm both refresh the UI immediately with no
    manual reload; (e) deliberately break one table's write (e.g. rename a
    column) and confirm the all-or-nothing guarantee actually holds —
    nothing gets deleted from personal.

### 2026-08-08 (15)
- **Quick win: store + surface Plaid's `balances.limit`/`balances.available`**
  (Sonnet worker). `accountsGet`/`transactionsSync` already return these
  per-account; the app only ever stored `balances.current` into
  `plaid_items.accounts`, so a real credit limit or depository available
  balance from Plaid was silently dropped even though the UI already knew
  how to render both — `views/Accounts.jsx` (CardRow line ~251, DepositoryRow
  line ~300) and `views/AccountDetail.jsx` (line ~73, ~165/~170) already read
  `account.limit` (amber "Credit limit needed" pill when falsy) and
  `account.available ?? account.balance` — they just never received a
  non-null value from a Plaid-backed row.
  - **`lib/plaid-sync.js`** (balance-refresh section of `syncPlaidItem`) and
    **`app/api/plaid/exchange/route.js`** (initial accounts snapshot) both
    now add `limit: a.balances?.limit ?? null` and
    `available: a.balances?.available ?? null` to each account object stored
    in `plaid_items.accounts`, alongside the existing `balance` field — same
    flat shape, no nesting.
  - **`lib/accounts.js`'s `buildAccountInventory`**: `unmatchedPlaid` rows
    now carry `limit: a.limit ?? null, available: a.available ?? null`
    straight from the stored Plaid account (was hardcoded `limit: null`,
    `available` never set at all). `fromDebts` (manual debts fuzzy-matched to
    a Plaid account) now does `limit: m?.limit != null ? m.limit : (d.limit
    || null)` — prefers Plaid's real limit when the matched account reports
    one, otherwise falls back to the manually-entered `d.limit`, so an
    already-working manual limit is never clobbered by a `null` from an
    unmatched or limit-less Plaid account — plus `available: m?.available ??
    null`. `depositoryFromManual` (true manual accounts, no Plaid link)
    intentionally untouched — no `available` field, same as before; the UI's
    `?? account.balance` fallback already handles that.
  - **No migration needed** — confirmed by reading both write sites:
    `plaid_items.accounts` is a JSONB column, written wholesale as a plain JS
    array/object on both insert (exchange route) and update (balance
    refresh in `plaid-sync.js`); adding keys to the per-account objects is
    just a shape change in application code, not a schema change.
  - **Where it surfaces**: credit-card rows (Accounts.jsx `CardRow`,
    AccountDetail.jsx) get a real LIMIT and drop the "Credit limit needed"
    pill whenever Plaid reports one; depository rows (Accounts.jsx
    `DepositoryRow`, AccountDetail.jsx) show real AVAILABLE instead of
    silently falling back to CURRENT. Utilization (`balance/limit`) starts
    computing correctly wherever it already read `account.limit`, no
    separate change needed.
  - **Files changed**: `lib/plaid-sync.js`, `app/api/plaid/exchange/route.js`,
    `lib/accounts.js`.
  - **Left off / not verified**: no dev server, no npm installs (standing
    instruction) — all three changed files parse clean via `npx esbuild
    <file> --bundle=false --outfile=/dev/null`. Not exercised against a real
    Plaid sandbox/production account — next session with real access should
    confirm (a) a real credit card's LIMIT/utilization renders correctly and
    the amber pill disappears; (b) a real checking/savings account's
    AVAILABLE differs from CURRENT when the bank actually reports a
    difference (pending holds, etc.) and displays the right one; (c) a
    manual debt fuzzy-matched to a Plaid card with no reported limit still
    shows its manually-entered limit (regression check on the `m?.limit !=
    null ? ... : ...` fallback).

### 2026-08-08 (14)
- **Three UI/logic fixes** (Sonnet worker), per Israel's verbatim requests:
  "the side bar doesn't go when scrolling," "if there's no debt just say no
  debts, click here to add debt," and "for the recurring go back 4 months,
  and make sure you check that it's the same amount around the same time."
  Read this file (esp. (13) recurring detection, (12) feedback widget) and
  every touched file before changing anything.
  - **Sidebar scrolls away instead of sticking (desktop).** Root cause was
    NOT `app/(app)/layout.jsx` — its `<aside>` already had `sticky top-0
    h-screen`. The real culprit: `app/globals.css`'s `html, body {
    overflow-x-hidden }` (added 2026-08-04 as a horizontal-overflow
    backstop, never verified live). Giving `body` a non-`visible`
    `overflow-x` makes its computed `overflow-y` become `auto` (the
    propagation quirk that would otherwise hand body's overflow to the
    viewport only fires when the *root*'s overflow is `visible` — here
    `html` also had `overflow-x: hidden`, so it doesn't), turning `body`
    into its own scroll container. `body` has no constrained height, so it
    never actually scrolls internally — meaning any `position: sticky`
    descendant (the sidebar, but structurally every other `sticky` element
    in the app too) computes its "stuck" offset against a scrollport that
    never moves, instead of the real window scroll, so it just flows away
    with the page exactly as reported. **Fix:** restricted the rule to
    `html` only (`html { overflow-x-hidden }`, dropped `body`) — `html`
    alone still clips horizontal overflow at the viewport root (the search
    for a clipping ancestor walks up past `body`, which is back to default
    `visible` and not a scroll container, to `html`), and removes the
    extra nested scroll container that was breaking sticky. No changes
    needed to `layout.jsx` itself — its sidebar/header sticky classes were
    already correct. Mobile `BottomNav` is `fixed` (not `sticky`, not a
    descendant of the aside), so it's unaffected either way.
  - **Debts.jsx empty state.** `views/Debts.jsx`: added a guard right
    before the main `return` — when `state.debts.length === 0`, renders one
    `Card` (icon, "No debts yet", "Add your first debt to start tracking
    your payoff plan.", a "+ Add debt" button wired to the existing
    `setEditIdx(-1)` → `DebtDialog` add flow) instead of the whole page.
    Previously an empty list still rendered the KPI row, Payoff Simulator
    ("Nothing pays off within 50 years at this payment"), Snowball
    Simulator, Consolidation Calculator, and the search/filter toolbar, all
    computing nonsense off zero debts (0 mo, $0.00, "Debt-free by" the
    current month). The guard sits after every hook call (no conditional
    hooks) so it doesn't change hook order; non-empty behavior is
    byte-identical since none of the existing JSX below it was touched.
  - **Recurring detection tightened**, per "go back 4 months... same
    amount around the same time... automatically without asking AI"
    (`lib/recurring-detect.js`):
    1. **4-month window.** New `WINDOW_DAYS = 120`. Weekly/biweekly/monthly
       are now classified only against each merchant group's charges from
       the last 120 days (`tryClassifyRecent`) — a bill that stopped
       months ago ages out of suggestions on its own instead of surfacing
       forever off stale charges.
    2. **Yearly dropped from the main band, kept as a bonus.** `yearly`
       removed from `CADENCE_RANGES` (impossible to see inside a 120-day
       window anyway). New `tryClassifyYearly` checks the group's *full*
       history separately — requires the median interval to land in
       `YEARLY_RANGE` (350–380d), i.e. genuinely ~2+ charges about a year
       apart — and only runs when the recent-window path finds nothing.
    3. **"Same amount" tightened 20% → 10%** (`amountsAreConsistent`),
       $0.50 floor unchanged.
    4. **"Same time" for monthly:** new `domConsistent` requires every
       charge's day-of-month within ±4 of the group's median day-of-month —
       catches "same merchant, but a different week each time" that the
       interval-median check alone would still call monthly. Weekly/
       biweekly untouched — their tight interval bands already imply
       consistent timing.
    `detectRecurring(transactions, existingRecurring)`'s signature and
    return shape (`{key, displayName, cadence, avgAmount, lastDate,
    nextEstDate, count, accountId, cat, confidence}`) are unchanged;
    `count` now reflects the transactions that actually satisfied the
    matched cadence (the recent-window subset, or the full-history subset
    for a yearly match) rather than every historical charge in the group.
    **Confirmed still automatic, no AI, no user prompt**: `detectRecurring`
    is a pure function with no network/store access; `views/Recurring.jsx`
    (line ~91-94) calls it inside a `useMemo` keyed on
    `[state.transactions, state.recurring, dismissed]`, so it re-runs the
    instant a transaction changes, purely client-side — unchanged by this
    session, verified by re-reading the call site.
  - **Files changed:** `app/globals.css` (one rule, `html, body` →
    `html`), `views/Debts.jsx` (one early-return block + `EmptyDebtsState`-
    equivalent inline JSX, no new imports needed — `Card`/`Button`/`Plus`/
    `CreditCard` were already imported), `lib/recurring-detect.js`
    (`WINDOW_DAYS`/`YEARLY_RANGE` constants, `amountsAreConsistent`/
    `domConsistent`/`tryClassifyRecent`/`tryClassifyYearly` helpers,
    `detectRecurring`'s grouping loop rewritten to use them).
  - **Left off / not verified:** no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — all three changed
    files were checked with `npx esbuild <file> --bundle=false
    --outfile=/dev/null` and parse clean (`app/(app)/layout.jsx` and
    `views/Recurring.jsx`, both unchanged this session, were also re-
    parsed as a sanity check). The sticky-CSS root-cause analysis is
    reasoned from the CSS Overflow spec's scroll-container/propagation
    rules, not observed live — next session should confirm on a real
    desktop viewport that scrolling a long page (e.g. `/debts` with
    several debts, or any page taller than the viewport) now keeps the
    sidebar pinned, and spot-check that no *other* sticky element (mobile/
    desktop header, the "Viewing as" banner) regressed now that `body` no
    longer clips independently — it shouldn't, since `html`'s clip is at
    the outermost level, but worth a look. Also worth eyeballing the empty
    Debts state on an actual ~390px viewport, and re-testing the recurring
    suggestions against real transaction history now that detection is
    materially stricter (4-month window + 10% + day-of-month) — some
    previously-suggested bills may now correctly disappear (e.g. anything
    that only had older charges, or drifted amount/day too much), which is
    the intended effect, not a regression.

### 2026-08-08 (13)
- **Recurring-charge/subscription detector** (Sonnet worker), per Israel's
  verbatim request: "start building a recurring script that checks all
  recurring based on the accounts. Check for subscriptions — Netflix,
  Claude, Spotify etc. And keep the tag of who the account belongs to, and
  which account it is." Runs client-side on demand (opening Recurring.jsx),
  not a cron/scheduled job — no new backend surface, no roadmap-7-style
  infra needed; re-detects fresh every time `state.transactions`/
  `state.recurring` change.
  - **`lib/recurring-detect.js`** (new, pure functions): `detectRecurring(transactions,
    existingRecurring)` groups expense transactions (excludes income/
    transfer/debt categories) by a normalized merchant key —
    `merchantKey()`/`normalizeMerchant()` strip domain suffixes, store/POS/
    terminal/ref numbers, punctuation, and long numeric tails, then collapse
    whitespace (e.g. "NETFLIX.COM *A1B2C3" and "Netflix 04/12" both key to
    `netflix`). A ~35-entry `KNOWN_SUBS` substring list (netflix, spotify,
    hulu, disney+, max, youtube, amazon prime, apple/icloud, claude.ai/
    anthropic, openai/chatgpt, audible, dropbox, google one, several gym
    chains, nytimes, github, adobe, microsoft 365, xbox/playstation,
    paramount+/peacock, siriusxm, …) collapses onto a canonical display name
    so near-variants ("hbo max"/"hbomax") group together and get a clean
    label instead of the raw statement string; anything not on the list
    falls back to a title-cased version of the cleaned merchant string.
    For each group with ≥2 charges: median interval in days classifies
    cadence (`weekly` 6–8d, `biweekly` 12–16d, `monthly` 26–35d, `yearly`
    350–380d — anything outside those bands is dropped, not guessed at);
    amounts must be consistent (within ~20% of the median, floor $0.50) or
    the group is dropped — catches "same merchant, unrelated one-off
    purchases" (e.g. two different Amazon orders) from being mistaken for a
    subscription. Groups fuzzy-matching an existing `state.recurring` desc
    (substring either direction against the normalized name) are excluded —
    already-tracked bills don't get re-suggested. Output per suggestion:
    `{key, displayName, cadence, avgAmount, lastDate, nextEstDate, count,
    accountId, cat, confidence}` — `accountId` is the *last* matching
    transaction's Plaid `account_id` (or null for manual/CSV-imported
    transactions with no account link); `cat` is that transaction's own
    category (real data, not guessed). `confidence` (0–1) only drives sort
    order, not a hard cutoff — nothing is silently hidden from the list.
  - **UI — `views/Recurring.jsx`**: new "Suggested subscriptions" Card,
    rendered only when `suggestions.length > 0`, placed right before the
    filters Card (after the what-if simulator, before the manual bills
    list). Each row: `CatIcon`, display name, `"$avgAmount · cadence"`
    (`CADENCE_LABEL` maps `biweekly` → "every 2 weeks", others are used
    as-is), the charging account's `institution ••mask` (via the same
    `buildAccountInventory`/`usePlaidItems` merged inventory
    Accounts.jsx/AccountDetail.jsx already build — resolves a Plaid
    `account_id` to its institution/mask *and* correctly falls back to a
    manual debt's own `accountUrlId()` when that debt is fuzzy-matched to
    the Plaid account, same logic AccountDetail already relies on) plus
    that account's `TagPill`s via `tagsForAccount(state, accountUrlId(acctRow))`
    — this is what satisfies "keep the tag of who the account belongs to,
    and which account it is." No account line renders at all when
    `accountId` is null (manual/CSV transactions). "Add" and "Dismiss"
    buttons per row.
  - **"Add"**: pushes a normal `state.recurring` item — `desc` (the
    suggestion's display name), `amount` (rounded to cents), `dueDay`
    (day-of-month from `lastDate`), `cat` (the transactions' own category,
    fallback `'other'`), `every: 1`, `active: true`, plus `accountId` when
    the suggestion has one — then immediately dismisses that suggestion (it's
    now a tracked bill, shouldn't keep suggesting itself) and shows a
    `centerToast`. **Limitation, called out deliberately rather than faked**:
    every suggestion is added as a monthly (`every: 1`) bill regardless of
    detected cadence — the store's recurring schema (see
    `RecurringDialog` in the same file) only supports "every N months," so a
    detected `weekly`/`biweekly` cadence has no native slot to go into yet;
    it's still detected and its real cadence is shown in the Suggested
    Subscriptions row, but "Add" necessarily downgrades it to the closest
    thing the schema supports rather than leaving it un-addable.
  - **"Dismiss"**: adds the suggestion's `key` to a plain `localStorage`
    array (`fin-recur-dismissed`) so it won't reappear in this browser.
    Deliberately **not** a new store/DB slice: this is a disposable
    per-browser "don't ask again," not data needing cross-device sync, and
    piggybacking it onto `store.jsx`'s `sim`/`mSim` settings-slice sync (the
    only generic key/value slice that exists) would have meant widening that
    diff check for something this low-stakes. Same convention this file
    already used for its view-mode toggle (`fin-rec-view`).
  - **Existing recurring rows also show the account + tags now**: the main
    bills list's row (the `min-w-0 flex-1` block with desc + cadence line)
    gained `{accountLineFor(r.accountId)}` right under the existing cadence
    line — resolves via the same merged inventory + `tagsForAccount`, and
    renders nothing when `r.accountId` is absent (every pre-existing manual
    bill, unaffected/unchanged in appearance).
  - **`store.jsx`**: `mappers.recurring.toRow`/`fromRow` now carry
    `account_id`/`accountId` using the exact same "only include the key when
    already present" convention `mappers.transactions` already established
    (2026-08-05 (2) entry) — so a plain manually-added bill (no `accountId`
    key at all) round-trips completely unaffected. **Needs a migration**,
    same situation as `transactions.account_id` before it:
    `ALTER TABLE recurring ADD COLUMN IF NOT EXISTS account_id text;` — until
    that runs, the only path that ever sets `accountId` (clicking "Add" on a
    suggestion tied to a Plaid account) will fail to upsert like any other
    not-yet-migrated column write in this app.
  - **Files changed**: `lib/recurring-detect.js` (new),
    `views/Recurring.jsx`, `store.jsx`.
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — all three touched/new
    files were checked with `npx esbuild <file> --bundle=false
    --outfile=/dev/null` and parse cleanly; the detection heuristics
    themselves were not run against any real transaction history (sandbox or
    production). Next session with real data should: (a) open Recurring.jsx
    against an account with real Netflix/Spotify/etc. charges and confirm
    they surface with sensible cadence/amount and don't also show up as
    "already tracked" false negatives; (b) click Add on a Plaid-linked
    suggestion and confirm the `recurring` upsert either succeeds (migration
    already run) or fails cleanly and visibly rather than silently (migration
    not yet run) — the fromRow/toRow defensive-inclusion pattern doesn't
    retry-without-the-column the way some API routes do, so an un-migrated
    DB will surface as `syncError`, not a silent skip; (c) confirm Dismiss
    actually survives a refresh (localStorage) and Add's dueDay/amount
    prefill look right in the edit dialog afterward; (d) decide whether the
    "downgrade weekly/biweekly to monthly on Add" limitation above is worth
    a real schema change (a `cadenceUnit` field) in a future session, or is
    fine left as-is given how rare non-monthly subscriptions are in practice.

### 2026-08-08 (12)
- **Floating feedback/bug-report widget** (Sonnet worker), per Israel's
  verbatim request: "Add a floating like chat thing where users can send
  feedback or if they found a bug. And let it email
  info@wagewatchcompliance.com." Read this file, `app/(app)/layout.jsx`
  (`Frame`/`BottomNav`, to place the button above the mobile tab bar and
  below the z-index ladder below), `components/toast.jsx` (`centerToast`),
  `components/shared.jsx`'s `ConfirmDialog`/`Segmented` conventions, and
  `lib/plaid-server.js`'s `supabaseAdmin` before writing anything.
  - **`components/feedback-widget.jsx`** (new) — `FeedbackWidget`: a small
    circular `MessageCircle` button, `fixed right-4`, positioned above
    `BottomNav` on mobile (`bottom-[calc(4.75rem+env(safe-area-inset-bottom))]`,
    matching `BottomNav`'s own `env(safe-area-inset-bottom)` pattern) and
    lower on desktop (`md:bottom-6`, same `md:hidden` breakpoint `BottomNav`
    itself uses). Both the button and the panel are **z-[55]** — deliberately
    below every rung of the dialog ladder this file documents (`@modal`
    `z-[60]` < `ui/dialog.jsx` Overlay `z-[65]`/Content `z-[70]` <
    `toast.jsx` centerToast `z-[80]`) — so any real modal/dialog always wins,
    and the success `centerToast` fired on send still paints above the
    now-closed panel. Panel: bottom sheet on mobile (`inset-x-0 bottom-0
    rounded-t-2xl`, with a `md:hidden` tap-to-close backdrop at `z-[54]`),
    small floating card `md:bottom-24 md:right-4 md:w-80` on desktop. Content:
    title "Send us feedback", a `Segmented` [Feedback | Bug] pill pair, a
    plain `<textarea>` (no dedicated `Textarea` component exists in
    `components/ui/`, so it borrows `Input`'s exact border/shadow/
    `[color-scheme:dark]` classes), a non-tech-friendly helper line ("No need
    for a screenshot — just describe it in your own words."), and — only
    when Clerk's `useUser()` has an email — a checked-by-default checkbox
    "Email me back at `{email}` if needed" (`wantsReply` state; sent to the
    API so it can decide whether to set the outgoing email's `reply_to`).
    Send button shows a `Loader2` spinner + "Sending…" while busy (same
    shape as `ConfirmDialog`'s busy button). Success closes the panel and
    fires the shared `useCenterToast()` ("Thanks — we read every one!");
    failure keeps the panel open with the typed message intact and shows an
    inline red error line instead, so nothing typed is lost. Esc key and the
    mobile backdrop both close (blocked while `sending`, same
    can't-dismiss-mid-request pattern `ConfirmDialog` already uses).
  - **`app/api/feedback/route.js`** (new) — `POST`, Clerk-authed (401 if no
    `userId`). Body: `{ type, message, page, userAgent, wantsReply }` — no
    email field; the route looks the user's email up itself via
    `clerkClient()` (`await clerkClient(); client.users.getUser(userId)`,
    the exact pattern `app/api/admin/users/route.js` already uses) rather
    than trusting the client, so the stored/emailed address is always the
    real Clerk one regardless of what the widget sent. Two independent
    best-effort channels, per the request that this should never fail the
    user over an infra gap:
    1. **DB**: `supabaseAdmin.from('feedback').insert({ user_id, email,
       type, message, page, user_agent })` — `type` normalized to exactly
       `'feedback'`|`'bug'`. Wrapped in try/catch; a failure (most likely:
       the migration below hasn't run yet) just logs loudly
       (`console.error`) and falls through to the email channel instead of
       aborting.
    2. **Email**: plain `fetch('https://api.resend.com/emails', ...)` — no
       Resend SDK, no npm install, per this file's standing instruction and
       the design brief. `Authorization: Bearer ${RESEND_API_KEY}`, `from:
       'SteerMoney Feedback <onboarding@resend.dev>'` (until a sending
       domain is verified in Resend — see below), `to:
       ['info@wagewatchcompliance.com']`, subject `[SteerMoney {type}] from
       {email}`, plain-text body with type/from/page/user-agent/message.
       Sets `reply_to` to the user's email only when one exists and
       `wantsReply !== false`. If `RESEND_API_KEY` isn't set, skips the
       email entirely (`emailSkipped: true`) and logs loudly — the DB row
       (if that half succeeded) is the only record until the env var is
       added.
    Response is always `{ ok: true, dbOk, emailOk, emailSkipped }` with
    HTTP 200 as long as *either* channel succeeded; only returns a real
    error (500) if both failed, or 400 if the message was empty.
  - **Mounted once**, in `app/(app)/layout.jsx`'s `Frame`, right next to
    `{modal}` at the end of the root flex div, gated on `{state ? ... :
    null}` — same gate `RemindersBell` already uses, so it doesn't render
    before the store's initial load finishes (and thus never renders on the
    signed-out `/home`/`/sign-in` routes, which use the separate root
    `app/layout.jsx`, not this authed one).
  - **Migration required — nothing persists to Supabase until this runs**
    (the route degrades to email-only without it, per the defensive design
    above). This app's post-launch tables live in a `supabase/` folder
    outside the mounted `src/` root (same situation as `account_tags.sql`,
    2026-08-06-ish entry above), so add `supabase/feedback.sql` and run in
    the Supabase SQL editor:
    ```sql
    create table if not exists public.feedback (
      id uuid primary key default gen_random_uuid(),
      user_id text not null,
      email text,
      type text not null,
      message text not null,
      page text,
      user_agent text,
      created_at timestamptz not null default now()
    );
    create index if not exists feedback_user_id_idx on public.feedback (user_id);
    alter table public.feedback enable row level security;
    -- No policies, deliberately — same as plaid_items. Only
    -- lib/plaid-server.js's service-role supabaseAdmin (used from
    -- app/api/feedback/route.js) ever touches this table; there is no
    -- client-side read/write path and none is planned (this is a one-way
    -- inbox, not app state), so RLS-with-no-policies is correct here, not
    -- a placeholder to fill in later like account_tags' was.
    ```
  - **Manual steps for Israel:**
    1. Run the `supabase/feedback.sql` migration above against the prod DB.
    2. Add `RESEND_API_KEY` to Vercel's env vars (get one from
       resend.com — free tier is plenty for this volume). Without it, the
       route still saves feedback to the DB (once the migration above is
       run) but never emails anyone.
    3. Email will arrive from `onboarding@resend.dev` (Resend's shared
       sending address) until a real domain is verified in the Resend
       dashboard — cosmetic only, doesn't block delivery, but worth
       verifying a domain (e.g. `steermoney.app` or whatever the eventual
       domain is) later so it doesn't look like a stranger's address and so
       `reply_to` round-trips cleanly.
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — every changed/new
    file was checked with `npx esbuild <file> --bundle=false
    --outfile=/dev/null` and parses clean, but the widget's mobile bottom-
    sheet placement relative to the real `BottomNav` height, the Resend API
    call, and the Supabase insert are all unexercised against anything
    live. Next session with real access should: submit one real piece of
    feedback and confirm (a) a row lands in `public.feedback`, (b) an email
    actually arrives at info@wagewatchcompliance.com from
    onboarding@resend.dev, (c) the button sits clear of the bottom tab bar
    on an actual ~390px viewport, (d) `RESEND_API_KEY` missing still returns
    a clean success-with-`emailSkipped:true` instead of an error.

### 2026-08-08 (11)
- **"Click a category on Dashboard's money-out breakdown → land on
  Transactions pre-filtered by that category, so I can recategorize"**
  (Sonnet worker), per Israel's verbatim request. Read `views/Dashboard.jsx`
  (the "Where the money went" breakdown inside the Cash Flow card),
  `views/Transactions.jsx` + `app/(app)/transactions/page.jsx` (the existing
  `?account=` param pattern from 2026-08-08 (9)), and `views/Budgets.jsx`
  (already had its own `onViewTx` → `router.push('/transactions?cat=' +
  cat)` — this session's `?cat=` plumbing plugs into that unchanged).
  - **`?cat=` is now a first-class, bidirectional query param, exactly
    mirroring `?account=`** — previously it was a one-shot "preset" (
    `app/(app)/transactions/page.jsx` read `params.get('cat')` once,
    `views/Transactions.jsx` had a `useEffect` that copied it into local
    `cat` state then immediately stripped the whole query string via
    `clearPreset`), so the category `<Select>` itself never wrote back to
    the URL — changing it in the dropdown didn't update `?cat=`, and a
    deep link + a later `?account=` deep link couldn't coexist (clearing
    one wiped the other). Replaced with the same shape as `setAccount`:
    `app/(app)/transactions/page.jsx`'s `TxPage` now has one generic
    `setParam(key)(id)` (sets/deletes just that one param, preserves the
    other) backing both `setCatFilter`/`setAccountFilter`; `Transactions`
    no longer owns local `cat` state — `catFilter`/`setCatFilter` props
    are the source of truth (`const cat = catFilter || 'all'`), same
    pattern as `accountFilter`. Removed the now-dead `preset`/`clearPreset`
    props and the `useEffect` that consumed them.
  - **Dashboard**: in the Cash Flow card's expense breakdown (`cfView ===
    'out'`, `views/Dashboard.jsx`), each row with a `r.cat` (i.e. every
    expense-category row — "Other"/"Debt Payment"/"Dining Out"/etc.) is now
    a `<Link href={`/transactions?cat=${r.cat}`}>` wrapping the exact same
    row content, with `-mx-2 rounded-lg px-2 hover:bg-secondary/60`
    hover affordance (matches the row-hover convention used elsewhere on
    this page, e.g. the per-month cash-flow rows just below it). The
    "Where the money came from" breakdown (`cfView === 'in'`) has no
    category id (grouped by `srcLabel`, not `t.cat`) so those rows are
    deliberately left as plain, non-interactive `<div>`s, unchanged.
  - **Recategorizing was already possible and needed no changes**: verified
    `views/Transactions.jsx`'s per-row Pencil button (`onClick={() =>
    setEditing(t.id)}`) opens `TxDialog`, whose Category `<Select>` is
    bound to `state.budgets` + `debt`/`income`/`transfer` and saves via the
    normal `update(fn)` mutator — clicking "Other" on Dashboard → lands on
    `/transactions?cat=other` with the Select already showing "Other" →
    click the pencil on any row → change its category → Save. End-to-end
    flow works with no dialog/store changes.
  - **Files changed**: `views/Dashboard.jsx` (breakdown rows → conditional
    `Link`), `views/Transactions.jsx` (`catFilter`/`setCatFilter` props
    replacing local `cat` state + `preset`/`clearPreset`, dropped the now-
    unused `useEffect` import), `app/(app)/transactions/page.jsx`
    (`setParam(key)` generalizing the old single-purpose `setAccount`).
    `views/Budgets.jsx` / `app/(app)/budgets/page.jsx` untouched — their
    existing `?cat=` navigation continues to work unchanged against the new
    plumbing.
  - **Verification**: no dev server/npm installs (standing instruction);
    all three changed files parse clean via `npx esbuild <file>
    --bundle=false --outfile=/dev/null`. Not clicked in a real browser —
    next session should confirm (a) clicking a Dashboard category row lands
    on Transactions with that category already selected and the URL showing
    `?cat=<id>`; (b) changing the Select afterward updates `?cat=` live
    (and clears it back to no param on "All categories"); (c) `?cat=` and
    `?account=` deep links can be combined/changed independently without
    clobbering each other; (d) Budgets' existing category-row → Transactions
    link still works unchanged.

### 2026-08-08 (10)
- **Account tags** ("Mine"/"Julia's"/"Business"), per Israel's verbatim
  request: "if we are sharing the budget I want to be able to see which
  accounts belong to my wife and to me. I think tags could be good." Read
  `store.jsx` (row↔state mapping, the single `update(fn)` mutator, the
  debounced diff-sync, how a shared space just swaps the effective
  `userId`), `lib/accounts.js` (`buildAccountInventory`, `accountUrlId`/
  `findAccountByUrlId`), `views/Accounts.jsx`, `views/AccountDetail.jsx`,
  and `components/shared.jsx` before changing anything, per the "keep it
  dead simple" design brief.
  - **New store slice `accountTags`** (mirrors every other slice's shape:
    a mapper in `store.jsx`'s `mappers`, included in `freshState()`,
    `normalize()`, `stateRows()`), table `account_tags`, one row per
    `{account, tag}`. `account_key` is always the same canonical id
    `lib/accounts.js`'s `accountUrlId()` already produces for every account
    type — Plaid accounts by `account_id`, manual accounts `acc_<id>`,
    manual debts `debt_<id>` — so a tag works identically regardless of
    account type, no branching anywhere.
  - **Shared-space behavior (the actual ask): nothing tag-specific was
    needed.** `store.jsx` already re-points its entire `state` (every
    slice) at a shared space's rows by swapping the effective `userId` to
    the space id — `accountTags` is just one more slice riding along, so
    two partners in the same shared space automatically see and edit the
    same tags, and switching back to a personal space shows only that
    person's own tags. Confirmed by reading the existing space-switch code
    (`setSpace`/`userId = viewAs?.id || space?.id || user?.id`), not
    assumed.
  - **Defensive against the table not existing yet** (explicit requirement,
    since this table is newer than every other slice and Israel hasn't run
    the migration below yet): the initial-load `Promise.all` selects
    `account_tags` alongside everything else, but a failure there only
    logs a `console.warn` and falls back to `accountTags: []` — never sets
    `syncError` (tags are a nicety, not core data, unlike the Goals/Accounts
    tables' setup-needed banners). More importantly, the diff-sync effect's
    delete/upsert loops now check each table's error against a new
    `OPTIONAL_TABLES` set (`{'account_tags'}`) — if `account_tags` errors
    (missing table), that one table's failure is logged and skipped with
    `continue`, instead of `throw`ing and aborting every other table's sync
    for the rest of that pass. This is strictly safer than the precedent:
    the pre-existing `accounts`/`goals` tables have no such guard in the
    diff-sync loops (only their initial-load `select` is guarded) — not
    fixed this session since it's out of scope, but worth knowing the new
    `OPTIONAL_TABLES` pattern exists if a future table needs the same
    treatment.
    - **Known caveat**: if tags are added *before* the migration is run,
      they work fine locally (localStorage cache, `update(fn)`) but silently
      fail to persist to Supabase (logged, not surfaced). Once the migration
      runs, those earlier tags won't auto-retry syncing until something
      about `accountTags` changes again (the diff-sync only re-attempts a
      table when its rows differ from the last-synced snapshot, and a
      swallowed failure still advances that snapshot). Practical fix: run
      the migration first; if tags were already added, add or remove any
      one tag afterward to force a fresh diff.
  - **`lib/accounts.js` additions**: `tagsForAccount(state, accountKey)`,
    `allAccountTags(state)` (unique tag names in the space, case-
    insensitively deduped keeping first-seen casing, alphabetized — feeds
    both the filter pills and the "reuse an existing tag" suggestions),
    `addAccountTag(update, accountKey, tagName)` (trims, caps at 24 chars,
    no-ops on empty/duplicate), `removeAccountTag(update, tagId)`. All three
    mutators go through the store's existing generic `update(fn)` — no new
    API surface, matching how every other mutation in this app already
    works. Also: `deleteManualAccount`/`deleteDebt` now also strip any tags
    pinned to that account/debt's key (orphan cleanup on delete), and
    `AccountDetail.jsx`'s Plaid "Disconnect bank" does the same best-effort
    cleanup for that one `account_id` (a multi-account item's *other*
    accounts' tags are left harmlessly orphaned — never shown again since
    nothing will match their key once the item's gone).
  - **UI — `components/shared.jsx`**: `tagTone(tag)` (hashes the tag name
    into a small fixed 6-color muted palette — same "deterministic, no real
    data needed" trick as the existing `cardHue()`, just onto curated pill
    tones instead of an arbitrary hue), `TagPill` (read-only pill, optional
    `onRemove` for an ×), `AccountTagsEditor({ accountKey })` — existing
    tags as removable pills, a dashed "+ Add tag" ghost button that reveals
    a small inline text input (not a Dialog — an inline input is fewer taps
    on mobile than an inner modal on top of the already-open account-detail
    modal), Enter/Escape handling, and tap-to-add suggestion chips: existing
    tags in the space not yet on this account (so "Julia" gets reused, not
    retyped), or — the very first time, before any tag exists anywhere in
    the space — the signed-in user's own first name (via `@clerk/nextjs`'s
    `useUser()`, already used the same way in `store.jsx`) plus a generic
    "Shared" second suggestion; falls back to plain placeholder text
    ("e.g. Mine, Julia's, Business") in the input if no first name is
    available, per the design brief's fallback.
  - **UI — `views/AccountDetail.jsx`**: `<AccountTagsEditor accountKey={id}
    />` under the existing SourceBadge/last-synced block — `id` is already
    the exact `accountUrlId()` this detail view was looked up by, so no
    recomputation needed. Also wired the Plaid-disconnect tag cleanup
    mentioned above into `handleDelete`.
  - **UI — `views/Accounts.jsx`**: each row (`CardRow`/`LoanRow`/
    `DepositoryRow`) now takes a `tags` prop and renders read-only `TagPill`s
    (wrapped, `flex-wrap`, so they can't force the row wider than a 390px
    viewport) under the SourceBadge line — computed once at the page level
    via a `tagsByKey` map (`state.accountTags` grouped by `accountKey`) and
    passed down, rather than each row re-deriving it. A new tag **filter
    pill row** ("All" + one pill per distinct tag, tinted via `tagTone` to
    match that tag's `TagPill` color) sits above the Credit cards/Loans/
    Depository sections, filtering all three; entirely hidden
    (`allTags.length > 0` gate) until at least one tag exists anywhere in
    the space — a brand-new/untagged user's Accounts page is byte-identical
    to before this session. Filtering a section down to zero rows just
    hides that section (Credit cards/Loans) or shows a tag-aware empty
    state instead of the generic one (Depository) — deliberately no other
    empty-state polish, per "keep it dead simple."
  - **Migration required — nothing above works against Supabase until this
    runs.** This app's other post-launch tables (`accounts`, `goals`) live
    in a `supabase/` folder outside the mounted `src/` root (per the Plaid
    section above, `supabase/plaid.sql` is the same setup), so this wasn't
    written to a `.sql` file in this session — add it as
    `supabase/account_tags.sql` next to `accounts.sql`/`goals.sql` and run
    in the Supabase SQL editor:
    ```sql
    create table if not exists public.account_tags (
      id text primary key,
      user_id text not null,
      account_key text not null,
      tag text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists account_tags_user_id_idx
      on public.account_tags (user_id);
    create index if not exists account_tags_user_account_idx
      on public.account_tags (user_id, account_key);
    alter table public.account_tags enable row level security;
    -- IMPORTANT: copy the exact RLS policy the `accounts` table already
    -- uses (Supabase Dashboard -> Authentication -> Policies -> accounts)
    -- and adapt it to this table name. Don't hand-roll a new predicate —
    -- every other per-user table in this app (debts/accounts/goals/etc.)
    -- resolves both "this row belongs to me" AND "this row belongs to a
    -- shared space I'm a member of" (since `user_id` holds a workspace id
    -- for shared-space rows, not always the real Clerk user id — see
    -- store.jsx's `userId = viewAs?.id || space?.id || user?.id`), and that
    -- exact shared-space predicate lives in SQL this session couldn't read
    -- (outside the mounted src/ root). Getting it wrong either locks
    -- couples out of shared tags (defeats the whole point of this feature)
    -- or, worse, under-restricts access — copy, don't guess.
    ```
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser (standing instruction) — every changed file
    was checked with `npx esbuild <file> --bundle=false --outfile=/dev/null`
    (parses clean) but none of this ran against a live Supabase project or
    a real shared space with two accounts. Next session with real access
    should: (a) run the migration above (after copying the real RLS policy
    from `accounts`); (b) add a tag from one partner's session in a shared
    space and confirm it appears for the other partner without a manual
    refresh (or after their next natural reload — this app doesn't have
    live realtime subscriptions for any table, so "instant" cross-device
    sync isn't expected, just "shows up on next load" like every other
    shared-space edit); (c) confirm the filter-pill row and per-row pills
    don't crowd a real ~390px viewport, especially a card row with a long
    institution name AND two tags; (d) confirm deleting a tagged manual
    account/debt/Plaid-disconnect actually removes its `account_tags` rows
    from Supabase, not just local state.

### 2026-08-08 (9)
- **Transactions: show which account each row is from + filter by account**
  (Sonnet worker), per Israel's verbatim request — prep for multiple
  connected banks. Read `views/Transactions.jsx`, `lib/accounts.js`
  (`usePlaidItems`), `components/shared.jsx` (`SourceBadge`/`CardChip`
  conventions), and `store.jsx`'s transactions mapper (`accountId` only
  present when the row has one) before changing anything — no store/schema
  changes needed, this is purely a read+display+filter feature on data
  that's already synced (`t.accountId` ↔ Plaid `account_id`).
  - **Per-row account label**: each transaction row's description now
    stacks a second, smaller muted line underneath it —
    `<Landmark> Institution ••mask` (falls back to `— Account Name` if a
    Plaid account has no mask). Built from one `accountsById` lookup
    (`views/Transactions.jsx`, keyed by Plaid `account_id`, sourced from
    `usePlaidItems()`) shared with the new dropdown below. Manual rows
    (`t.accountId` falsy) render no second line at all — deliberately not
    even a "Manual" pill here, since design goal 1 only asked for it on
    rows that have an account, and a bare description at the same
    single-line height it always had is the least cluttered "nothing to
    say" state. Lives inside the row's existing `min-w-0 flex-1` wrapper
    (previously just the `<span>` description itself, now a `<span>`
    wrapping both lines), so both lines truncate independently at any
    viewport width — verified against the mobile `min-w-0` pattern CLAUDE.md
    already documents for this file (2026-08-04 entry).
  - **Account filter unified into one dropdown**: replaced the old
    ?account= removable chip (a `<div>` with an X button, separate from the
    category `<Select>` next to it — two competing controls for the same
    kind of filtering) with a second native `<Select>` right next to the
    category one: "All accounts" + one `<option>` per known Plaid account,
    labeled `"{institution} — {account name} ••{mask}"`. Same identifier
    space as before (Plaid `account_id`) and the same `?account=` query
    param — `app/(app)/transactions/page.jsx`'s `clearAccount` helper was
    generalized into `setAccount(id)` (sets the param when truthy, deletes
    it when `null`/empty), passed down as a single `setAccountFilter` prop
    replacing the old `clearAccountFilter`. Deep links from
    `AccountDetail.jsx`'s "View all in Transactions" (`/transactions?account=
    {plaid_account_id}`, added 2026-08-05 (3)) are unchanged and now show up
    as the dropdown already having that account selected, rather than a
    separate chip next to an unrelated "All accounts"-looking select — one
    obvious control, matches the deep link automatically.
  - **Zero-Plaid-accounts case**: the whole account `<Select>` is
    conditionally rendered (`accountOptions.length > 0`) — a manual-only
    user sees the exact same toolbar as before this change, no empty
    dropdown, no "All accounts" clutter with nothing to pick.
  - **Mobile width**: the new `<Select>` has `max-w-[9.5rem]`
    (`sm:max-w-[13rem]`) so a long "Institution — Account Name ••1234"
    label can't push the already-`flex-wrap`ped toolbar row wider than a
    390px viewport — the select itself truncates/scrolls its own text via
    native `<select>` behavior, the container just caps how much horizontal
    space it's allowed to claim before wrapping to the next line.
  - **Files changed**: `views/Transactions.jsx` (per-row label, account
    lookup/options, dropdown, prop rename `clearAccountFilter` →
    `setAccountFilter`), `app/(app)/transactions/page.jsx` (`setAccount`
    replacing `clearAccount`).
  - **Verification**: no dev server/npm installs (standing instruction);
    both changed files were checked with `npx esbuild <file> --bundle=false
    --outfile=/dev/null` and parse cleanly. Not clicked in a real browser —
    next session should confirm the dropdown's selected value tracks a
    deep-linked `?account=` correctly, the two-line row doesn't look
    cramped at real row heights next to the category `CatChip`/amount
    columns, and the `<select>`'s native option list is readable on an
    actual small screen (native selects render their own OS picker, so this
    is lower-risk than a custom dropdown, but unverified either way).

### 2026-08-08 (8)
- **"Please wait, transactions are loading" placeholder for freshly-connected
  banks** (Sonnet worker), per Israel's verbatim request: don't show empty/
  flat data for a new connection while Plaid's historical backfill is still
  in flight — show a loading placeholder "in the modal and everywhere else"
  instead.
  - **Status lifecycle, `plaid_items.status`:** new value `'syncing'`,
    alongside the existing `'ok'`/`'reauth_required'`/`'revoked'`.
    - `app/api/plaid/exchange/route.js` now inserts new connections with
      `status: 'syncing'` (defensive retry without the column if it's not
      migrated yet, same pattern as everywhere else this column is touched).
    - `lib/plaid-sync.js`'s `syncPlaidItem(item, opts)` gained an `opts`
      param. It used to unconditionally stamp every successful sync
      `status: 'ok'` — that's wrong for a `'syncing'` item, since one
      completed `transactionsSync` loop doesn't prove Plaid's 730-day
      backfill has fully landed (it can take several
      `SYNC_UPDATES_AVAILABLE` cycles). New rule: `'reauth_required'`/
      `'revoked'` still clear to `'ok'` unconditionally (a clean sync proves
      the item's healthy again — unchanged); `'syncing'` only clears to
      `'ok'` when the caller passes `opts.clearSyncing: true`.
    - `app/api/plaid/webhook/route.js`: `SYNC_UPDATES_AVAILABLE` now passes
      `clearSyncing: true` once the item is >10 minutes old (fallback for a
      backfill that's surely done by then even without an explicit "done"
      signal). Added two new webhook_code branches, `HISTORICAL_UPDATE`
      (legacy `/transactions/get`-style code that means "full history is
      ready" — not really expected on this app's Sync-based integration, but
      handled defensively per the request: always `clearSyncing: true`) and
      `INITIAL_UPDATE` (recent data ready, but backfill isn't necessarily
      done — syncs but leaves `'syncing'` alone).
    - `app/api/plaid/sync/route.js` (manual "Sync now"): same >-age fallback,
      15 minutes instead of 10 (a human clicking "Sync now" is a weaker
      signal of freshness than a webhook firing).
  - **Client placeholders**, gated on `account.status === 'syncing'` /
    `item.status === 'syncing'`:
    - `lib/accounts.js`'s `buildAccountInventory` now threads `status` (and,
      for debt-matched Plaid accounts, `item_id`) onto every Plaid-touching
      row, not just unmatched ones — so a manual debt fuzzy-matched to a
      freshly-connected card shows the placeholder too, not just brand-new
      unmatched accounts.
    - `lib/accounts.js`'s `usePlaidItems()` (shared by Accounts.jsx,
      AccountDetail.jsx, and now Transactions.jsx) self-polls every ~10s,
      capped at ~12 tries (~2 min), while any item is `'syncing'`: nudges
      `POST /api/plaid/sync` then re-fetches `/api/plaid/items`, so the
      placeholders below flip to real data on their own once the backfill
      lands (or once a webhook does it first) — no manual refresh needed.
      Self-cleaning (clears its own timer on unmount or once nothing is
      `'syncing'`); deliberately keyed off a derived boolean, not the
      `plaidItems` array itself, so its own `setPlaidItems` calls don't reset
      the attempt counter and defeat the 2-minute cap.
    - New shared components in `components/shared.jsx`:
      `TransactionsSkeleton` (4 pulsing rows + "Hang tight — we're pulling in
      your transactions. This usually takes a minute or two."),
      `ChartSkeleton` (pulsing block, same footprint as the real chart via a
      `className` prop), `SyncingPill` (small amber spinner pill).
    - `views/AccountDetail.jsx` (full page +, byte-identical, the Notion-
      style `@modal` overlay — one component, so both surfaces got this for
      free): balance chart → `ChartSkeleton`, transaction list →
      `TransactionsSkeleton`, whenever `isSyncing`.
    - `views/Transactions.jsx`: replaced its one-shot inline
      `/api/plaid/items` fetch with the shared `usePlaidItems()` (gets the
      polling for free); when `?account=` is set and that account's item is
      `'syncing'`, the transaction list Card renders `TransactionsSkeleton`
      instead of the real rows or "No transactions" — regardless of whether
      a few transactions have already trickled in, per "don't show the data
      until transactions pop up."
    - `views/Accounts.jsx`: `CardRow`/`LoanRow`/`DepositoryRow` now render a
      `SyncingPill` next to `SourceBadge` when `account.status === 'syncing'`.
    - `views/Settings.jsx`'s Connected Banks list also shows the same
      `SyncingPill` next to the institution name for a syncing item (this
      list doesn't poll itself — it'll pick up the flip on its own
      `loadItems` refresh, e.g. after "Sync now" or navigating back to the page).
  - **Bug fix, found while editing the exact section this feature touches**:
    `views/AccountDetail.jsx`'s "View all in Transactions ›" button (added
    2026-08-08 (7)) had a JSX comment written as `{/* ... */}` *inside* a
    ternary's parenthesized expression branch — valid as a JSX **child**,
    but not valid there (two unrelated expressions with no operator between
    them). Confirmed with `npx esbuild` that the file failed to parse before
    this session's fix and parses clean after — this would have broken the
    production build the next time anything forced a rebuild. Fixed by
    turning it into a plain `//` line comment (also verified every other
    file touched this session parses with `esbuild`, per the no-dev-server
    constraint — see below).
  - **Left off / not verified**: no dev server, no npm installs, nothing
    clicked in a real browser or against a real Plaid Link session (standing
    instruction) — verification this session was limited to `npx esbuild
    <file> --outfile=/tmp/out.js` per touched file (confirms JS/JSX syntax
    only, not runtime behavior). Next session with real Plaid access should:
    connect a fresh sandbox/production bank and confirm (a) the account
    shows the loading skeleton immediately after connecting, in both the
    `@modal` and the full `/accounts/[id]` page; (b) it flips to real
    transactions/chart within ~2 minutes without a manual refresh (the
    `usePlaidItems()` poll) or immediately if the webhook fires first; (c)
    `/transactions?account=<id>` shows the same skeleton while syncing; (d)
    the Accounts list rows and Settings' Connected Banks list show the
    "Syncing…" pill and it disappears once backfill completes; (e) an
    already-`'ok'` (pre-existing) connection is completely unaffected — no
    regression for accounts connected before this session.

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
