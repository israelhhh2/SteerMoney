import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'
import { mapPlaidCategory } from '@/lib/plaid-categories'
import { syncDebtsFromPlaid } from '@/lib/plaid-debts'

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

  // Isolated from the balance refresh / Debt Tracker auto-sync below: a
  // transactionsSync failure (ITEM_LOGIN_REQUIRED, revoked access, a stale/
  // invalid cursor, a transient Plaid 5xx, etc.) used to throw straight out
  // of this function, which — since accountsGet-based balance refresh and
  // syncDebtsFromPlaid() (lib/plaid-debts.js) both run *after* this loop in
  // the function body — meant neither ever ran for that item. That's the
  // main reason an existing (already-linked) item's credit cards could sit
  // in the Debt Tracker feature forever without a row ever getting created:
  // any hiccup in the unrelated transactions pull silently blocked the debt
  // sync every single time "Sync now"/the webhook fired for that item.
  // Caught here so balance refresh + debt sync always get a chance to run;
  // re-thrown at the end so callers still see/log the transaction-sync
  // failure like before (status/reauth handling is unaffected — that's
  // driven by the webhook's own ITEM_LOGIN_REQUIRED code, not this catch).
  let txSyncError = null
  try {
    while (hasMore) {
      const resp = await plaidClient.transactionsSync({ access_token: item.access_token, cursor })
      allAdded.push(...resp.data.added)
      allModified.push(...resp.data.modified)
      allRemoved.push(...resp.data.removed)
      hasMore = resp.data.has_more
      cursor = resp.data.next_cursor
    }
  } catch (e) {
    console.error('[plaid] transactionsSync failed for item', item.item_id, '— continuing with balance/debt sync only:', e?.response?.data || e?.message || e)
    txSyncError = e
    cursor = item.cursor || undefined // don't persist a partial/advanced cursor from a failed run
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
      // Credit-card limit and depository available-balance, straight from
      // Plaid — previously dropped entirely, forcing views/Accounts.jsx's
      // "Credit limit needed" amber pill even when Plaid actually has the
      // limit, and AccountDetail/DepositoryRow to fall back AVAILABLE to
      // CURRENT (see CLAUDE.md 2026-08-05 (2)). Both are flat on
      // balances, no nesting beyond this.
      limit: a.balances?.limit ?? null,
      available: a.balances?.available ?? null,
    }))
  } catch { /* keep previously stored accounts */ }

  // Roadmap item 10: keep any Debt Tracker row auto-created/linked from a
  // credit account in this item synced with reality on every pass (manual
  // "Sync now", SYNC_UPDATES_AVAILABLE/HISTORICAL_UPDATE/INITIAL_UPDATE
  // webhooks all funnel through here) — see lib/plaid-debts.js. Best-effort,
  // same as the balance refresh right above: a failure here never breaks
  // transaction syncing.
  try {
    await syncDebtsFromPlaid({ userId, itemId: item.item_id, institution: item.institution || null, accessToken: item.access_token, accounts })
  } catch (e) {
    console.error('[plaid] auto-sync to Debt Tracker failed for item', item.item_id, e?.message || e)
  }

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
  // If transactionsSync itself failed above (txSyncError), none of that
  // "a clean sync proves it's healthy" logic holds — leave status exactly
  // as it was rather than incorrectly clearing 'reauth_required'/'revoked'
  // or 'syncing' off the back of a pass that didn't actually complete.
  const priorStatus = item.status || 'ok'
  const nextStatus = txSyncError ? priorStatus : (priorStatus === 'syncing' ? (opts.clearSyncing ? 'ok' : 'syncing') : 'ok')

  const update = { cursor, last_synced: new Date().toISOString(), accounts, status: nextStatus }
  let { error: updErr } = await supabaseAdmin.from('plaid_items').update(update).eq('id', item.id)
  if (updErr && /status/i.test(updErr.message || '')) {
    const { status, ...rest } = update
    ;({ error: updErr } = await supabaseAdmin.from('plaid_items').update(rest).eq('id', item.id))
  }
  if (updErr) throw updErr

  // Surface the transaction-sync failure to the caller now that the
  // best-effort balance refresh / Debt Tracker sync above have both had
  // their chance to run — callers (the manual "Sync now" route, the webhook
  // route) already log/report a thrown error from this function the same
  // way they did before this was deferred, so their behavior is unchanged
  // except that it no longer costs the rest of this item's sync.
  if (txSyncError) throw txSyncError

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
