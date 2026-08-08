'use client'
// Shared account-inventory logic — extracted from views/Accounts.jsx so the
// Dashboard's Credit Cards rows, the Accounts page, and the new account
// detail view (views/AccountDetail.jsx, full page + Notion-style modal) all
// build the exact same merged list (manual debts/accounts + connected Plaid
// accounts) and agree on one stable, URL-safe id per account.
import { useEffect, useState } from 'react'
import { today, isoDate, prettyDate } from '@/lib/utils'
import { matchesBankAccount } from '@/lib/finance'

export const RANGE_KEYS = ['1W', '1M', '3M', 'YTD', '1Y']
export const RANGE_DAYS = { '1W': 7, '1M': 30, '3M': 90, '1Y': 365 }

export function daysFor(rangeKey) {
  if (rangeKey === 'YTD') {
    const now = new Date(today() + 'T00:00:00')
    const jan1 = new Date(now.getFullYear(), 0, 1)
    return Math.max(1, Math.round((now - jan1) / 864e5) + 1)
  }
  return RANGE_DAYS[rangeKey] || 90
}

const TYPE_LABEL = { credit: 'Credit card', loan: 'Loan', depository: 'Depository', investment: 'Investment', other: 'Other' }
export function typeLabel(account) {
  if (account.subtype) return account.subtype.charAt(0).toUpperCase() + account.subtype.slice(1)
  return TYPE_LABEL[account.kind] || 'Account'
}

// ---- daily series for the header chart (approximate on purpose) ----

function lastNDays(n) {
  const out = []
  const base = new Date(today() + 'T00:00:00')
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base)
    d.setDate(d.getDate() - i)
    out.push(isoDate(d))
  }
  return out
}

// Carry the last known balance forward per day; accounts with no history
// contribute their current balance flat, and days before the first known
// entry fall back to that earliest entry.
function assetsOn(accounts, date) {
  return accounts.reduce((sum, a) => {
    const hist = (a.history || []).slice().sort((x, y) => x.date.localeCompare(y.date))
    if (!hist.length) return sum + (a.balance || 0)
    let val = hist[0].balance
    for (const h of hist) { if (h.date <= date) val = h.balance; else break }
    return sum + val
  }, 0)
}

// Walk backward from the current balance: a payment made after the day in
// question hadn't happened yet, so add it back.
function debtsOn(debts, date) {
  return debts.reduce((sum, d) => {
    const future = (d.payments || []).filter((p) => p.date > date)
    const bal = d.balance + future.reduce((s, p) => s + p.amount, 0)
    return sum + Math.max(0, bal)
  }, 0)
}

// Depository/investment Plaid accounts have no local history, so they carry
// their current balance flat across the whole window (assetsOn already does
// this for any account missing a `history` array).
export function buildSeries(accounts, debts, plaidAssetAccounts, days = 90) {
  const manual = accounts.filter((a) => a.type !== 'credit' && a.type !== 'loan')
  const merged = [...manual, ...(plaidAssetAccounts || [])]
  return lastNDays(days).map((date) => ({
    name: prettyDate(date),
    date,
    assets: Math.round(assetsOn(merged, date)),
    debts: Math.round(debtsOn(debts, date)),
  }))
}

export function pctChange(series, key) {
  if (!series.length) return 0
  const first = series[0][key]
  const last = series[series.length - 1][key]
  if (!first) return last ? 100 : 0
  return ((last - first) / Math.abs(first)) * 100
}

// % balance change over the last 30 days from a manual account's history.
export function pctChange30(history, balance) {
  if (!history || !history.length) return null
  const cutoff = new Date(today() + 'T00:00:00'); cutoff.setDate(cutoff.getDate() - 30)
  const cutoffIso = isoDate(cutoff)
  const recent = history.filter((h) => h.date >= cutoffIso).slice().sort((a, b) => a.date.localeCompare(b.date))
  if (!recent.length) return null
  const oldest = recent[0].balance
  if (!oldest) return null
  return ((balance - oldest) / Math.abs(oldest)) * 100
}

export function relTime(iso) {
  if (!iso) return null
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} hour${hrs === 1 ? '' : 's'} ago`
  const days = Math.floor(hrs / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`
  const months = Math.floor(days / 30)
  return `${months} month${months === 1 ? '' : 's'} ago`
}

