// GET /api/reports/export?grain=month&from=2026-01-01&to=2026-09-30&space_id=ws_...
//
// Same auth/scoping/data-load as app/api/reports/snapshot (see that file's
// header and lib/reports-server.js) — this route instead returns an .xlsx
// workbook (SheetJS `xlsx`, already a dependency) built from the same
// lib/snapshots.js math, so the numbers in the spreadsheet can never drift
// from what the Reports page itself shows.
//
// Sheets: Summary (the requested grain's per-period totals + a TOTAL row),
// Daily/Weekly/Monthly/Quarterly/Yearly (each grain's own default range,
// regardless of what was requested — a full multi-cadence view — with each
// grain's top 8 categories as columns plus an "Other Categories" catch-all),
// Categories (period x category matrix for the REQUESTED grain/range, every
// category as its own column), Transactions (the full ledger), Accounts &
// Debts, and Budgets (this calendar month only).
//
// STYLING NOTE: the installed `xlsx` package is SheetJS's free "Community
// Edition" — full cell styling (bold headers, fills) writes out reliably
// only in the paid Pro build. Rather than ship headers that silently render
// unstyled (or worse, corrupt) in real Excel, this only sets column widths
// and real number/date formats (both fully supported in the CE build) and
// leaves headers as plain text — see the design doc's explicit allowance for
// this tradeoff.
import * as XLSX from 'xlsx'
import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { periodsFor, buildSnapshot, round2 } from '@/lib/snapshots'
import { today } from '@/lib/utils'
import { GRAINS, resolveGrain, resolveRange, loadReportState, catNameResolverFor, accountNameResolverFor } from '@/lib/reports-server'

const MONEY_FMT = '$#,##0.00'
const DATE_FMT = 'm/d/yyyy'
const GRAIN_SHEET_NAMES = { day: 'Daily', week: 'Weekly', month: 'Monthly', quarter: 'Quarterly', year: 'Yearly' }

// Builds one worksheet from plain row objects + a column spec ({key, header,
// width, fmt}), setting `!cols` widths and a per-column number/date format —
// the two things the CE build of `xlsx` writes out reliably (see the file
// header's styling note).
function sheetFromRows(rows, columns) {
  const header = columns.map((c) => c.header)
  const aoa = [header, ...rows.map((r) => columns.map((c) => r[c.key] ?? null))]
  const ws = XLSX.utils.aoa_to_sheet(aoa)
  ws['!cols'] = columns.map((c) => ({ wch: c.width || 14 }))
  columns.forEach((c, ci) => {
    if (!c.fmt) return
    for (let ri = 1; ri < aoa.length; ri++) {
      const addr = XLSX.utils.encode_cell({ r: ri, c: ci })
      if (ws[addr]) ws[addr].z = c.fmt
    }
  })
  return ws
}

// The `n` biggest spending categories across a whole series (by total
// amount, ties broken by first-seen order) — used as fixed columns on the
// Daily/Weekly/Monthly/Quarterly/Yearly sheets so every row lines up under
// the same headers. Omit `n` for every category that appears anywhere in the
// series (the Categories sheet's full matrix).
function categoryColumns(series, n) {
  const totals = new Map()
  series.forEach((s) => s.byCategory.forEach((c) => totals.set(c.id, (totals.get(c.id) || 0) + c.amount)))
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id)
  return n ? sorted.slice(0, n) : sorted
}

const PERIOD_ROW_COLUMNS = (catName, catIds) => [
  { key: 'period', header: 'Period', width: 16 },
  { key: 'income', header: 'Income', width: 14, fmt: MONEY_FMT },
  { key: 'spending', header: 'Spending', width: 14, fmt: MONEY_FMT },
  { key: 'debtPayments', header: 'Debt Payments', width: 14, fmt: MONEY_FMT },
  { key: 'refunds', header: 'Refunds', width: 12, fmt: MONEY_FMT },
  { key: 'net', header: 'Net', width: 14, fmt: MONEY_FMT },
  { key: 'txCount', header: '# Tx', width: 8 },
  ...catIds.map((id) => ({ key: 'cat_' + id, header: catName(id), width: 15, fmt: MONEY_FMT })),
]

