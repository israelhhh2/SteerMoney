// Snapshot engine (Reports feature, 2026-09) — PURE functions only: no React,
// no Supabase, no `window`/`document`. This is what makes the math identical
// whether it runs in the browser (views/Reports.jsx, computed straight off
// useApp() state — instant, no round trip) or on the server (app/api/reports/
// snapshot, app/api/reports/export — same functions, a Supabase-loaded state
// shaped the same way via lib/mappers.js). Never import anything
// React/Supabase/browser-specific into this file.
//
// Labels/keys below are always English (e.g. "Sep 2026", "Wk of Sep 8") —
// this is a data layer, not a view; a caller that wants localized labels
// re-derives them from `start`/`end` using lib/i18n.js the same way every
// other chart in this app already does (see Charts.jsx's ymLabel/monthLabel).
// Relative imports below carry an explicit `.js` extension (unlike the rest
// of this codebase, which relies on webpack's extensionless resolution) so
// this file — and everything it pulls in — can also be run directly by
// plain `node --test` (see __tests__/snapshots.test.mjs and src/lib/
// package.json's "type": "module") with zero bundler in front of it.
import { recMonthly, findPaidTx } from './finance.js'

const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
export const GRAINS = ['day', 'week', 'month', 'quarter', 'year']

// ---- date helpers (deliberately not lib/utils.js's isoDate/today — those
// are fine to reuse for formatting, see srcLabel above, but today() reads the
// real clock with no way to pin it in a test; buildSnapshot below takes an
// explicit `now` instead, defaulting to real "today" only at the call site) ----
function parseISO(iso) {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(y, m - 1, d)
}
function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
function addDays(d, n) { const r = new Date(d); r.setDate(r.getDate() + n); return r }
function mondayOf(d) {
  const day = d.getDay() // 0=Sun..6=Sat
  return addDays(d, day === 0 ? -6 : 1 - day)
}
// Standard ISO-8601 week number: the week containing a year's first Thursday
// is week 1, so a week can belong to a different "week-year" than its
// Monday's calendar year (e.g. Mon Dec 29, 2025 is in 2026-W01) — the exact
// case the design spec calls out as "week boundaries ... year boundary".
function isoWeekInfo(monday) {
  const thursday = addDays(monday, 3)
  const year = thursday.getFullYear()
  // Week 1 is, by definition, the week containing Jan 4 — so week 1's own
  // Thursday is Jan 4 adjusted to that same week (Mon=0..Sun=6 offset).
  const jan4 = new Date(year, 0, 4)
  const week1Thursday = addDays(jan4, 3 - ((jan4.getDay() + 6) % 7))
  const week = 1 + Math.round((thursday - week1Thursday) / (7 * 86400000))
  return { week, year }
}
export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100

// Merchant-name fallback for topMerchants when a transaction has no
// `merchant` field (pre-Plaid-categorization history, manual entries) — a
// deliberately small subset of lib/utils.js's srcLabel() (the same fallback
// Charts.jsx's own "Top merchants" chart uses), copied rather than imported
// so this file's only dependency stays finance.js (no clsx/tailwind-merge in
// the require graph of a file meant to run under plain `node --test`).
function cleanMerchant(desc) {
  const s = String(desc || '')
  const z = s.match(/^ZELLE (.+)/i)
  if (z) return 'Zelle · ' + z[1].replace(/\s+[A-Z0-9]{8,}$/, '').trim()
  return s.split(' ').slice(0, 3).join(' ')
}