// Derive a balance-history series for the detail view's chart. Manual accounts
// already keep real daily history. Plaid-backed accounts don't — so we walk
// backward from today's balance using that account's own transactions (real
// data). If neither exists in the selected range, we fall back to a flat line
// at the current balance — never synthetic/random data.
export function accountHistorySeries(account, allTx, rangeKey) {
  const days = daysFor(rangeKey)
  const cutoff = new Date(today() + 'T00:00:00'); cutoff.setDate(cutoff.getDate() - days + 1)
  const cutoffIso = isoDate(cutoff)

  if (account.source === 'manual' && account.history && account.history.length) {
    const pts = account.history.filter((h) => h.date >= cutoffIso).sort((a, b) => a.date.localeCompare(b.date))
    const list = pts.length ? pts : account.history.slice(-1)
    return list.map((h) => ({ name: prettyDate(h.date), balance: Math.round(h.balance) }))
  }

  if (account.account_id) {
    const txs = (allTx || []).filter((t) => t.accountId === account.account_id && t.date >= cutoffIso)
    if (txs.length) {
      const sorted = txs.slice().sort((a, b) => b.date.localeCompare(a.date))
      const isDebtStyle = account.kind === 'credit' || account.kind === 'loan'
      let bal = account.balance
      const points = [{ date: today(), balance: bal }]
      for (const t of sorted) {
        const effect = isDebtStyle
          ? (t.type === 'expense' ? t.amount : -t.amount)
          : (t.type === 'income' ? t.amount : -t.amount)
        bal -= effect
        points.push({ date: t.date, balance: bal })
      }
      return points.reverse().map((p) => ({ name: prettyDate(p.date), balance: Math.round(p.balance) }))
    }
  }

  return [
    { name: prettyDate(cutoffIso), balance: Math.round(account.balance) },
    { name: prettyDate(today()), balance: Math.round(account.balance) },
  ]
}

// Stable-ish identity for a Plaid account row, used to line up "this debt
// matches this connected account" without relying on account_id existing on
// older, not-yet-resynced rows.
export const acctKey = (a) => a.account_id || `${a.mask || ''}|${(a.name || '').toLowerCase()}`

// Manual debts don't store a mask field — but many people name cards like
// "Chase Freedom 1234", so pull the trailing 4 digits as a best-effort mask.
export function extractMask(name) {
  const m = String(name || '').match(/(\d{4})\D*$/)
  return m ? m[1] : ''
}

// ---- merged inventory (Copilot-style Credit cards / Loans / Depository) ----
// Pure function — callers (Accounts.jsx, AccountDetail.jsx) memoize it
// themselves against [state.debts, state.accounts, plaidItems].
export function buildAccountInventory(state, plaidItems) {
  const plaidAssetAccounts = plaidItems.flatMap((it) => (it.accounts || []).filter((a) => a.type === 'depository' || a.type === 'investment'))
  const plaidAccountsFlat = plaidItems.flatMap((it) => (it.accounts || []).map((a) => ({ ...a, institution: it.institution })))

  const matchedAccountIds = new Set()
  state.debts.forEach((d) => {
    const m = matchesBankAccount(d, plaidAccountsFlat)
    if (m) matchedAccountIds.add(acctKey(m))
  })

  const findItemFor = (m) => m ? plaidItems.find((it) => (it.accounts || []).some((a) => acctKey(a) === acctKey(m))) : null

  const fromDebts = (limitTruthy) => state.debts.filter((d) => !!d.limit === limitTruthy).map((d) => {
    const m = matchesBankAccount(d, plaidAccountsFlat)
    const item = findItemFor(m)
    return {
      key: 'debt:' + d.id, kind: limitTruthy ? 'credit' : 'loan', name: d.name,
      mask: m?.mask || extractMask(d.name), subtype: m?.subtype || null,
      institution: m?.institution || null, balance: d.balance, limit: d.limit || null,
      account_id: m?.account_id || null, last_synced: item?.last_synced || null,
      source: 'debt', debtId: d.id, history: null,
    }
  })

  const unmatchedPlaid = plaidItems.flatMap((it) => (it.accounts || [])
    .filter((a) => !matchedAccountIds.has(acctKey(a)))
    .map((a) => ({
      key: 'plaid:' + acctKey(a),
      kind: a.type === 'credit' ? 'credit' : a.type === 'loan' ? 'loan' : (a.type || 'other'),
      name: a.name, mask: a.mask, subtype: a.subtype || null, institution: it.institution,
      balance: a.balance ?? 0, limit: null, account_id: a.account_id || null, last_synced: it.last_synced,
      // item_id identifies the plaid_items row (the bank connection) this account
      // belongs to — Plaid has no per-account delete API, so AccountDetail's
      // "Disconnect bank" action needs this to DELETE /api/plaid/items.
      item_id: it.item_id || null,
      source: 'plaid', history: null,
    })))

  const depositoryFromManual = state.accounts.map((a) => ({
    key: 'acct:' + a.id, kind: a.type, name: a.name, mask: a.mask, subtype: null, institution: a.institution,
    balance: a.balance, limit: null, account_id: null, last_synced: null,
    source: 'manual', history: a.history, accountRowId: a.id,
  }))

  const cards = [...fromDebts(true), ...unmatchedPlaid.filter((a) => a.kind === 'credit')].sort((x, y) => y.balance - x.balance)
  const loans = [...fromDebts(false), ...unmatchedPlaid.filter((a) => a.kind === 'loan')].sort((x, y) => y.balance - x.balance)
  const depository = [...depositoryFromManual, ...unmatchedPlaid.filter((a) => a.kind !== 'credit' && a.kind !== 'loan')]

  return {
    plaidAssetAccounts, plaidAccountsFlat, matchedAccountIds,
    cards, loans, depository, all: [...cards, ...loans, ...depository],
  }
}

