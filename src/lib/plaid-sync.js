import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'

// Small keyword map from Plaid's merchant/transaction name to this app's
// category ids. Deliberately simple (v1); users can always re-categorize
// in the Transactions view afterward.
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
export async function syncPlaidItem(item) {
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

  const upsertRows = [...allAdded, ...allModified]
    .filter((tx) => !tx.pending)
    .map((tx) => ({
      user_id: userId,
      id: 'pl_' + tx.transaction_id,
      date: tx.date,
      description: tx.merchant_name || tx.name,
      amount: Math.abs(tx.amount),
      // Plaid convention: a positive amount is money leaving the account.
      type: tx.amount < 0 ? 'income' : 'expense',
      category: guessCategory(tx),
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

  const added = allAdded.filter((t) => !t.pending).length
  const modified = allModified.filter((t) => !t.pending).length
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

  // A clean sync means the item is healthy again — clear any prior
  // reauth/error flag. Defensive: `status` may not be migrated onto
  // plaid_items yet (see CLAUDE.md: `ALTER TABLE plaid_items ADD COLUMN IF
  // NOT EXISTS status text DEFAULT 'ok';`), so retry without it if so.
  const update = { cursor, last_synced: new Date().toISOString(), accounts, status: 'ok' }
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
