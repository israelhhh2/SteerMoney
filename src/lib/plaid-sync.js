import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'
import { mapPlaidCategory } from '@/lib/plaid-categories'

// Small keyword map from Plaid's merchant/transaction name to this app's
// category ids. Kept only as a defensive fallback for the rare transaction
// Plaid doesn't enrich with a `personal_finance_category` at all — the
// primary categorization path is mapPlaidCategory() (lib/plaid-categories.js),
// which reads Plaid's actual PFC taxonomy instead of guessing from the name.
const CATEGORY_RULES = [
  ['housing', /rent|mortgage/i],
  ['groceries', /grocery|market|supermarket/i],
  ['dining', /restaurant|food|coffee|pizza/i],
  ['auto', /gas|fuel|auto|uber|lyft/i],
  ['utilities', /electric|water|internet|phone|utility/i],
]

function guessCategory(tx) {
  const text = [tx.merchant_name, tx.name].filter(Boolean).join(' ')
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat
  return 'other'
}

// Pulls new/changed/removed transactions for a single connected bank
// (plaid_items row) and mirrors them into public.transactions, then refreshes
// its stored account balances. Extracted from app/api/plaid/sync/route.js so
// both the manual "Sync now" route and the webhook route
// (SYNC_UPDATES_AVAILABLE) share one implementation instead of drifting.
// Caller is responsible for the plaidConfigured/supabaseAdmin gate checks —
// this assumes both are available.
export async function syncPlaidItem(item, opts = {}) {
  const userId = item.user_id
  let cursor = item.cursor || undefined
  let hasMore = true
  const allAdded = [], allModified = [], allRemoved = []

  while (hasMore) {
    const resp = await plaidClient.transactionsSync({ access_token: item.access_token, cursor })
    allAdded.push(...resp.data.added)
    allModified.push(...resp.data.modified)
    allRemoved.push(...resp.data.removed)
    hasMore = resp.data.has_more
    cursor = resp.data.next_cursor
  }

  // Store pending transactions too (previously filtered out entirely) — the
  // user wants to see a charge the moment it happens, not just once it
  // settles days later, and Plaid's sync semantics make this safe without
  // any extra bookkeeping: when a pending transaction posts, Plaid either
  // (a) sends a `modified` entry for the *same* transaction_id with
  // `pending: false` — which just upserts over the row already stored, or
  // (b) sends the old pending transaction_id in `removed` and a brand-new
  // posted transaction in `added` — the removed-handling below deletes the
  // stale pending row either way (a no-op delete if it was never one).
  // There's no `pending` column on public.transactions, so a pending row is
  // indistinguishable from a posted one once stored — acceptable for v1
  // (this app doesn't have a "pending" badge anywhere yet); it will simply
  // get replaced/removed on the next sync once the bank settles it.
  const upsertRows = [...allAdded, ...allModified]
    .map((tx) => ({
      user_id: userId,
      id: 'pl_' + tx.transaction_id,
      date: tx.date,
      description: tx.merchant_name || tx.name,
      amount: Math.abs(tx.amount),
      // Plaid convention: a positive amount is money leaving the account.
      type: tx.amount < 0 ? 'income' : 'expense',
      category: mapPlaidCategory(tx, guessCategory),
      // Lets the Accounts detail sheet / Transactions page filter by account.
      account_id: tx.account_id || null,
    }))

  if (upsertRows.length) {
    let { error } = await supabaseAdmin.from('transactions').upsert(upsertRows, { onConflict: 'user_id,id' })
    if (error && /account_id/i.test(error.message || '')) {
      // `account_id` column not migrated onto public.transactions yet — retry
      // without it so sync keeps working. Add the column (see supabase/plaid.sql
      // or `ALTER TABLE transactions ADD COLUMN account_id text;`) to enable
      // account-filtered transactions.
      const fallbackRows = upsertRows.map(({ account_id, ...rest }) => rest)
      ;({ error } = await supabaseAdmin.from('transactions').upsert(fallbackRows, { onConflict: 'user_id,id' }))
    }
    if (error) throw error
  }

  const added = allAdded.length
  const modified = allModified.length
  let removed = 0

  if (allRemoved.length) {
    const ids = allRemoved.map((r) => 'pl_' + r.transaction_id)
    const { error } = await supabaseAdmin.from('transactions').delete().eq('user_id', userId).in('id', ids)
    if (error) throw error
    removed = ids.length
  }

  // Refresh account balances too, so connected balances stay current
  // everywhere (Accounts totals/trend, Debt Tracker matching). Best
  // effort: if the balance refresh fails, keep whatever was stored.
  let accounts = item.accounts || []
  try {
    const acctRes = await plaidClient.accountsGet({ access_token: item.access_token })
    accounts = acctRes.data.accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      balance: a.balances?.current ?? null,
    }))
  } catch { /* keep previously stored accounts */ }

  // Status bookkeeping ("please wait, transactions are loading" placeholder
  // — see CLAUDE.md 2026-08-08 session entry). A brand-new item starts life
  // as 'syncing' (set on insert in app/api/plaid/exchange). A routine sync
  // loop completing does NOT by itself prove the full 730-day historical
  // backfill has landed — Plaid can take several SYNC_UPDATES_AVAILABLE
  // cycles to deliver all of it — so 'syncing' is only cleared when the
  // caller explicitly says the backfill is done via opts.clearSyncing (the
  // webhook route's HISTORICAL_UPDATE handler always passes true; its
  // SYNC_UPDATES_AVAILABLE handler and the manual "Sync now" route pass true
  // once the item is old enough that we assume the backfill has had time to
  // finish, as a fallback for a missed/undelivered webhook). A clean sync
  // still clears 'reauth_required'/'revoked' unconditionally, same as
  // before — that part of the item was genuinely broken and a successful
  // sync proves it's healthy again. Defensive: `status` may not be migrated
  // onto plaid_items yet (see CLAUDE.md: `ALTER TABLE plaid_items ADD
  // COLUMN IF NOT EXISTS status text DEFAULT 'ok';`), so retry without it if so.
  const priorStatus = item.status || 'ok'
  const nextStatus = priorStatus === 'syncing' ? (opts.clearSyncing ? 'ok' : 'syncing') : 'ok'

  const update = { cursor, last_synced: new Date().toISOString(), accounts, status: nextStatus }
  let { error: updErr } = await supabaseAdmin.from('plaid_items').update(update).eq('id', item.id)
  if (updErr && /status/i.test(updErr.message || '')) {
    const { status, ...rest } = update
    ;({ error: updErr } = await supabaseAdmin.from('plaid_items').update(rest).eq('id', item.id))
  }
  if (updErr) throw updErr

  return { added, modified, removed }
}

// Flags a plaid_items row with a status (e.g. 'reauth_required', 'revoked').
// Defensive: no-ops (logs + returns skipped:true) if the `status` column
// isn't migrated yet, so callers (webhook route, items PATCH) never crash
// because of a missing migration.
export async function setItemStatus(rowId, status) {
  const { error } = await supabaseAdmin.from('plaid_items').update({ status }).eq('id', rowId)
  if (error && /status/i.test(error.message || '')) {
    console.warn(`[plaid] plaid_items.status column missing; skipped setting status='${status}'. Run the migration in CLAUDE.md.`)
    return { skipped: true }
  }
  if (error) throw error
  return { ok: true }
}