function buildSummarySheet(state, grain, from, to, opts) {
  const series = periodsFor(grain, from, to).map((p) => buildSnapshot(state, p, opts))
  const rows = series.map((s) => ({ period: s.label, income: s.income, spending: s.spending, debtPayments: s.debtPayments, refunds: s.refunds, net: s.net, txCount: s.transactionCount }))
  const totals = rows.reduce((acc, r) => ({
    income: acc.income + r.income, spending: acc.spending + r.spending, debtPayments: acc.debtPayments + r.debtPayments,
    refunds: acc.refunds + r.refunds, net: acc.net + r.net, txCount: acc.txCount + r.txCount,
  }), { income: 0, spending: 0, debtPayments: 0, refunds: 0, net: 0, txCount: 0 })
  rows.push({ period: 'TOTAL', income: round2(totals.income), spending: round2(totals.spending), debtPayments: round2(totals.debtPayments), refunds: round2(totals.refunds), net: round2(totals.net), txCount: totals.txCount })
  const columns = PERIOD_ROW_COLUMNS(() => '', [])
  columns[0] = { ...columns[0], header: `Period (${grain})` }
  return sheetFromRows(rows, columns)
}

// One sheet per fixed grain, always using THAT grain's own default range
// (lib/snapshots.js's defaultRange) regardless of what the caller requested
// for Summary/Categories — this is meant to be a stable, always-present
// multi-cadence view of the same data.
function buildGrainSheet(state, grain, opts) {
  const { from, to } = resolveRange(grain, null, null, state.transactions)
  const series = periodsFor(grain, from, to).map((p) => buildSnapshot(state, p, opts))
  const catIds = categoryColumns(series, 8)
  const columns = [...PERIOD_ROW_COLUMNS(opts.catName, catIds), { key: 'other', header: 'Other Categories', width: 15, fmt: MONEY_FMT }]
  const rows = series.map((snap) => {
    const row = { period: snap.label, income: snap.income, spending: snap.spending, debtPayments: snap.debtPayments, refunds: snap.refunds, net: snap.net, txCount: snap.transactionCount }
    let accountedFor = 0
    catIds.forEach((id) => {
      const amt = snap.byCategory.find((c) => c.id === id)?.amount || 0
      row['cat_' + id] = amt
      accountedFor += amt
    })
    row.other = round2(snap.spending - accountedFor)
    return row
  })
  return sheetFromRows(rows, columns)
}

// Period x category matrix for the REQUESTED grain/range — every category
// that shows up anywhere in the range gets its own column (unlike the fixed
// per-grain sheets above, which cap it at the top 8 + "Other").
function buildCategoriesSheet(state, grain, from, to, opts) {
  const series = periodsFor(grain, from, to).map((p) => buildSnapshot(state, p, opts))
  const catIds = categoryColumns(series)
  const columns = [
    { key: 'period', header: 'Period', width: 16 },
    ...catIds.map((id) => ({ key: 'cat_' + id, header: opts.catName(id), width: 15, fmt: MONEY_FMT })),
  ]
  const rows = series.map((snap) => {
    const row = { period: snap.label }
    catIds.forEach((id) => { row['cat_' + id] = snap.byCategory.find((c) => c.id === id)?.amount || 0 })
    return row
  })
  return sheetFromRows(rows, columns)
}

function buildTransactionsSheet(state, opts) {
  const sorted = state.transactions.slice().sort((a, b) => a.date.localeCompare(b.date))
  const rows = sorted.map((t) => ({
    date: new Date(t.date + 'T00:00:00'),
    desc: t.desc,
    merchant: t.merchant || '',
    amount: t.type === 'income' ? t.amount : -t.amount,
    type: t.type,
    category: opts.catName(t.cat),
    account: opts.accountName(t.accountId),
    // `catSource` is the closest thing this app tracks to a per-row "where
    // did this categorization come from" flag — 'manual' the instant a
    // person picks a category by hand, undefined/blank otherwise (Plaid or
    // the built-in keyword rules — see store.jsx's transactions mapper).
    source: t.catSource || 'auto',
  }))
  const columns = [
    { key: 'date', header: 'Date', width: 12, fmt: DATE_FMT },
    { key: 'desc', header: 'Description', width: 34 },
    { key: 'merchant', header: 'Merchant', width: 22 },
    { key: 'amount', header: 'Amount', width: 14, fmt: MONEY_FMT },
    { key: 'type', header: 'Type', width: 10 },
    { key: 'category', header: 'Category', width: 18 },
    { key: 'account', header: 'Account', width: 22 },
    { key: 'source', header: 'Source', width: 10 },
  ]
  return sheetFromRows(rows, columns)
}

