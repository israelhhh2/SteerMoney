// Unit tests for lib/snapshots.js — plain `node --test`, no test framework
// dependency (per the design spec). Run with:
//   node --test src/lib/__tests__/snapshots.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { periodsFor, buildSnapshot, buildSeries, compare, defaultRange } from '../snapshots.js'

test('week grain: Monday start', () => {
  // Sep 8 2026 is a Tuesday — the week containing it must start on Monday Sep 7.
  const periods = periodsFor('week', '2026-09-08', '2026-09-08')
  assert.equal(periods.length, 1)
  assert.equal(periods[0].start, '2026-09-07')
  assert.equal(periods[0].end, '2026-09-13')
  assert.equal(periods[0].label, 'Wk of Sep 7')
})

test('week grain: ISO year-boundary week (Dec 29, 2025 - Jan 4, 2026 is 2026-W01)', () => {
  const periods = periodsFor('week', '2025-12-29', '2025-12-29')
  assert.equal(periods.length, 1)
  assert.equal(periods[0].start, '2025-12-29')
  assert.equal(periods[0].end, '2026-01-04')
  assert.equal(periods[0].key, '2026-W01')
})

test('week grain: the following week is 2026-W02', () => {
  const periods = periodsFor('week', '2026-01-05', '2026-01-05')
  assert.equal(periods[0].key, '2026-W02')
  assert.equal(periods[0].start, '2026-01-05')
})

test('quarter grain: keys and full-quarter spans', () => {
  const periods = periodsFor('quarter', '2026-08-01', '2026-08-01')
  assert.equal(periods.length, 1)
  assert.deepEqual(periods[0], { key: '2026-Q3', label: 'Q3 2026', start: '2026-07-01', end: '2026-09-30' })
})

test('quarter grain: a range spanning two quarters returns both, oldest first', () => {
  const periods = periodsFor('quarter', '2026-02-01', '2026-07-01')
  assert.deepEqual(periods.map((p) => p.key), ['2026-Q1', '2026-Q2', '2026-Q3'])
})

test('month grain: label format', () => {
  const periods = periodsFor('month', '2026-09-15', '2026-09-15')
  assert.deepEqual(periods[0], { key: '2026-09', label: 'Sep 2026', start: '2026-09-01', end: '2026-09-30' })
})

test('year grain', () => {
  const periods = periodsFor('year', '2024-06-01', '2026-01-01')
  assert.deepEqual(periods.map((p) => p.key), ['2024', '2025', '2026'])
  assert.equal(periods[0].start, '2024-01-01')
  assert.equal(periods[0].end, '2024-12-31')
})

// ---- income/spending/debt/transfer/refund exclusions (mirrors store.jsx's
// incomeIn/expensesIn — this is the money math every Reports number rests on) ----
const baseData = () => ({
  transactions: [
    { id: 't1', date: '2026-09-05', desc: 'Paycheck', amount: 3000, type: 'income', cat: 'income' },
    { id: 't2', date: '2026-09-06', desc: 'Refund', amount: 40, type: 'income', cat: 'refund' },
    { id: 't3', date: '2026-09-07', desc: 'Move to savings', amount: 500, type: 'income', cat: 'transfer' },
    { id: 't4', date: '2026-09-08', desc: 'Groceries', amount: 120, type: 'expense', cat: 'groceries' },
    { id: 't5', date: '2026-09-09', desc: 'Move from checking', amount: 500, type: 'expense', cat: 'transfer' },
    { id: 't6', date: '2026-09-10', desc: 'Card payment', amount: 200, type: 'expense', cat: 'debt' },
  ],
  debts: [], budgets: [], accounts: [], recurring: [],
})

test('buildSnapshot: income excludes transfer + refund; spending excludes transfer + debt', () => {
  const period = periodsFor('month', '2026-09-01', '2026-09-01')[0]
  const snap = buildSnapshot(baseData(), period)
  assert.equal(snap.income, 3000) // paycheck only — refund and transfer both excluded
  assert.equal(snap.spending, 120) // groceries only — transfer and debt both excluded
  assert.equal(snap.debtPayments, 200)
  assert.equal(snap.refunds, 40)
  assert.equal(snap.outflow, 320) // spending + debtPayments
  assert.equal(snap.net, 2680) // income - outflow
  assert.equal(snap.transactionCount, 6)
})

test('buildSnapshot: byCategory only counts real spending categories (not transfer/debt)', () => {
  const period = periodsFor('month', '2026-09-01', '2026-09-01')[0]
  const snap = buildSnapshot(baseData(), period)
  assert.deepEqual(snap.byCategory.map((c) => c.id), ['groceries'])
  assert.equal(snap.byCategory[0].pctOfSpending, 100)
})

test('buildSnapshot: a period with no matching transactions is all zeros, not a crash', () => {
  const period = periodsFor('month', '2025-01-01', '2025-01-01')[0]
  const snap = buildSnapshot(baseData(), period)
  assert.equal(snap.income, 0)
  assert.equal(snap.spending, 0)
  assert.equal(snap.transactionCount, 0)
  assert.deepEqual(snap.byCategory, [])
})

