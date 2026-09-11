// Server-only tool definitions + dispatcher for the finance chat (Step 2,
// 2026-09). Every tool is a pure function over the SAME snapshot-engine data
// app/api/reports/snapshot already loads (see lib/reports-server.js's
// loadReportState) — this file never talks to Supabase itself, so its
// outputs can never drift from what the Reports page/Excel export show.
//
// `runChatTool(name, input, ctx)` is what app/api/chat/route.js calls once
// per `tool_use` block the model asks for. `ctx = { state, plaidAccountNames,
// now }`:
//   state             -> lib/reports-server.js's loadReportState() result
//   plaidAccountNames -> Map<plaid_account_id, "Name ••mask"> (may be empty)
//   now               -> ISO date string treated as "today" (matches
//                        buildSnapshot's own `now` override so this stays
//                        testable without mocking the system clock)
//
// Every tool validates its own input and returns `{ error }` on anything bad
// rather than throwing — a throw would abort the whole chat turn; a model
// that got a bad category id, say, should be able to see the error and try
// again in the same turn.
import { periodsFor, buildSnapshot, buildSeries, compare, defaultRange, GRAINS, round2 } from './snapshots.js'
import { catNameResolverFor, accountNameResolverFor } from './reports-server.js'
import { simulatePlan, fmtMonths, recMonthly } from './finance.js'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const isISO = (s) => typeof s === 'string' && ISO_DATE.test(s)

function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

function clampInt(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, Math.round(n)))
}

// Small merchant-name fallback for a transaction with no `merchant` field —
// same rule lib/snapshots.js's own (unexported) cleanMerchant uses, copied
// rather than imported so this file's only real dependencies stay
// snapshots.js/reports-server.js/finance.js, matching that file's own stated
// reason for duplicating it instead of exporting it.
function fallbackMerchant(desc) {
  const s = String(desc || '')
  const z = s.match(/^ZELLE (.+)/i)
  if (z) return 'Zelle · ' + z[1].replace(/\s+[A-Z0-9]{8,}$/, '').trim()
  return s.split(' ').slice(0, 3).join(' ')
}

// Same shape finance.js's nextDueDate() computes, but parameterized on a
// reference date instead of always reading the real system clock — needed
// so upcoming_bills (and chat-briefing.js's own copy) stay deterministic
// against ctx.now instead of "whatever day the server happens to run on".
function nextDueDateFrom(day, fromISO) {
  const from = new Date(fromISO + 'T00:00:00')
  const dim = (y, m) => new Date(y, m + 1, 0).getDate()
  let d = new Date(from.getFullYear(), from.getMonth(), Math.min(day, dim(from.getFullYear(), from.getMonth())))
  if (d < from) d = new Date(from.getFullYear(), from.getMonth() + 1, Math.min(day, dim(from.getFullYear(), from.getMonth() + 1)))
  return d
}

// Account key -> display name. Prefers a REAL connected Plaid account's own
// name (ctx.plaidAccountNames, loaded by the route from plaid_items — see
// its header comment) over reports-server.js's accountNameResolverFor, which
// only ever knows manual 'acct:'/'debt:' rows (the server route that builds
// `state` never loads Plaid connections itself).
function buildAccountNameResolver(state, plaidAccountNames) {
  const fallback = accountNameResolverFor(state)
  return (key) => {
    if (!key) return 'Uncategorized'
    const plaidName = plaidAccountNames instanceof Map ? plaidAccountNames.get(key) : null
    return plaidName || fallback(key)
  }
}

function buildOpts(state, ctx) {
  return { catName: catNameResolverFor(state), accountName: buildAccountNameResolver(state, ctx.plaidAccountNames), now: ctx.now }
}

function monthsAgoISO(nowISO, n) {
  const [y, m] = nowISO.split('-').map(Number)
  const d = new Date(y, m - 1 - n, 1)
  return toISO(d)
}

// ---- get_snapshot ----
function trimSnapshot(s) {
  return {
    key: s.key, label: s.label, start: s.start, end: s.end,
    income: s.income, spending: s.spending, debtPayments: s.debtPayments, outflow: s.outflow, net: s.net,
    transactionCount: s.transactionCount,
    byCategory: s.byCategory.slice(0, 8),
    topMerchants: s.topMerchants.slice(0, 5),
    byAccount: s.byAccount.slice(0, 8),
    debtsEnd: s.debtsEnd.slice(0, 20), totalDebtEnd: s.totalDebtEnd,
    budgets: s.budgets, recurringDue: s.recurringDue,
  }
}

