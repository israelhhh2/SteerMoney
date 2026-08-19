'use client'
// Shared account-inventory logic — extracted from views/Accounts.jsx so the
// Dashboard's Credit Cards rows, the Accounts page, and the new account
// detail view (views/AccountDetail.jsx, full page + Notion-style modal) all
// build the exact same merged list (manual debts/accounts + connected Plaid
// accounts) and agree on one stable, URL-safe id per account.
import { useSyncExternalStore } from 'react'
import { today, isoDate, prettyDate, uid } from '@/lib/utils'
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

// Most-recent successful sync across every connected item — feeds the
// header's/Accounts page's "Updated <relTime>" indicator (see relTime
// above and AccountDetail.jsx's own per-account version of this same line).
// Prefers last_balance_at (the Balance-product refresh, more granular —
// twice-daily cron + manual Refresh) but falls back to last_synced (the
// Transactions-product sync) per item, then takes the max across all items.
// null-safe: no items, or no timestamps on any of them, returns null.
export function lastUpdatedAt(plaidItems) {
  let latest = null
  ;(plaidItems || []).forEach((it) => {
    const iso = it.last_balance_at || it.last_synced
    if (!iso) return
    if (!latest || new Date(iso) > new Date(latest)) latest = iso
  })
  return latest
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
      institution: m?.institution || null, balance: d.balance,
      // Prefer Plaid's real limit when the matched account has one; keep the
      // manually-entered d.limit as a fallback so a debt matched to a Plaid
      // account that doesn't report a limit (or isn't matched at all) is
      // unaffected — see CLAUDE.md quick-win entry.
      limit: m?.limit != null ? m.limit : (d.limit || null),
      available: m?.available ?? null,
      account_id: m?.account_id || null, last_synced: item?.last_synced || null,
      // item_id/status mirror the connection this debt is matched to (if
      // any), so the "still syncing" placeholder (see usePlaidItems below,
      // AccountDetail.jsx, views/Accounts.jsx) applies to a manual debt
      // that's matched to a freshly-connected Plaid account too, not just
      // unmatchedPlaid rows.
      item_id: item?.item_id || null, status: item?.status || null,
      // Balance-only-refresh feature (see lib/plaid-balance.js): threaded
      // through here for the same reason status/item_id are — a manual debt
      // matched to a Plaid credit card should show an accurate "Updated
      // <relTime>" line even though its own manual Refresh *button* is
      // deliberately gated on `source === 'plaid'` only (see
      // views/AccountDetail.jsx) and never shown here.
      last_balance_at: item?.last_balance_at || null,
      source: 'debt', debtId: d.id, history: null,
    }
  })

  const unmatchedPlaid = plaidItems.flatMap((it) => (it.accounts || [])
    .filter((a) => !matchedAccountIds.has(acctKey(a)))
    .map((a) => ({
      key: 'plaid:' + acctKey(a),
      kind: a.type === 'credit' ? 'credit' : a.type === 'loan' ? 'loan' : (a.type || 'other'),
      name: a.name, mask: a.mask, subtype: a.subtype || null, institution: it.institution,
      // Real limit/available straight from Plaid (lib/plaid-sync.js /
      // app/api/plaid/exchange) when present — was hardcoded null before,
      // forcing the "Credit limit needed" pill and an AVAILABLE→CURRENT
      // fallback even when Plaid actually had the data.
      balance: a.balance ?? 0, limit: a.limit ?? null, available: a.available ?? null,
      account_id: a.account_id || null, last_synced: it.last_synced,
      // item_id identifies the plaid_items row (the bank connection) this account
      // belongs to — Plaid has no per-account delete API, so AccountDetail's
      // "Disconnect bank" action needs this to DELETE /api/plaid/items.
      item_id: it.item_id || null,
      // 'syncing' while the item's historical backfill is still in flight
      // (see lib/plaid-sync.js) — drives the "please wait" placeholders.
      status: it.status || null,
      // When Plaid's Balance product (lib/plaid-balance.js) last force-
      // refreshed this item — drives AccountDetail's "Updated <relTime>"
      // line (preferred over last_synced, which only reflects the
      // Transactions-product sync) and its Refresh-button availability.
      last_balance_at: it.last_balance_at || null,
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
  const key = manualAcctUrlId(accountRowId)
  update((s) => {
    s.accounts = s.accounts.filter((a) => a.id !== accountRowId)
    // drop any tags/custom color pinned to this account so account_tags/
    // account_colors don't accumulate orphaned rows for deleted accounts —
    // see the tag/color helpers below.
    if (s.accountTags) s.accountTags = s.accountTags.filter((t) => t.accountKey !== key)
    if (s.accountColors) s.accountColors = s.accountColors.filter((c) => c.accountKey !== key)
  })
}

export function deleteDebt(update, debtId) {
  const key = debtUrlId(debtId)
  update((s) => {
    const i = s.debts.findIndex((d) => d.id === debtId)
    if (i !== -1) s.debts.splice(i, 1)
    if (s.accountTags) s.accountTags = s.accountTags.filter((t) => t.accountKey !== key)
    if (s.accountColors) s.accountColors = s.accountColors.filter((c) => c.accountKey !== key)
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

// ---- shared /api/plaid/items store (module-level, not per-component) ----
// Every usePlaidItems() caller (layout.jsx's header, Accounts.jsx,
// AccountDetail.jsx, Settings.jsx, Transactions.jsx) used to keep its own
// useState + its own one-shot fetch — so refetchPlaidItems() called from one
// component (Settings' "Sync now", AccountDetail's balance "Refresh") only
// ever updated THAT component's copy; every other mounted instance (e.g. the
// header's "Updated <relTime>" note) kept showing stale data until it
// happened to remount. Hoisting the fetched items/checked flag, the
// in-flight fetch, the 'syncing' self-poll, and the focus/visibility
// staleness refetch to module scope — with every hook instance subscribing
// via useSyncExternalStore — means one refetch (from any caller) is visible
// to all of them immediately, and only one /api/plaid/items request (or one
// poll loop) is ever in flight at a time no matter how many components are
// mounted. The public API ({ plaidItems, plaidChecked, refetchPlaidItems })
// is unchanged, so no caller needs to change.
let _items = []
let _checked = false
let _lastFetchAt = 0 // Date.now() of the last fetch that landed (success OR failure) — drives the staleness refetch below
let _inFlight = null // shared promise so concurrent mounts never fire parallel requests
let _snapshot = { items: _items, checked: _checked } // stable reference for useSyncExternalStore; only replaced when data actually changes
const _subscribers = new Set()

function updateSnapshot() {
  _snapshot = { items: _items, checked: _checked }
}

function notify() {
  _subscribers.forEach((cb) => cb())
}

function setItems(items) {
  _items = items || []
  _checked = true
  _lastFetchAt = Date.now()
  updateSnapshot()
  notify()
  maybeStartPoll()
}

// Exposed as `refetchPlaidItems` from the hook below — additive, existing
// callers that only destructure {plaidItems, plaidChecked} are unaffected.
// Needed by the balance-only-refresh feature (views/AccountDetail.jsx's
// "Refresh" button) and Settings' "Sync now": both want the just-updated
// data without a full page reload, unlike every connect/disconnect flow in
// this app which still reloads.
function fetchItems() {
  if (_inFlight) return _inFlight // dedupe: share the in-flight request instead of firing another
  const promise = fetch('/api/plaid/items')
    .then((r) => r.json())
    .then((d) => { setItems(d.items || []); return _items })
    .catch(() => {
      // A failed fetch still flips `checked` (so "loading" placeholders
      // clear) but deliberately leaves `_lastFetchAt` at its previous value —
      // still stale, so the next focus/visibility check retries instead of
      // treating a failed pull as "fresh."
      _checked = true
      updateSnapshot()
      notify()
      return []
    })
    .finally(() => { _inFlight = null })
  _inFlight = promise
  return promise
}

// ---- 'syncing' self-poll ----
// While any item is still 'syncing' (a freshly-connected bank whose 730-day
// historical backfill hasn't landed yet — see lib/plaid-sync.js and the
// webhook route's HISTORICAL_UPDATE/SYNC_UPDATES_AVAILABLE handling), every
// ~10s nudge POST /api/plaid/sync (in case the webhook was never registered
// or missed) then re-fetch /api/plaid/items, so the "please wait,
// transactions are loading" placeholders flip to real data on their own, no
// manual refresh needed. Gives up after ~2 minutes — the server-side age
// fallback in app/api/plaid/sync (and the webhook route) eventually clears a
// stuck flag on the next real "Sync now" or webhook regardless. Module-level
// (not per-hook-instance) so mounting this hook in five components at once
// never starts five parallel poll loops; `_pollTimer` guards against a
// second loop starting while one is already running.
let _pollTimer = null
let _pollAttempts = 0
const POLL_INTERVAL_MS = 10000
const MAX_POLL_ATTEMPTS = 12 // ~2 minutes at 10s intervals

function hasSyncingItem() {
  return _checked && _items.some((it) => it.status === 'syncing')
}

function maybeStartPoll() {
  if (_pollTimer || !hasSyncingItem()) return
  _pollAttempts = 0
  schedulePoll()
}

function schedulePoll() {
  _pollTimer = setTimeout(pollTick, POLL_INTERVAL_MS)
}

async function pollTick() {
  _pollAttempts++
  try { await fetch('/api/plaid/sync', { method: 'POST' }) } catch { /* best-effort nudge */ }
  try {
    const r = await fetch('/api/plaid/items')
    const d = await r.json()
    setItems(d.items || []) // also re-triggers maybeStartPoll, but the `_pollTimer` guard (cleared just below) keeps this a single ongoing loop
  } catch { /* keep polling through a transient fetch failure */ }
  _pollTimer = null
  if (hasSyncingItem() && _pollAttempts < MAX_POLL_ATTEMPTS) schedulePoll()
  else _pollAttempts = 0 // reset so a future newly-'syncing' item gets its own full ~2-minute budget
}

function stopPoll() {
  if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null }
}

// ---- focus/visibility staleness refetch ----
// Mirrors store.jsx's own focus/visibility refetch for the same reason: nothing
// else here ever refetches once loaded, so a tab left open (or a second
// device — phone syncs, desktop tab regains focus) would otherwise show
// stale connected-account balances/timestamps indefinitely. One listener
// registration for the whole app (attached when the first subscriber shows
// up, removed when the last one goes away), not one per component.
const STALE_MS = 60000
let _focusListenerAttached = false

function maybeRefetchOnFocus() {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
  if (_inFlight) return
  if (Date.now() - _lastFetchAt < STALE_MS) return
  fetchItems()
}

function attachFocusListener() {
  if (_focusListenerAttached || typeof window === 'undefined') return
  document.addEventListener('visibilitychange', maybeRefetchOnFocus)
  window.addEventListener('focus', maybeRefetchOnFocus)
  _focusListenerAttached = true
}

function detachFocusListener() {
  if (!_focusListenerAttached) return
  document.removeEventListener('visibilitychange', maybeRefetchOnFocus)
  window.removeEventListener('focus', maybeRefetchOnFocus)
  _focusListenerAttached = false
}

// ---- subscription plumbing (useSyncExternalStore) ----
// Every mounted usePlaidItems() instance subscribes here; the store itself
// (not React state) is the single source of truth, so a refetch triggered by
// any one of them is immediately visible to all the others.
function subscribe(callback) {
  _subscribers.add(callback)
  attachFocusListener()
  // Resume the 'syncing' poll if it was stopped (last subscriber gone) while
  // an item was still mid-backfill and a new one just mounted.
  maybeStartPoll()
  // Fetch once, the first time this store ever gets a subscriber (or if a
  // previous fetch never landed) — not once per mounted component.
  if (!_inFlight && _lastFetchAt === 0) fetchItems()
  return () => {
    _subscribers.delete(callback)
    if (_subscribers.size === 0) { detachFocusListener(); stopPoll() }
  }
}

function getSnapshot() {
  return _snapshot
}

// Module state itself never touches window/document — only the functions
// above do, and only once actually called from the browser (subscribe() is
// never invoked during SSR; React only ever calls getServerSnapshot there),
// so this stays SSR-safe despite being module-level.
function getServerSnapshot() {
  return _snapshot
}

// Fetches /api/plaid/items, shared by Accounts.jsx, AccountDetail.jsx,
// Settings.jsx, layout.jsx's header, and Transactions.jsx (all need the same
// connected-accounts list to build the same inventory / resolve an account's
// sync status / show the same "Updated <relTime>" timestamp) — see the
// module-level store above for why this is shared rather than per-instance.
export function usePlaidItems() {
  const { items, checked } = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  return { plaidItems: items, plaidChecked: checked, refetchPlaidItems: fetchItems }
}

// ---- account tags ("Mine"/"Julia's"/etc. — shared-space account labels) ----
// One row per {account, tag} in the `accountTags` store slice (table
// `account_tags`; see CLAUDE.md 2026-08-08 (10) for the migration SQL).
// `accountKey` is always accountUrlId()'s output, so a tag works identically
// on a manual account, a manual debt, or a Plaid-linked account. Nothing here
// is aware of shared spaces — store.jsx already re-points the entire `state`
// (every slice, tags included) at the active space's rows, so two partners
// viewing the same shared space automatically see and edit the same tags;
// switching back to a personal space shows only that person's own tags.
export function tagsForAccount(state, accountKey) {
  return (state?.accountTags || []).filter((t) => t.accountKey === accountKey)
}

// Every distinct tag name in use anywhere in this space, case-insensitively
// deduped (first-seen casing wins) and alphabetized — feeds the Accounts
// page's filter-pill row and the "reuse an existing tag" suggestions shown
// while adding a new one (so "Julia" gets reused, not retyped as "julia").
export function allAccountTags(state) {
  const seen = new Map() // lowercase -> first-seen-casing
  ;(state?.accountTags || []).forEach((t) => {
    const k = t.tag.toLowerCase()
    if (!seen.has(k)) seen.set(k, t.tag)
  })
  return [...seen.values()].sort((a, b) => a.localeCompare(b))
}

// No-op on an empty/whitespace tag name or a duplicate (case-insensitive) on
// the same account — the UI never needs to check first.
export function addAccountTag(update, accountKey, tagName) {
  const tag = String(tagName || '').trim().slice(0, 24)
  if (!tag) return
  update((s) => {
    if (!s.accountTags) s.accountTags = []
    const dup = s.accountTags.some((t) => t.accountKey === accountKey && t.tag.toLowerCase() === tag.toLowerCase())
    if (!dup) s.accountTags.push({ id: uid('at'), accountKey, tag })
  })
}

export function removeAccountTag(update, tagId) {
  update((s) => { s.accountTags = (s.accountTags || []).filter((t) => t.id !== tagId) })
}

// ---- account card color ("let me edit the card to change color") ----
// One row per account (at most one, unlike tags) in the `accountColors` store
// slice (table `account_colors` — see CLAUDE.md's session log for the
// migration SQL, same shape/vintage precedent as account_tags above).
// `accountKey` is the same accountUrlId() every other per-account slice uses,
// so this works identically for manual accounts, manual debts, and Plaid
// accounts, and rides along with shared spaces for free (store.jsx re-points
// the whole state at the active space, tags/colors included — nothing here
// needs to know spaces exist).
//
// `color` is one of components/shared.jsx's CARD_COLOR_PRESETS hue numbers.
// Returns null when the account has no custom color, which is what makes
// "Auto" work: CardChip's own cardHue() hash is the fallback the instant
// there's no override row for that key — no separate reset flag needed.
export function colorForAccount(state, accountKey) {
  const row = (state?.accountColors || []).find((c) => c.accountKey === accountKey)
  return row ? row.color : null
}

// Pass color=null/undefined to reset to Auto (deletes the row instead of
// storing a sentinel). A card has at most one color, so — unlike
// addAccountTag, which appends — this always replaces any existing row for
// the same accountKey first.
export function setAccountColor(update, accountKey, color) {
  update((s) => {
    if (!s.accountColors) s.accountColors = []
    s.accountColors = s.accountColors.filter((c) => c.accountKey !== accountKey)
    if (color != null) s.accountColors.push({ id: uid('ac'), accountKey, color })
  })
}

// ---- auto-fill a manual debt's credit limit from a matched Plaid account ----
// "For the limits I was talking about credit card limits. Like Venture is
// 300 limit. Let it automatically fill those out." (verbatim request).
// buildAccountInventory's fromDebts() already *displays* a matched Plaid
// account's real balances.limit in place of a manual debt's own d.limit (see
// the (15) session-log quick win) — but that's read-only/derived, so the
// debt's own stored `limit` field (the one DebtDialog's input edits, and
// what payoff/utilization math elsewhere reads directly off state.debts)
// never actually got the value. This does the same fuzzy match
// (matchesBankAccount, lib/finance.js — the exact function
// buildAccountInventory already uses) and persists it onto the debt itself.
//
// Rules, deliberately narrow:
//   1. Only fills a debt whose own `limit` is empty (null/0/undefined/'') —
//      never overwrites a truthy, user-entered limit, even if Plaid reports
//      a different number for the matched account.
//   2. No `limitSource`/provenance flag is persisted. The debts table's
//      mapper (store.jsx's `mappers.debts`) writes `credit_limit`
//      unconditionally on every row — unlike transactions/recurring's
//      "only include the key when already present" convention — and `debts`
//      is core data, not in `OPTIONAL_TABLES`. Adding a new `limit_source`
//      column would need a migration
//      (`ALTER TABLE debts ADD COLUMN IF NOT EXISTS limit_source text;`) that,
//      if not yet run, would risk the whole debts upsert failing (not a
//      soft/optional-table skip like account_tags/account_colors) — too
//      risky for a nicety. Decided instead to keep this one-directional and
//      migration-free: fill once while empty, then leave it alone forever,
//      exactly like a number the user typed by hand. Tradeoff (accepted): if
//      Plaid's reported limit later changes, an already-filled debt won't
//      re-sync to the new number — same as it wouldn't if a human had typed
//      it.
//   3. Never touches balance/apr/min/dueDay/anything else on the debt —
//      limits only, per the request.
//   4. Idempotent — only calls `update()` when at least one debt actually
//      needs filling (an empty Map short-circuits before touching the
//      store), so calling this on every render/effect tick is safe and
//      doesn't create diff-sync churn once every matched debt has its limit.
// ---- duplicate-connection detection ----
// The same real-world account, linked through two different Plaid items,
// gets a DIFFERENT Plaid account_id per item — so "is this actually the same
// account" can't key on account_id at all. Institution + mask + type is the
// closest stable proxy available. A null/missing mask never matches
// anything (silently missing a true duplicate is far safer than merging two
// unrelated accounts that both happen to lack one), and two different cards
// at the same bank are correctly kept apart because their masks differ.
// Exported + pure so app/api/plaid/exchange/route.js (server) and
// Accounts.jsx (client) share the exact same rule instead of two
// implementations drifting apart.
export function accountsLookSame(instA, a, instB, b) {
  if (!a || !b) return false
  if (!a.mask || !b.mask || a.mask !== b.mask) return false
  if ((a.type || null) !== (b.type || null)) return false
  const nA = String(instA || '').trim().toLowerCase()
  const nB = String(instB || '').trim().toLowerCase()
  if (!nA || !nB || nA !== nB) return false
  return true
}

// True only when EVERY account in `accounts` matches some account in
// `otherAccounts` — i.e. this item brings nothing new. Partial overlap (some
// but not all accounts match) deliberately returns false: re-linking the
// same bank with additional accounts selected is a legitimate flow, not a
// duplicate connection, and must never be flagged.
export function isFullyDuplicateOf(institution, accounts, otherInstitution, otherAccounts) {
  if (!accounts?.length || !otherAccounts?.length) return false
  return accounts.every((a) => otherAccounts.some((b) => accountsLookSame(institution, a, otherInstitution, b)))
}

// Scans the already-loaded plaidItems (Accounts.jsx) for a connection that
// fully duplicates another one — same matching rule the exchange route uses
// at link time (app/api/plaid/exchange/route.js), run again here so a
// duplicate that predates that check (like the user's existing double-Chase
// connection) still gets surfaced. Returns [{ dupItem, originalItem }],
// always flagging the NEWER item (by created_at) as the duplicate — removal
// (Accounts.jsx's banner, connect-bank.jsx's post-link dialog) always
// targets `dupItem`, never `originalItem`, so nothing the user already
// relies on ever disappears. Each item is flagged at most once, as either a
// dup or an original, so three-or-more-way duplicates don't produce
// contradictory pairs.
export function findDuplicateItems(plaidItems) {
  const sorted = (plaidItems || []).slice().sort((a, b) => new Date(a.created_at || 0) - new Date(b.created_at || 0))
  const flagged = new Set() // .id of items already reported as a dup
  const out = []
  for (let i = 0; i < sorted.length; i++) {
    const original = sorted[i]
    if (flagged.has(original.id)) continue
    for (let j = i + 1; j < sorted.length; j++) {
      const candidate = sorted[j]
      if (flagged.has(candidate.id)) continue
      if (isFullyDuplicateOf(candidate.institution, candidate.accounts || [], original.institution, original.accounts || [])) {
        out.push({ dupItem: candidate, originalItem: original })
        flagged.add(candidate.id) // placed as a dup — never also reported as someone else's original
      }
    }
  }
  return out
}

export function reconcileDebtLimits(state, plaidItems, update) {
  if (!state?.debts?.length || !plaidItems?.length) return
  const plaidAccountsFlat = plaidItems.flatMap((it) => (it.accounts || []).map((a) => ({ ...a, institution: it.institution })))
  if (!plaidAccountsFlat.length) return

  const fills = new Map() // debtId -> limit
  state.debts.forEach((d) => {
    if (d.limit) return // already has a real limit (manual or previously auto-filled) — never overwrite
    const m = matchesBankAccount(d, plaidAccountsFlat)
    if (m && m.limit != null && m.limit > 0) fills.set(d.id, m.limit)
  })
  if (!fills.size) return

  update((s) => {
    s.debts.forEach((d) => { if (fills.has(d.id)) d.limit = fills.get(d.id) })
  })
}