// ---- debtsEnd reconstruction ----
test('debtsEnd: a period ending today/future uses the current balance as-is', () => {
  const data = { transactions: [], budgets: [], accounts: [], recurring: [], debts: [
    { id: 'd1', name: 'Card', balance: 1000, payments: [{ date: '2026-09-20', amount: 200 }] },
  ] }
  const period = { key: 'k', label: 'l', start: '2026-09-01', end: '2026-09-30' }
  const snap = buildSnapshot(data, period, { now: '2026-09-15' }) // period.end (09-30) > now -> current balance
  assert.equal(snap.debtsEnd[0].balance, 1000)
})

test('debtsEnd: a past period adds back payments made after it (payments only reduce balance)', () => {
  const data = { transactions: [], budgets: [], accounts: [], recurring: [], debts: [
    { id: 'd1', name: 'Card', balance: 1000, payments: [
      { date: '2026-08-15', amount: 200 }, // during the period — already reflected in current balance
      { date: '2026-09-05', amount: 150 }, // AFTER the period — must be added back to reconstruct 08-31's balance
    ] },
  ] }
  const period = { key: 'k', label: 'l', start: '2026-08-01', end: '2026-08-31' }
  const snap = buildSnapshot(data, period, { now: '2026-09-15' })
  assert.equal(snap.debtsEnd[0].balance, 1150) // 1000 + the one payment dated after Aug 31
  assert.equal(snap.totalDebtEnd, 1150)
})

test('debtsEnd: never goes negative even if reconstruction overshoots', () => {
  const data = { transactions: [], budgets: [], accounts: [], recurring: [], debts: [
    { id: 'd1', name: 'Paid off card', balance: 0, payments: [{ date: '2026-09-05', amount: 50 }] },
  ] }
  const period = { key: 'k', label: 'l', start: '2026-08-01', end: '2026-08-31' }
  const snap = buildSnapshot(data, period, { now: '2026-09-15' })
  assert.equal(snap.debtsEnd[0].balance, 50)
  const snap2 = buildSnapshot({ ...data, debts: [{ id: 'd1', name: 'x', balance: -30, payments: [] }] }, period, { now: '2026-09-15' })
  assert.equal(snap2.debtsEnd[0].balance, 0)
})

// ---- compare() pct math ----
test('compare: pct is a normal percentage change when prev > 0', () => {
  const curr = { income: 1100, spending: 800, net: 300, byCategory: [] }
  const prev = { income: 1000, spending: 1000, net: 0, byCategory: [] }
  const cmp = compare(curr, prev)
  assert.equal(cmp.incomeDelta.abs, 100)
  assert.equal(cmp.incomeDelta.pct, 10) // +10%
  assert.equal(cmp.spendingDelta.abs, -200)
  assert.equal(cmp.spendingDelta.pct, -20) // -20%
  assert.equal(cmp.netDelta.pct, null) // prev net was 0 -> pct undefined, not Infinity
})

test('compare: prev === 0 (or no prior period at all) yields pct: null, not Infinity/NaN', () => {
  const curr = { income: 500, spending: 0, net: 500, byCategory: [{ id: 'dining', name: 'Dining Out', amount: 40, count: 2, pctOfSpending: 100 }] }
  const cmp = compare(curr, null)
  assert.equal(cmp.incomeDelta.abs, 500)
  assert.equal(cmp.incomeDelta.pct, null)
  assert.equal(cmp.byCategoryDelta.length, 1)
  assert.equal(cmp.byCategoryDelta[0].abs, 40)
  assert.equal(cmp.byCategoryDelta[0].pct, null)
})

test('compare: byCategoryDelta covers categories present in either period, sorted by |change|', () => {
  const curr = { income: 0, spending: 0, net: 0, byCategory: [{ id: 'groceries', name: 'Groceries', amount: 300, count: 1, pctOfSpending: 0 }] }
  const prev = { income: 0, spending: 0, net: 0, byCategory: [{ id: 'dining', name: 'Dining Out', amount: 50, count: 1, pctOfSpending: 0 }] }
  const cmp = compare(curr, prev)
  const byId = Object.fromEntries(cmp.byCategoryDelta.map((c) => [c.id, c]))
  assert.equal(byId.groceries.abs, 300) // new this period
  assert.equal(byId.dining.abs, -50) // gone this period
  assert.equal(cmp.byCategoryDelta[0].id, 'groceries') // biggest absolute change first
})

// ---- buildSeries + defaultRange sanity ----
test('buildSeries returns one snapshot per period, oldest first', () => {
  const series = buildSeries(baseData(), 'day', '2026-09-05', '2026-09-10')
  assert.equal(series.length, 6)
  assert.equal(series[0].key, '2026-09-05')
  assert.equal(series[5].key, '2026-09-10')
})

test('defaultRange: month grain covers 12 months ending today', () => {
  const now = new Date(2026, 8, 15) // Sep 15 2026
  const range = defaultRange('month', [], now)
  assert.equal(range.to, '2026-09-15')
  assert.equal(range.from, '2025-10-01')
  assert.equal(periodsFor('month', range.from, range.to).length, 12)
})

test('defaultRange: year grain spans from the earliest transaction year to today', () => {
  const now = new Date(2026, 8, 15)
  const txs = [{ date: '2022-03-01' }, { date: '2024-11-05' }]
  const range = defaultRange('year', txs, now)
  assert.equal(range.from, '2022-01-01')
  assert.equal(range.to, '2026-09-15')
})
