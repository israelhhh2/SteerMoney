// Unit tests for lib/chat-tools.js + lib/chat-briefing.js — plain
// `node --test`, no framework dependency (matches __tests__/snapshots.test.mjs).
// Run with:
//   node --test src/lib/__tests__/
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { search_transactions, upcoming_bills, budget_status, get_snapshot, spending_by_category, list_debts, debt_payoff_projection, account_balance_history } from '../chat-tools.js'
import { buildBriefing } from '../chat-briefing.js'

// ---- fixture state (shape matches lib/reports-server.js's loadReportState) ----
function fixtureState() {
  return {
    transactions: [
      { id: 't1', date: '2026-09-01', desc: 'ACME Payroll', amount: 3000, type: 'income', cat: 'income' },
      { id: 't2', date: '2026-09-03', desc: 'WHOLE FOODS MARKET', merchant: 'Whole Foods', amount: 85.5, type: 'expense', cat: 'groceries', accountId: 'plaid_checking_1' },
      { id: 't3', date: '2026-09-10', desc: 'STARBUCKS #123', merchant: 'Starbucks', amount: 6.25, type: 'expense', cat: 'dining', accountId: 'plaid_checking_1' },
      { id: 't4', date: '2026-09-12', desc: 'CHIPOTLE ONLINE', merchant: 'Chipotle', amount: 14.0, type: 'expense', cat: 'dining', accountId: 'plaid_credit_1' },
      { id: 't5', date: '2026-09-15', desc: 'Card payment', amount: 200, type: 'expense', cat: 'debt', accountId: 'plaid_checking_1' },
      { id: 't6', date: '2026-08-20', desc: 'WHOLE FOODS MARKET', merchant: 'Whole Foods', amount: 60, type: 'expense', cat: 'groceries', accountId: 'plaid_checking_1' },
    ],
    debts: [
      { id: 'd1', name: 'Chase Freedom', balance: 1200, apr: '22%', min: 35, dueDay: 18, limit: 5000, payments: [{ id: 'p1', date: '2026-08-18', amount: 50 }] },
      { id: 'd2', name: 'Car Loan', balance: 8000, apr: '6%', min: 220, dueDay: 5, limit: null, payments: [] },
    ],
    budgets: [
      { id: 'groceries', name: 'Groceries', limit: 400 },
      { id: 'dining', name: 'Dining Out', limit: 100 },
      { id: 'other', name: 'Other', limit: 0 },
    ],
    recurring: [
      { id: 'r1', desc: 'Netflix', amount: 15.49, dueDay: 20, cat: 'subscriptions', active: true, every: 1 },
      { id: 'r2', desc: 'Car Insurance', amount: 600, dueDay: 25, cat: 'auto', active: true, every: 6 },
      { id: 'r3', desc: 'Old gym (cancelled)', amount: 40, dueDay: 1, cat: 'health', active: false },
    ],
    accounts: [],
  }
}

const ctx = () => ({
  state: fixtureState(),
  plaidAccountNames: new Map([['plaid_checking_1', 'Chase Checking ••1111'], ['plaid_credit_1', 'Chase Freedom ••2222']]),
  now: '2026-09-16',
})

// ---- search_transactions ----
test('search_transactions: filters by query, category, and date range', () => {
  const r = search_transactions({ query: 'whole foods', from: '2026-09-01', to: '2026-09-30' }, ctx())
  assert.equal(r.count, 1)
  assert.equal(r.transactions.length, 1)
  assert.equal(r.transactions[0].merchant, 'Whole Foods')
  assert.equal(r.transactions[0].account, 'Chase Checking ••1111')
})

test('search_transactions: category_id filter across the whole history', () => {
  const r = search_transactions({ category_id: 'dining' }, ctx())
  assert.equal(r.count, 2)
  assert.equal(r.sum, 20.25)
})

test('search_transactions: limit caps returned rows but not count/sum', () => {
  const r = search_transactions({ category_id: 'groceries', limit: 1 }, ctx())
  assert.equal(r.count, 2) // both grocery transactions matched
  assert.equal(r.transactions.length, 1) // but only 1 returned
  assert.equal(r.sum, 145.5) // sum still covers all matches, not just the returned row
})

test('search_transactions: limit is hard-capped at 50 even if a caller asks for more', () => {
  const r = search_transactions({ limit: 500 }, ctx())
  assert.ok(r.transactions.length <= 50)
})

test('search_transactions: min_amount/max_amount range', () => {
  const r = search_transactions({ min_amount: 10, max_amount: 50 }, ctx())
  assert.equal(r.count, 1)
  assert.equal(r.transactions[0].merchant, 'Chipotle')
})

