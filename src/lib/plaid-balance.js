import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'
import { updateDebtBalancesFromAccounts } from '@/lib/plaid-debts'

// Cost-motivated split from lib/plaid-sync.js: Plaid's Transactions product
// (transactionsSync, accountsGet) is billed per-item/month; the Balance
// product (accountsBalanceGet, "/accounts/balance/get") is billed per-call
// and deliberately force-refreshes (no cache), unlike accountsGet which can
// return a stale cached balance. Kept in its own file so the two "which
// Plaid product am I about to bill for" paths never get tangled together —
// this file is the ONLY place in the app that calls accountsBalanceGet, used
// by the twice-daily cron (app/api/cron/balances) and the rate-limited
// manual refresh (app/api/plaid/balance). Never used as a substitute for
// syncPlaidItem()'s own balance refresh (accountsGet, run once per
// transactions sync) — that one stays as-is.
//
// Merges only balances.current/available/limit into the existing per-account
// objects already stored in plaid_items.accounts (JSONB) — every other
// field (name, mask, type, subtype, account_id, official_name) survives
// untouched, same "don't clobber fields another path owns" convention
// lib/plaid-sync.js's balance-refresh section already follows.
export async function refreshItemBalances(item) {
  const res = await plaidClient.accountsBalanceGet({ access_token: item.access_token })
  const fresh = res.data.accounts || []
  const byId = new Map(fresh.map((a) => [a.account_id, a]))
  const existing = item.accounts || []

  const merged = existing.map((a) => {
    const f = byId.get(a.account_id)
    if (!f) return a
    return {
      ...a,
      balance: f.balances?.current ?? a.balance ?? null,
      available: f.balances?.available ?? a.available ?? null,
      limit: f.balances?.limit ?? a.limit ?? null,
    }
  })

  // An account Plaid reports that wasn't already stored (e.g. added to this
  // item since the last full accountsGet-based sync) — appended so it isn't
  // silently dropped, best-effort with only the fields this endpoint
  // actually returns.
  const existingIds = new Set(existing.map((a) => a.account_id))
  for (const f of fresh) {
    if (existingIds.has(f.account_id)) continue
    merged.push({
      account_id: f.account_id, name: f.name, official_name: f.official_name,
      mask: f.mask, type: f.type, subtype: f.subtype,
      balance: f.balances?.current ?? null, available: f.balances?.available ?? null, limit: f.balances?.limit ?? null,
    })
  }

  const nowIso = new Date().toISOString()
  let { error } = await supabaseAdmin.from('plaid_items').update({ accounts: merged, last_balance_at: nowIso }).eq('id', item.id)
  if (error && /last_balance_at/i.test(error.message || '')) {
    // Column not migrated yet — see CLAUDE.md's `ALTER TABLE plaid_items ADD
    // COLUMN IF NOT EXISTS last_balance_at timestamptz;`. Retry without it so
    // the actual balance data still lands; only the "Updated <relTime>" UI
    // note degrades (falls back to last_synced) until the migration runs.
    console.warn('[plaid balance] plaid_items.last_balance_at column missing; skipped. Run the migration in CLAUDE.md.')
    ;({ error } = await supabaseAdmin.from('plaid_items').update({ accounts: merged }).eq('id', item.id))
  }
  if (error) throw error

  // Debt Tracker rows linked to one of these accounts (plaid_account_id)
  // display their balance straight from the debts row (see
  // buildAccountInventory() in lib/accounts.js), not from plaid_items.accounts
  // — without this, a credit card/loan's balance never actually changed here,
  // even though this function just refreshed it above. Best-effort: a
  // failure here never blocks the balance refresh that already landed.
  try {
    await updateDebtBalancesFromAccounts({ userId: item.user_id, accounts: merged })
  } catch (e) {
    console.error('[plaid balance] debt balance update failed for item', item.item_id, e?.message || e)
  }

  return { ok: true, accounts: merged.length }
}