export function get_snapshot(input, ctx) {
  const { state, now } = ctx
  const grain = GRAINS.includes(input?.grain) ? input.grain : 'month'
  if (input?.to != null && !isISO(input.to)) return { error: 'to must be a YYYY-MM-DD date.' }
  if (input?.from != null && !isISO(input.from)) return { error: 'from must be a YYYY-MM-DD date.' }
  const to = input?.to || now
  const from = input?.from || defaultRange(grain, state.transactions, new Date(to + 'T00:00:00')).from

  const periods = periodsFor(grain, from, to)
  if (!periods.length) return { error: 'No period found for that range.' }
  const opts = buildOpts(state, ctx)
  const snapshots = periods.map((p) => buildSnapshot(state, p, opts))
  const latest = snapshots[snapshots.length - 1]
  const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null
  return { snapshot: trimSnapshot(latest), comparison: compare(latest, previous) }
}

// ---- spending_by_category ----
export function spending_by_category(input, ctx) {
  const { state } = ctx
  if (!isISO(input?.from) || !isISO(input?.to)) return { error: 'from and to must both be YYYY-MM-DD dates.' }
  const { from, to } = input.from <= input.to ? input : { from: input.to, to: input.from }
  const catName = catNameResolverFor(state)

  const txs = (state.transactions || []).filter((t) => t.date >= from && t.date <= to && t.type === 'expense' && t.cat !== 'transfer' && t.cat !== 'debt')
  const totalSpending = round2(txs.reduce((s, t) => s + t.amount, 0))

  if (input?.category_id) {
    const catTxs = txs.filter((t) => t.cat === input.category_id)
    const amount = round2(catTxs.reduce((s, t) => s + t.amount, 0))
    const merchMap = new Map()
    catTxs.forEach((t) => {
      const key = t.merchant || fallbackMerchant(t.desc)
      const cur = merchMap.get(key) || { amount: 0, count: 0 }
      cur.amount += t.amount; cur.count += 1
      merchMap.set(key, cur)
    })
    const merchants = [...merchMap.entries()]
      .map(([merchant, v]) => ({ merchant, amount: round2(v.amount), count: v.count }))
      .sort((a, b) => b.amount - a.amount)
      .slice(0, 15)
    return {
      from, to,
      category: { id: input.category_id, name: catName(input.category_id), amount, count: catTxs.length, pctOfSpending: totalSpending > 0 ? round2((amount / totalSpending) * 100) : 0 },
      merchants,
    }
  }

  const catMap = new Map()
  txs.forEach((t) => {
    const cur = catMap.get(t.cat) || { amount: 0, count: 0 }
    cur.amount += t.amount; cur.count += 1
    catMap.set(t.cat, cur)
  })
  const categories = [...catMap.entries()]
    .map(([id, v]) => ({ id, name: catName(id), amount: round2(v.amount), count: v.count, pctOfSpending: totalSpending > 0 ? round2((v.amount / totalSpending) * 100) : 0 }))
    .sort((a, b) => b.amount - a.amount)
  return { from, to, totalSpending, categories }
}

// ---- search_transactions ----
export function search_transactions(input, ctx) {
  const { state } = ctx
  if (input?.from != null && !isISO(input.from)) return { error: 'from must be a YYYY-MM-DD date.' }
  if (input?.to != null && !isISO(input.to)) return { error: 'to must be a YYYY-MM-DD date.' }
  if (input?.min_amount != null && typeof input.min_amount !== 'number') return { error: 'min_amount must be a number.' }
  if (input?.max_amount != null && typeof input.max_amount !== 'number') return { error: 'max_amount must be a number.' }
  const limit = clampInt(input?.limit, 1, 50, 25)

  const catName = catNameResolverFor(state)
  const acctName = buildAccountNameResolver(state, ctx.plaidAccountNames)
  const q = String(input?.query || '').trim().toLowerCase()
  const acctQ = String(input?.account || '').trim().toLowerCase()

  const matches = (state.transactions || []).filter((t) => {
    if (input?.from && t.date < input.from) return false
    if (input?.to && t.date > input.to) return false
    if (input?.category_id && t.cat !== input.category_id) return false
    if (input?.min_amount != null && t.amount < input.min_amount) return false
    if (input?.max_amount != null && t.amount > input.max_amount) return false
    if (q) {
      const hay = `${t.desc || ''} ${t.merchant || ''}`.toLowerCase()
      if (!hay.includes(q)) return false
    }
    if (acctQ) {
      const name = String(acctName(t.accountId) || '').toLowerCase()
      const raw = String(t.accountId || '').toLowerCase()
      if (!name.includes(acctQ) && !raw.includes(acctQ)) return false
    }
    return true
  })
  matches.sort((a, b) => b.date.localeCompare(a.date))

  const count = matches.length
  const sum = round2(matches.reduce((s, t) => s + t.amount, 0))
  const transactions = matches.slice(0, limit).map((t) => ({
    date: t.date, merchant: t.merchant || t.desc, amount: round2(t.amount), type: t.type,
    category: catName(t.cat), account: acctName(t.accountId),
  }))
  return { count, sum, transactions }
}