// ---- upcoming_bills ----
test('upcoming_bills: only includes active bills due within the window', () => {
  const r = upcoming_bills({ days: 7 }, ctx()) // now = 2026-09-16 -> window through 2026-09-23
  const descs = r.bills.map((b) => b.desc)
  assert.ok(descs.includes('Netflix')) // due the 20th, active, within 7 days
  assert.ok(!descs.includes('Old gym (cancelled)')) // inactive, must never appear
  assert.ok(!descs.includes('Car Insurance')) // due the 25th, outside the 7-day window
})

test('upcoming_bills: a wider window picks up bills further out, with monthly-equivalent math', () => {
  const r = upcoming_bills({ days: 15 }, ctx())
  const insurance = r.bills.find((b) => b.desc === 'Car Insurance')
  assert.ok(insurance) // due the 25th, within a 15-day window
  assert.equal(insurance.amount, 600)
  assert.equal(insurance.monthlyEquivalent, 100) // $600 every 6 months = $100/mo
})

test('upcoming_bills: total sums only the returned bills', () => {
  const r = upcoming_bills({ days: 7 }, ctx())
  const expected = r.bills.reduce((s, b) => s + b.amount, 0)
  assert.equal(r.total, Math.round(expected * 100) / 100)
})

// ---- budget_status ----
test('budget_status: spent/remaining/pct math for the given month', () => {
  const r = budget_status({ month: '2026-09' }, ctx())
  const groceries = r.categories.find((c) => c.id === 'groceries')
  assert.equal(groceries.budget, 400)
  assert.equal(groceries.spent, 85.5) // only the Sep transaction, not the Aug one
  assert.equal(groceries.remaining, 314.5)
  assert.equal(groceries.pct, Math.round((85.5 / 400) * 10000) / 100)
  // 'other' has limit 0 -> buildSnapshot excludes it from the budgeted list entirely
  assert.ok(!r.categories.some((c) => c.id === 'other'))
})

test('budget_status: defaults to the current month (from ctx.now) when month is omitted', () => {
  const r = budget_status({}, ctx())
  assert.equal(r.month, '2026-09')
})

// ---- bad-input error shape ----
test('bad input returns { error } instead of throwing', () => {
  assert.ok(spending_by_category({ from: 'not-a-date', to: '2026-09-30' }, ctx()).error)
  assert.ok(spending_by_category({ from: '2026-09-01' }, ctx()).error) // missing `to`
  assert.ok(search_transactions({ min_amount: 'lots' }, ctx()).error)
  assert.ok(budget_status({ month: '2026/09' }, ctx()).error)
  assert.ok(debt_payoff_projection({ strategy: 'bogus' }, ctx()).error)
  assert.ok(debt_payoff_projection({ extra_monthly: -5 }, ctx()).error)
  assert.ok(get_snapshot({ grain: 'century' }, ctx()).snapshot) // unknown grain silently falls back to 'month', not an error
  assert.ok(account_balance_history({ account_key: 42 }, ctx()).error) // must be a string
})

// ---- get_snapshot / spending_by_category sanity ----
test('get_snapshot: returns a trimmed snapshot + comparison for the period containing `to`', () => {
  const r = get_snapshot({ grain: 'month', to: '2026-09-16' }, ctx())
  assert.equal(r.snapshot.key, '2026-09')
  assert.ok(r.snapshot.byCategory.length <= 8)
  assert.ok(r.comparison)
})

test('spending_by_category: category drill-down returns top merchants for just that category', () => {
  const r = spending_by_category({ from: '2026-09-01', to: '2026-09-30', category_id: 'dining' }, ctx())
  assert.equal(r.category.count, 2)
  assert.equal(r.merchants.length, 2)
})

// ---- list_debts / debt_payoff_projection sanity ----
test('list_debts: totals across all debts', () => {
  const r = list_debts({}, ctx())
  assert.equal(r.count, 2)
  assert.equal(r.totalBalance, 9200)
  assert.equal(r.totalMinPayment, 255)
})

test('debt_payoff_projection: avalanche prioritizes the higher-APR debt', () => {
  const r = debt_payoff_projection({ extra_monthly: 100, strategy: 'avalanche' }, ctx())
  assert.ok(r.months > 0)
  assert.ok(r.order.length === 2)
  assert.equal(r.order[0].name, 'Chase Freedom') // higher APR (22% vs 6%) pays off first
})

// ---- briefing size + content ----
test('buildBriefing stays well under ~6,000 chars on a normal-sized state', () => {
  const text = buildBriefing(fixtureState(), { now: '2026-09-16', plaidAccountNames: ctx().plaidAccountNames })
  assert.ok(text.length < 6000, `briefing was ${text.length} chars`)
  assert.match(text, /Today's date: 2026-09-16/)
  assert.match(text, /Chase Freedom/)
  assert.match(text, /groceries=Groceries/)
})