// ---- canonical, URL-safe account id ----
// Plaid accounts → their Plaid account_id (stable across reconnects as long
// as the item isn't re-linked). Manual debts/accounts → the store row id,
// prefixed so it can never collide with a Plaid id and is resolvable even
// with no Plaid connection at all.
export const debtUrlId = (debtId) => `debt_${debtId}`
export const manualAcctUrlId = (accountRowId) => `acc_${accountRowId}`

export function accountUrlId(row) {
  if (row.source === 'debt') return debtUrlId(row.debtId)
  if (row.source === 'manual') return manualAcctUrlId(row.accountRowId)
  if (row.account_id) return row.account_id
  return row.key
}

// Resolve one merged-inventory row from a URL id (the reverse of accountUrlId).
export function findAccountByUrlId(id, state, plaidItems) {
  if (!id || !state) return null
  const { all } = buildAccountInventory(state, plaidItems || [])
  return all.find((r) => accountUrlId(r) === id) || null
}

// ---- deletion (shared by Accounts.jsx, Debts.jsx, and AccountDetail.jsx) ----
// Same mutations those views already performed inline — centralized here so
// AccountDetail's Delete/Disconnect action (used by both the full page and
// the modal) reuses the exact logic instead of duplicating it.
export function deleteManualAccount(update, accountRowId) {
  update((s) => { s.accounts = s.accounts.filter((a) => a.id !== accountRowId) })
}

export function deleteDebt(update, debtId) {
  update((s) => {
    const i = s.debts.findIndex((d) => d.id === debtId)
    if (i !== -1) s.debts.splice(i, 1)
  })
}

// Shared "go back to the accounts list" fallback — the standalone detail
// page's Back button, and AccountDetail itself after a delete/disconnect,
// both use this. Works unchanged whether AccountDetail is rendered as the
// full page or inside the Notion-style modal: from the modal there's always
// history to pop (it only ever opens via an in-app Link click), so
// router.back() is what runs there; a directly-loaded full page with no
// history falls back to /accounts.
export function backToAccounts(router) {
  if (typeof window !== 'undefined' && window.history.length > 1) router.back()
  else router.push('/accounts')
}

// Fetches /api/plaid/items once, shared by Accounts.jsx and AccountDetail.jsx
// (both need the same connected-accounts list to build the same inventory).
export function usePlaidItems() {
  const [plaidItems, setPlaidItems] = useState([])
  const [plaidChecked, setPlaidChecked] = useState(false)

  useEffect(() => {
    let on = true
    fetch('/api/plaid/items')
      .then((r) => r.json())
      .then((d) => { if (on) { setPlaidItems(d.items || []); setPlaidChecked(true) } })
      .catch(() => { if (on) setPlaidChecked(true) })
    return () => { on = false }
  }, [])

  return { plaidItems, plaidChecked }
}