// ---- account_balance_history ----
export function account_balance_history(input, ctx) {
  const { state, now } = ctx
  if (input?.account_key != null && typeof input.account_key !== 'string') return { error: 'account_key must be a string.' }
  const months = clampInt(input?.months, 1, 24, 6)
  const from = monthsAgoISO(now, months - 1)
  const opts = buildOpts(state, ctx)
  const series = buildSeries(state, 'month', from, now, opts)

  if (input?.account_key) {
    const acctName = buildAccountNameResolver(state, ctx.plaidAccountNames)
    const months_ = series.map((s) => {
      const row = s.byAccount.find((a) => a.accountKey === input.account_key)
      return { period: s.label, spending: row ? row.spending : 0, income: row ? row.income : 0 }
    })
    return { account: acctName(input.account_key), months: months_ }
  }

  const months_ = series.map((s) => ({ period: s.label, income: s.income, spending: s.spending, net: s.net }))
  return { months: months_ }
}

// ---- list_debts ----
export function list_debts(_input, ctx) {
  const { state } = ctx
  const debts = (state.debts || []).map((d) => {
    const last = (d.payments || []).slice().sort((a, b) => b.date.localeCompare(a.date))[0] || null
    return {
      name: d.name, balance: round2(d.balance), apr: d.apr || null, min: round2(d.min || 0),
      dueDay: d.dueDay ?? null, type: d.limit ? 'credit_card' : 'loan',
      lastPayment: last ? { date: last.date, amount: round2(last.amount) } : null,
    }
  }).sort((a, b) => b.balance - a.balance)
  return {
    debts,
    totalBalance: round2(debts.reduce((s, d) => s + d.balance, 0)),
    totalMinPayment: round2(debts.reduce((s, d) => s + d.min, 0)),
    count: debts.length,
  }
}

// ---- debt_payoff_projection ----
export function debt_payoff_projection(input, ctx) {
  const { state } = ctx
  const strategy = input?.strategy == null ? 'avalanche' : input.strategy
  if (strategy !== 'avalanche' && strategy !== 'snowball') return { error: "strategy must be 'avalanche' or 'snowball'." }
  const extra = input?.extra_monthly == null ? 0 : Number(input.extra_monthly)
  if (!Number.isFinite(extra) || extra < 0) return { error: 'extra_monthly must be a non-negative number.' }

  const debts = (state.debts || []).filter((d) => d.balance > 0.005)
  if (!debts.length) return { strategy, months: 0, totalInterest: 0, order: [], done: true, message: 'No outstanding debt.' }

  const minTotal = round2(debts.reduce((s, d) => s + (d.min || 0), 0))
  const budget = round2(minTotal + extra)
  if (budget <= 0) return { error: 'Total monthly budget must be greater than zero — set minimum payments or add extra_monthly.' }

  const result = simulatePlan(debts, budget, strategy)
  const order = Object.entries(result.payoffs)
    .map(([name, date]) => ({ name, payoffDate: toISO(date) }))
    .sort((a, b) => a.payoffDate.localeCompare(b.payoffDate))

  return {
    strategy, monthlyBudget: budget, months: result.months, monthsLabel: fmtMonths(result.months),
    totalInterest: round2(result.totalInterest), done: result.done, order,
  }
}

// ---- upcoming_bills ----
export function upcoming_bills(input, ctx) {
  const { state, now } = ctx
  const days = clampInt(input?.days, 1, 365, 30)
  const catName = catNameResolverFor(state)
  const nowDate = new Date(now + 'T00:00:00')
  const cutoff = new Date(nowDate); cutoff.setDate(cutoff.getDate() + days)

  const bills = (state.recurring || [])
    .filter((r) => r.active !== false && r.dueDay)
    .map((r) => ({ desc: r.desc, category: catName(r.cat), due: nextDueDateFrom(r.dueDay, now), amount: round2(r.amount), monthlyEquivalent: round2(recMonthly(r)) }))
    .filter((b) => b.due >= nowDate && b.due <= cutoff)
    .sort((a, b) => a.due - b.due)
    .map(({ due, ...rest }) => ({ ...rest, dueDate: toISO(due) }))

  return { days, bills, total: round2(bills.reduce((s, b) => s + b.amount, 0)), count: bills.length }
}

// ---- budget_status ----
export function budget_status(input, ctx) {
  const { state, now } = ctx
  let month = input?.month
  if (month != null && !/^\d{4}-\d{2}$/.test(month)) return { error: 'month must be YYYY-MM.' }
  if (!month) month = now.slice(0, 7)
  const [y, m] = month.split('-').map(Number)
  const start = `${month}-01`
  const end = toISO(new Date(y, m, 0))
  const opts = buildOpts(state, ctx)
  const snap = buildSnapshot(state, { key: month, label: month, start, end }, opts)

  const categories = (snap.budgets || []).map((b) => ({ id: b.id, name: b.name, budget: b.limit, spent: b.spent, remaining: b.remaining, pct: b.pct }))
  return {
    month, categories,
    totalBudget: round2(categories.reduce((s, c) => s + c.budget, 0)),
    totalSpent: round2(categories.reduce((s, c) => s + c.spent, 0)),
  }
}