function buildAccountsDebtsSheet(state) {
  const rows = [
    ...state.debts.map((d) => ({
      name: d.name, type: d.limit ? 'Credit card' : 'Loan', balance: d.balance, limit: d.limit || null,
      apr: d.apr && d.apr !== '—' ? d.apr : null, minPayment: d.min || null, dueDay: d.dueDay || null,
      balanceAsOf: d.balanceAsOf ? new Date(d.balanceAsOf + 'T00:00:00') : null, plaidLinked: !!d.plaidAccountId,
    })),
    ...state.accounts.map((a) => ({
      name: a.name, type: a.type || 'depository', balance: a.balance, limit: null,
      apr: null, minPayment: null, dueDay: null, balanceAsOf: null, plaidLinked: false,
    })),
  ]
  const columns = [
    { key: 'name', header: 'Name', width: 26 },
    { key: 'type', header: 'Type', width: 14 },
    { key: 'balance', header: 'Balance', width: 14, fmt: MONEY_FMT },
    { key: 'limit', header: 'Limit', width: 14, fmt: MONEY_FMT },
    { key: 'apr', header: 'APR', width: 10 },
    { key: 'minPayment', header: 'Min Payment', width: 14, fmt: MONEY_FMT },
    { key: 'dueDay', header: 'Due Day', width: 10 },
    { key: 'balanceAsOf', header: 'Balance As Of', width: 14, fmt: DATE_FMT },
    { key: 'plaidLinked', header: 'Plaid Linked', width: 12 },
  ]
  return sheetFromRows(rows, columns)
}

function buildBudgetsSheet(state) {
  const ym = today().slice(0, 7)
  const rows = state.budgets.filter((b) => b.limit > 0).map((b) => {
    const spent = round2(state.transactions.filter((t) => t.date.startsWith(ym) && t.type === 'expense' && t.cat === b.id).reduce((s, t) => s + t.amount, 0))
    return { name: b.name, limit: b.limit, spent, remaining: round2(b.limit - spent) }
  })
  const columns = [
    { key: 'name', header: 'Name', width: 24 },
    { key: 'limit', header: 'Monthly Limit', width: 14, fmt: MONEY_FMT },
    { key: 'spent', header: 'Spent This Month', width: 16, fmt: MONEY_FMT },
    { key: 'remaining', header: 'Remaining', width: 14, fmt: MONEY_FMT },
  ]
  return sheetFromRows(rows, columns)
}

export async function GET(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const targetId = searchParams.get('space_id') || user.id
    const grain = resolveGrain(searchParams.get('grain'))

    const state = await loadReportState(supabase, targetId)
    const { from, to } = resolveRange(grain, searchParams.get('from'), searchParams.get('to'), state.transactions)
    const opts = { catName: catNameResolverFor(state), accountName: accountNameResolverFor(state) }

    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, buildSummarySheet(state, grain, from, to, opts), 'Summary')
    GRAINS.forEach((g) => XLSX.utils.book_append_sheet(wb, buildGrainSheet(state, g, opts), GRAIN_SHEET_NAMES[g]))
    XLSX.utils.book_append_sheet(wb, buildCategoriesSheet(state, grain, from, to, opts), 'Categories')
    XLSX.utils.book_append_sheet(wb, buildTransactionsSheet(state, opts), 'Transactions')
    XLSX.utils.book_append_sheet(wb, buildAccountsDebtsSheet(state), 'Accounts & Debts')
    XLSX.utils.book_append_sheet(wb, buildBudgetsSheet(state), 'Budgets')

    const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'buffer' })
    const filename = `steermoney-${grain}-${from}_${to}.xlsx`
    return new Response(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${filename}"`,
      },
    })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to export report' }, { status: 500 })
  }
}
