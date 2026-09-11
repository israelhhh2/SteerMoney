// Shared server-only helpers for app/api/reports/snapshot and app/api/reports/
// export — both routes need the exact same "load this user's (or shared
// space's) rows the way store.jsx does, then hand snapshots.js identical
// inputs" logic, so it lives here once instead of drifting between two
// copies. No 'use client' here (unlike store.jsx/lib/accounts.js) — this file
// is imported directly by Route Handlers.
// Relative imports below carry an explicit `.js` extension (like
// lib/snapshots.js's own imports, see its header comment) so this file is
// also directly importable by plain `node --test` — lib/chat-tools.js/
// lib/chat-briefing.js (Step 2, 2026-09) reuse catNameResolverFor/
// accountNameResolverFor here and are covered by
// __tests__/chat-tools.test.mjs. Harmless for webpack, which resolves an
// explicit .js extension on a relative import identically to an implicit one.
import { mappers } from './mappers.js'
import { defaultRange } from './snapshots.js'
import { catNameFromBudgets } from './categories.js'

export const GRAINS = ['day', 'week', 'month', 'quarter', 'year']

export function resolveGrain(param) {
  return GRAINS.includes(param) ? param : 'month'
}

// `from`/`to` query params win only when BOTH are present and look like ISO
// dates; otherwise fall back to snapshots.js's own sensible default window
// for this grain (year needs the actual transactions to know the earliest
// year with real data — see defaultRange()).
export function resolveRange(grain, fromParam, toParam, transactions) {
  const iso = /^\d{4}-\d{2}-\d{2}$/
  if (fromParam && toParam && iso.test(fromParam) && iso.test(toParam)) {
    return fromParam <= toParam ? { from: fromParam, to: toParam } : { from: toParam, to: fromParam }
  }
  return defaultRange(grain, transactions)
}

// Loads exactly the six slices buildSnapshot()/the Excel export need, scoped
// to `targetId` (a personal user id OR a shared space id) via the CALLER'S
// OWN RLS-scoped Supabase client (`supabase` — see createSupabaseServerClient
// in lib/supabase-clients.js) — never supabaseAdmin. This mirrors store.jsx's
// own initial-load query shape (see its "initial load" effect). RLS's
// `user_id = auth.uid() OR is_member(user_id)` policy (supabase/collab.sql)
// is what actually enforces that a non-member can't read a space's data by
// guessing its id — a plain `.eq('user_id', targetId)` under the user's own
// client just returns an empty set for anyone not entitled to see it, no
// separate membership check needed here. (Contrast a WRITE route like
// app/api/transactions/dedupe, which restricts `space_id` to the space's
// OWNER — a mutating action needs a stronger guarantee than "RLS returned
// nothing"; a read-only report does not.)
export async function loadReportState(supabase, targetId) {
  const [tx, de, pa, bu, re, ac] = await Promise.all([
    supabase.from('transactions').select('*').eq('user_id', targetId),
    supabase.from('debts').select('*').eq('user_id', targetId),
    supabase.from('payments').select('*').eq('user_id', targetId),
    supabase.from('budgets').select('*').eq('user_id', targetId),
    supabase.from('recurring').select('*').eq('user_id', targetId),
    supabase.from('accounts').select('*').eq('user_id', targetId),
  ])
  const err = [tx, de, pa, bu, re].find((r) => r.error) // core data — a failure here aborts the request
  if (err) throw new Error(err.error.message)

  const byDebt = {}
  ;(pa.data || []).forEach((r) => (byDebt[r.debt_id] = byDebt[r.debt_id] || []).push(mappers.payments.fromRow(r)))

  return {
    transactions: (tx.data || []).map(mappers.transactions.fromRow),
    debts: (de.data || []).map((r) => ({ ...mappers.debts.fromRow(r), payments: byDebt[r.id] || [] })),
    budgets: (bu.data || []).map(mappers.budgets.fromRow),
    recurring: (re.data || []).map(mappers.recurring.fromRow),
    // accounts.sql shipped after the core tables (see store.jsx) — degrade to
    // an empty list rather than failing the whole report if it's missing.
    accounts: ac.error ? [] : (ac.data || []).map(mappers.accounts.fromRow),
  }
}

// Category id -> display name, identical to store.jsx's `catInfo(id).name` —
// see lib/categories.js's catNameFromBudgets for the shared fallback chain.
export function catNameResolverFor(state) {
  return (id) => catNameFromBudgets(state.budgets, id)
}

// Account id -> display name. Only resolves MANUAL accounts/debts (the
// 'acct:<id>'/'debt:<id>' keys lib/accounts.js's accountTxKey assigns to a
// manual row's own transactions) — this route never loads plaid_items (out
// of scope for this feature; see the design doc), so a transaction filed
// under a real Plaid account_id falls back to showing that raw id.
// views/Reports.jsx (the client view) has the fuller picture — via
// usePlaidItems() — and builds its own richer resolver instead of this one.
export function accountNameResolverFor(state) {
  const debtById = new Map(state.debts.map((d) => [d.id, d.name]))
  const acctById = new Map(state.accounts.map((a) => [a.id, a.name]))
  return (key) => {
    if (!key) return 'Uncategorized'
    if (key.startsWith('debt:')) return debtById.get(key.slice(5)) || key
    if (key.startsWith('acct:')) return acctById.get(key.slice(5)) || key
    return key
  }
}