// ---- Anthropic tool definitions ----
export const CHAT_TOOLS = [
  {
    name: 'get_snapshot',
    description: "Financial snapshot (income, spending, net, top categories/merchants/accounts, debt balances, budget status) for the period containing `to` (default: today's period at the given grain), plus a comparison to the prior period. Use this for \"how am I doing\" / \"this month vs last month\" style questions.",
    input_schema: {
      type: 'object',
      properties: {
        grain: { type: 'string', enum: GRAINS, description: "Bucket size. Default 'month'." },
        from: { type: 'string', description: 'ISO date (YYYY-MM-DD) — start of the window to consider. Omit for a sensible default.' },
        to: { type: 'string', description: 'ISO date (YYYY-MM-DD) — the snapshot covers the period containing this date. Omit for the current period.' },
      },
    },
  },
  {
    name: 'spending_by_category',
    description: 'Total spending per category over a date range, with % of total spending. Pass category_id to drill into one category and get its top merchants instead. Category ids/names are listed in the briefing.',
    input_schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'ISO date (YYYY-MM-DD), required.' },
        to: { type: 'string', description: 'ISO date (YYYY-MM-DD), required.' },
        category_id: { type: 'string', description: 'Optional category id to drill into (see the briefing for valid ids).' },
      },
      required: ['from', 'to'],
    },
  },
  {
    name: 'search_transactions',
    description: 'Search/filter individual transactions by free-text query, category, account, amount range, and/or date range. Returns matching rows (capped at 50) plus the total count and sum across ALL matches, not just the returned rows.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Free-text match against the transaction description/merchant.' },
        category_id: { type: 'string' },
        account: { type: 'string', description: 'Match against an account name or key (e.g. "Chase", "Capital One").' },
        min_amount: { type: 'number' },
        max_amount: { type: 'number' },
        from: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
        to: { type: 'string', description: 'ISO date (YYYY-MM-DD).' },
        limit: { type: 'integer', description: 'Max rows to return, default 25, hard cap 50.' },
      },
    },
  },
  {
    name: 'account_balance_history',
    description: 'Per-month spending/income for one account (pass account_key from the briefing) or, if account_key is omitted, totals across all accounts.',
    input_schema: {
      type: 'object',
      properties: {
        account_key: { type: 'string', description: 'An account key from the briefing. Omit for all accounts combined.' },
        months: { type: 'integer', description: 'How many trailing months, default 6, max 24.' },
      },
    },
  },
  {
    name: 'list_debts',
    description: "List every tracked debt (credit card or loan) with balance, APR, minimum payment, due day, and the most recent payment, plus totals across all debts.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'debt_payoff_projection',
    description: "Simulate paying off all debts with a fixed monthly budget (sum of minimum payments plus extra_monthly), directing any extra toward the highest-APR debt ('avalanche', saves the most interest) or the smallest balance ('snowball', clears a debt fastest for motivation). Returns months to debt-free, total interest paid, and the payoff order.",
    input_schema: {
      type: 'object',
      properties: {
        extra_monthly: { type: 'number', description: 'Extra dollars per month above the sum of minimum payments. Default 0.' },
        strategy: { type: 'string', enum: ['avalanche', 'snowball'], description: "Default 'avalanche'." },
      },
    },
  },
  {
    name: 'upcoming_bills',
    description: 'Recurring bills due within the next N days, with each amount and its monthly-equivalent (for bills that recur less often than monthly), plus the total due.',
    input_schema: {
      type: 'object',
      properties: { days: { type: 'integer', description: 'Look-ahead window in days, default 30.' } },
    },
  },
  {
    name: 'budget_status',
    description: 'For a given month (default: current month), each budgeted category\'s limit, amount spent so far, remaining, and % used.',
    input_schema: {
      type: 'object',
      properties: { month: { type: 'string', description: 'YYYY-MM. Omit for the current month.' } },
    },
  },
]

const TOOL_FNS = {
  get_snapshot, spending_by_category, search_transactions, account_balance_history,
  list_debts, debt_payoff_projection, upcoming_bills, budget_status,
}

export function runChatTool(name, input, ctx) {
  const fn = TOOL_FNS[name]
  if (!fn) return { error: `Unknown tool: ${name}` }
  try {
    return fn(input || {}, ctx)
  } catch (e) {
    return { error: e?.message || 'Tool failed.' }
  }
}