// periodsFor(grain, from, to) -> ordered array of { key, label, start, end }.
// `from`/`to` select which whole calendar buckets to include (any bucket
// whose own start falls in [bucket-of-from, bucket-of-to]) — each bucket's
// own start/end always span the FULL calendar unit (e.g. the whole month),
// matching how the rest of this app buckets by date (store.jsx's monthTx
// uses a plain `.startsWith(ym)`, not a clipped range).
export function periodsFor(grain, from, to) {
  if (!GRAINS.includes(grain)) throw new Error(`Unknown grain: ${grain}`)
  const fromD = parseISO(from), toD = parseISO(to)
  const out = []

  if (grain === 'day') {
    for (let d = fromD; d <= toD; d = addDays(d, 1)) {
      const iso = toISO(d)
      out.push({ key: iso, label: `${MONTH_ABBR[d.getMonth()]} ${d.getDate()}`, start: iso, end: iso })
    }
    return out
  }

  if (grain === 'week') {
    const lastMonday = mondayOf(toD)
    for (let monday = mondayOf(fromD); monday <= lastMonday; monday = addDays(monday, 7)) {
      const sunday = addDays(monday, 6)
      const { week, year } = isoWeekInfo(monday)
      out.push({
        key: `${year}-W${String(week).padStart(2, '0')}`,
        label: `Wk of ${MONTH_ABBR[monday.getMonth()]} ${monday.getDate()}`,
        start: toISO(monday), end: toISO(sunday),
      })
    }
    return out
  }

  if (grain === 'month') {
    const last = new Date(toD.getFullYear(), toD.getMonth(), 1)
    for (let d = new Date(fromD.getFullYear(), fromD.getMonth(), 1); d <= last; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      const y = d.getFullYear(), m = d.getMonth()
      const end = new Date(y, m + 1, 0)
      out.push({ key: `${y}-${String(m + 1).padStart(2, '0')}`, label: `${MONTH_ABBR[m]} ${y}`, start: toISO(d), end: toISO(end) })
    }
    return out
  }

  if (grain === 'quarter') {
    const qStart = (d) => new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)
    const last = qStart(toD)
    for (let d = qStart(fromD); d <= last; d = new Date(d.getFullYear(), d.getMonth() + 3, 1)) {
      const y = d.getFullYear(), q = d.getMonth() / 3 + 1
      const end = new Date(d.getFullYear(), d.getMonth() + 3, 0)
      out.push({ key: `${y}-Q${q}`, label: `Q${q} ${y}`, start: toISO(d), end: toISO(end) })
    }
    return out
  }

  // year
  for (let y = fromD.getFullYear(); y <= toD.getFullYear(); y++) {
    out.push({ key: String(y), label: String(y), start: `${y}-01-01`, end: `${y}-12-31` })
  }
  return out
}

// A month-grain period always spans exactly one full calendar month (start
// is the 1st, end is that same month's last day) — buildSnapshot below uses
// this instead of taking an explicit `grain` argument to decide whether
// budgets/recurringDue apply, since no other grain's period ever happens to
// span exactly one whole month (a quarter spans three, a week never aligns
// to month boundaries, a day/year are the wrong span entirely).
function isFullMonthPeriod(period) {
  const s = parseISO(period.start), e = parseISO(period.end)
  if (s.getDate() !== 1) return false
  const lastDay = new Date(s.getFullYear(), s.getMonth() + 1, 0)
  return e.getTime() === lastDay.getTime()
}

const sumWhere = (txs, pred) => round2(txs.reduce((s, t) => (pred(t) ? s + t.amount : s), 0))

