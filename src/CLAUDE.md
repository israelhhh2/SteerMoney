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

## Plaid integration (current state — sandbox, working)

- `lib/plaid-server.js` — Plaid client; `PLAID_ENV` defaults to `sandbox`;
  `plaidConfigured` gate → routes 503 if creds missing.
- `app/api/plaid/link-token` — linkTokenCreate, products: `['transactions']`, US.
- `app/api/plaid/exchange` — public_token → access_token, stores row in
  `plaid_items` (token never sent to client).
- `app/api/plaid/sync` — transactionsSync cursor loop, upserts `pl_*` rows
  into `transactions`, skips pending, regex `guessCategory()`, refreshes balances.
- `app/api/plaid/items` — GET list / DELETE (itemRemove + row delete).
- Client: `components/connect-bank.jsx` (react-plaid-link). Consumers:
  Accounts.jsx, Debts.jsx (fuzzy match via `lib/finance.js`), Settings.jsx.

## Production roadmap (Plaid)

Ordered; check off as done.

- [ ] **1. Plaid production access** — apply in Plaid Dashboard (company info,
      use case, security questionnaire). Approval can take days–weeks; start now.
      Optionally use **Limited Production / Development** tier first.
- [ ] **2. Env switch** — set `PLAID_ENV=production` + production
      `PLAID_CLIENT_ID`/`PLAID_SECRET` in hosting env (Vercel). Never client-side.
- [ ] **3. OAuth support** — many major US banks (Chase, BofA…) require OAuth:
      register redirect URI in Plaid Dashboard, pass `redirect_uri` in
      linkTokenCreate, handle `receivedRedirectUri` on the client. Sandbox
      never forced this; production will break without it.
- [ ] **4. Webhook route** — `app/api/plaid/webhook`: handle
      `SYNC_UPDATES_AVAILABLE` (trigger sync), `ITEM_LOGIN_REQUIRED` /
      `PENDING_EXPIRATION` (flag item for re-auth), verify webhook JWT.
      Pass `webhook` URL in linkTokenCreate.
- [ ] **5. Update mode (re-auth)** — link token with `access_token` param when
      an item errors; surface "Fix connection" in Settings/Accounts.
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
