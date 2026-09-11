// Single source of truth for this app's default expense-category taxonomy
// (Phase 2A categorization foundation, 2026-09). Categories ARE budgets rows
// (see store.jsx) — every id here becomes a `budgets` row with limit 0 for a
// brand-new account (freshState()) and is backfilled onto existing accounts
// once by store.jsx's "ensure default categories" step, gated by
// settings.categories_v (see supabase/categories-v2.sql and CATEGORIES_V
// below) so a category the user deliberately deletes doesn't keep coming
// back on every load.
//
// PRODUCTION CONTEXT: before this file existed, DEFAULT_CATEGORIES lived
// inline in store.jsx with only 6 ids (housing/groceries/dining/auto/
// utilities/other), and lib/plaid-categories.js's mapPlaidCategory()
// deliberately only ever mapped Plaid's rich personal_finance_category data
// onto those 6 — so 491 of 883 real transactions (56%) landed in 'other'
// even though Plaid had a specific category for nearly all of them. This
// file is the expanded taxonomy those categorizers now map onto; see
// lib/plaid-categories.js for the full PFC -> category table and
// lib/plaid-sync.js's CATEGORY_RULES for the keyword fallback.
//
// Exported from one place (not duplicated in store.jsx/Transactions.jsx/
// Charts.jsx/Budgets.jsx) because every one of those views already derives
// its category list/legend from `state.budgets` dynamically — the only
// thing that ever needed a hardcoded id/name list was the *default* set
// itself, plus the presentation lookups (icon/color/emoji) below.
export const CATEGORY_DEFS = [
  ['housing', 'Housing / Rent'],
  ['utilities', 'Utilities & Phone'],
  ['groceries', 'Groceries'],
  ['dining', 'Dining Out'],
  ['auto', 'Car & Gas'],
  ['transport', 'Transport & Rideshare'],
  ['shopping', 'Shopping'],
  ['entertainment', 'Entertainment'],
  ['subscriptions', 'Subscriptions'],
  ['health', 'Health & Medical'],
  ['personal', 'Personal Care'],
  ['household', 'Household'],
  ['kids', 'Kids'],
  ['family', 'Family & Gifts'],
  ['travel', 'Travel'],
  ['education', 'Education'],
  ['fees', 'Fees & Interest'],
  ['cash', 'Cash & ATM'],
  ['business', 'Business'],
  ['other', 'Other'],
]

// Bump whenever CATEGORY_DEFS grows and existing accounts should be
// backfilled with the new ids (see store.jsx's ensure-default-categories
// step). 1 = the original 6-category set (never explicitly versioned before
// this file existed — treated as the implicit starting point, since
// settings.categories_v is a brand-new column and reads as 0/undefined for
// every account that predates it). 2 = this Phase 2A expansion.
export const CATEGORIES_V = 2

// Presentation-only lookups, keyed by category id (plus the four fixed
// non-budget ids: debt/income/transfer/refund). Every consumer (catColor/
// catEmoji in lib/utils.js, CatIcon in components/shared.jsx) already falls
// back gracefully for an id it doesn't recognize, so a category added here
// without a matching entry below just renders with the generic default —
// never a crash.
export const CAT_COLORS = {
  housing: '#38bdf8', utilities: '#22d3ee', groceries: '#4ade80', dining: '#fbbf24',
  auto: '#fb923c', transport: '#60a5fa', shopping: '#f472b6', entertainment: '#e879f9',
  subscriptions: '#818cf8', health: '#fb7185', personal: '#c084fc', household: '#f97316',
  kids: '#facc15', family: '#a78bfa', travel: '#2dd4bf', education: '#a3e635',
  fees: '#ef4444', cash: '#5eead4', business: '#64748b', other: '#a1a1aa',
  debt: '#f87171', income: '#34d399', transfer: '#94a3b8',
  // 'refund' — merchant refund/return credited to a credit card. Treated
  // like 'transfer' everywhere income is totaled (see store.jsx's
  // incomeIn/dataMonths) — see lib/plaid-sync.js's classifyTx() for why this
  // category exists instead of a negative 'expense' amount.
  refund: '#94a3b8',
}

// Category id -> display name, without needing React/useApp() — mirrors
// store.jsx's `catInfo(id).name` fallback chain (a budgets row's own name,
// else one of the four fixed non-budget ids, else the raw id) as a plain
// function so server code (app/api/reports/*, which has no store to read)
// can resolve names the exact same way the client does. Kept here, not next
// to catInfo itself, since this file is already the taxonomy's single source
// of truth and — unlike store.jsx — has no 'use client' directive, so it's
// safe to import from a Route Handler.
const FIXED_CAT_NAMES = { debt: 'Debt Payment', income: 'Income', transfer: 'Transfer', refund: 'Refund' }
export function catNameFromBudgets(budgets, id) {
  const row = (budgets || []).find((b) => b.id === id)
  if (row) return row.name
  return FIXED_CAT_NAMES[id] || id || 'Other'
}

export const CAT_EMOJI = {
  housing: '🏡', utilities: '💡', groceries: '🥑', dining: '🍔',
  auto: '🚗', transport: '🚌', shopping: '🛍️', entertainment: '🎬',
  subscriptions: '📺', health: '🩺', personal: '💇', household: '🔧',
  kids: '🧸', family: '👨‍👩‍👧', travel: '✈️', education: '🎓',
  fees: '🧾', cash: '💵', business: '💼', other: '📦',
  debt: '💳', income: '💰', transfer: '🔁', refund: '↩️',
}