// buildSnapshot({ transactions, debts, budgets, accounts, recurring }, period, opts)
// -> the one Snapshot shape both views/Reports.jsx and app/api/reports/* hand
// back to their callers. `opts`:
//   catName(id)     -> display name for a category id (default: identity).
//                      Server routes resolve this via lib/categories.js's
//                      catNameFromBudgets(); Reports.jsx just uses its own
//                      catInfo() from useApp().
//   accountName(key) -> display name for a transaction's accountId (default:
//                      the raw key, or 'Uncategorized' for none). Reports.jsx
//                      resolves this via lib/accounts.js's buildAccountInventory
//                      (it has Plaid data); the server routes only resolve
//                      manual accounts/debts — see lib/reports-server.js.
//   now             -> ISO date treated as "today" for debtsEnd's balance
//                      reconstruction (default: the real today) — overridable
//                      so this stays testable without mocking the system clock.
export function buildSnapshot(data, period, opts = {}) {
  const transactions = data.transactions || [], debts = data.debts || [], budgets = data.budgets || []
  const recurring = data.recurring || []
  const catName = opts.catName || ((id) => id)
  const accountName = opts.accountName || ((key) => key || 'Uncategorized')
  const now = opts.now || toISO(new Date())

  const txs = transactions.filter((t) => t.date >= period.start && t.date <= period.end)

  // Same income/spending/debt-payment/refund definitions store.jsx's own
  // incomeIn/expensesIn use (transfer excluded from both; refund excluded
  // from income too — see store.jsx's incomeIn comment for why a credit-card
  // refund isn't real income) — this is the one place that math is spelled
  // out for every grain, client AND server.
  const income = sumWhere(txs, (t) => t.type === 'income' && t.cat !== 'transfer' && t.cat !== 'refund')
  const spending = sumWhere(txs, (t) => t.type === 'expense' && t.cat !== 'transfer' && t.cat !== 'debt')
  const debtPayments = sumWhere(txs, (t) => t.type === 'expense' && t.cat === 'debt')
  const refunds = sumWhere(txs, (t) => t.type === 'income' && t.cat === 'refund')
  const outflow = round2(spending + debtPayments)
  const net = round2(income - outflow)

  const catTotals = new Map()
  txs.forEach((t) => {
    if (t.type !== 'expense' || t.cat === 'transfer' || t.cat === 'debt') return
    const cur = catTotals.get(t.cat) || { amount: 0, count: 0 }
    cur.amount += t.amount; cur.count += 1
    catTotals.set(t.cat, cur)
  })
  const byCategory = [...catTotals.entries()]
    .map(([id, v]) => ({ id, name: catName(id), amount: round2(v.amount), count: v.count, pctOfSpending: spending > 0 ? round2((v.amount / spending) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount)

  const acctTotals = new Map()
  txs.forEach((t) => {
    const key = t.accountId || null
    const cur = acctTotals.get(key) || { spending: 0, income: 0, count: 0 }
    if (t.type === 'expense' && t.cat !== 'transfer') cur.spending += t.amount
    if (t.type === 'income' && t.cat !== 'transfer' && t.cat !== 'refund') cur.income += t.amount
    cur.count += 1
    acctTotals.set(key, cur)
  })
  const byAccount = [...acctTotals.entries()]
    .map(([key, v]) => ({ accountKey: key, name: accountName(key), spending: round2(v.spending), income: round2(v.income), count: v.count }))
    .sort((a, b) => b.spending - a.spending)

  const merchTotals = new Map()
  txs.forEach((t) => {
    if (t.type !== 'expense' || t.cat === 'transfer' || t.cat === 'debt') return
    const key = t.merchant || cleanMerchant(t.desc)
    const cur = merchTotals.get(key) || { amount: 0, count: 0 }
    cur.amount += t.amount; cur.count += 1
    merchTotals.set(key, cur)
  })
  const topMerchants = [...merchTotals.entries()]
    .map(([merchant, v]) => ({ merchant, amount: round2(v.amount), count: v.count }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 10)

  // budgets/recurringDue only make sense for a period that IS one calendar
  // month (see isFullMonthPeriod above) — a week or a quarter has no single
  // "monthly limit" to compare against.
  let budgetsOut = null, recurringDue = null
  if (isFullMonthPeriod(period)) {
    budgetsOut = budgets.filter((b) => b.limit > 0).map((b) => {
      const spent = sumWhere(txs, (t) => t.type === 'expense' && t.cat === b.id)
      return { id: b.id, name: b.name, limit: b.limit, spent, remaining: round2(b.limit - spent), pct: b.limit > 0 ? round2((spent / b.limit) * 100) : 0 }
    })
    const active = recurring.filter((r) => r.active !== false)
    let expected = 0, matched = 0
    active.forEach((r) => {
      const amt = recMonthly(r)
      expected += amt
      if (findPaidTx(r, txs)) matched += amt
    })
    recurringDue = { expected: round2(expected), matched: round2(matched), count: active.length }
  }

  // Balance at period END: for a period that ends today or in the future,
  // the debt's CURRENT balance already IS the balance at that end date. For
  // a period fully in the past, walk backward from today's balance by adding
  // back every payment dated AFTER period.end (a payment only ever reduces a
  // balance, so undoing one raises it back to what it was) — same technique
  // lib/accounts.js's debtsOn() uses for the Accounts header chart, just
  // reconstructing one point instead of a whole daily series.
  const debtsEnd = debts.map((d) => {
    let balance = d.balance
    if (period.end < now) {
      const future = (d.payments || []).filter((p) => p.date > period.end)
      balance = d.balance + future.reduce((s, p) => s + p.amount, 0)
    }
    return { id: d.id, name: d.name, balance: round2(Math.max(0, balance)) }
  })
  const totalDebtEnd = round2(debtsEnd.reduce((s, d) => s + d.balance, 0))

  return {
    key: period.key, label: period.label, start: period.start, end: period.end,
    income, spending, debtPayments, refunds, outflow, net,
    byCategory, byAccount, topMerchants, transactionCount: txs.length,
    budgets: budgetsOut, debtsEnd, totalDebtEnd, recurringDue,
  }
}

// buildSeries(data, grain, from, to, opts) -> [Snapshot, ...], oldest first —
// just periodsFor(...) mapped through buildSnapshot with the same opts, so
// every caller building a whole range (the Reports page's trend chart, the
// Excel export's per-grain sheets) only has one place to change if the
// period-to-snapshot wiring ever needs to.
export function buildSeries(data, grain, from, to, opts) {
  return periodsFor(grain, from, to).map((period) => buildSnapshot(data, period, opts))
}

function pctDelta(curr, prev) {
  const abs = round2(curr - prev)
  return { abs, pct: prev !== 0 ? round2((abs / Math.abs(prev)) * 100) : null }
}

// compare(curr, prev) -> { incomeDelta, spendingDelta, debtPaymentsDelta,
// netDelta, byCategoryDelta }. Each delta is { abs, pct } — `pct` is null
// (not 0 or Infinity) when `prev`
// was 0, since "up 100%" or "up infinity%" are both misleading when there
// was nothing to compare against; callers show the absolute amount instead
// in that case (see views/Reports.jsx's DeltaPill).
export function compare(curr, prev) {
  if (!curr) return null
  if (!prev) {
    return {
      incomeDelta: pctDelta(curr.income, 0), spendingDelta: pctDelta(curr.spending, 0),
      debtPaymentsDelta: pctDelta(curr.debtPayments || 0, 0), netDelta: pctDelta(curr.net, 0),
      byCategoryDelta: curr.byCategory.map((c) => ({ id: c.id, name: c.name, ...pctDelta(c.amount, 0) })),
    }
  }
  const prevByCat = new Map(prev.byCategory.map((c) => [c.id, c]))
  const currByCat = new Map(curr.byCategory.map((c) => [c.id, c]))
  const ids = new Set([...prevByCat.keys(), ...currByCat.keys()])
  const byCategoryDelta = [...ids]
    .map((id) => {
      const c = currByCat.get(id), p = prevByCat.get(id)
      return { id, name: (c || p).name, ...pctDelta(c?.amount || 0, p?.amount || 0) }
    })
    .sort((a, b) => Math.abs(b.abs) - Math.abs(a.abs))
  return {
    incomeDelta: pctDelta(curr.income, prev.income),
    spendingDelta: pctDelta(curr.spending, prev.spending),
    debtPaymentsDelta: pctDelta(curr.debtPayments || 0, prev.debtPayments || 0),
    netDelta: pctDelta(curr.net, prev.net),
    byCategoryDelta,
  }
}

// defaultRange(grain, transactions) -> { from, to }, a sensible window for
// each grain when the caller hasn't picked a custom one. `transactions` is
// only consulted for grain 'year' (need to know the earliest year with real
// data — every other grain's window is a fixed lookback from today) and
// defaults to [] so this is still callable with just a grain for a quick
// "this year only" fallback.
export function defaultRange(grain, transactions = [], now = new Date()) {
  const nowISO = toISO(now)
  if (grain === 'day') return { from: toISO(addDays(now, -29)), to: nowISO } // last 30 days, inclusive of today
  if (grain === 'week') return { from: toISO(addDays(mondayOf(now), -7 * 11)), to: nowISO } // last 12 weeks
  if (grain === 'month') return { from: toISO(new Date(now.getFullYear(), now.getMonth() - 11, 1)), to: nowISO } // last 12 months
  if (grain === 'quarter') {
    const qStartMonth = Math.floor(now.getMonth() / 3) * 3
    return { from: toISO(new Date(now.getFullYear(), qStartMonth - 21, 1)), to: nowISO } // last 8 quarters (7 back + current)
  }
  if (grain === 'year') {
    const years = transactions.map((t) => parseInt(String(t.date).slice(0, 4), 10)).filter((y) => Number.isFinite(y))
    const minYear = years.length ? Math.min(...years) : now.getFullYear()
    return { from: `${minYear}-01-01`, to: nowISO }
  }
  throw new Error(`Unknown grain: ${grain}`)
}
