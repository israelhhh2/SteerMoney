import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'
import { matchesBankAccount } from '@/lib/finance'

// Auto-populates the Debt Tracker from a linked credit-card account, so
// "link a card in Plaid" and "add it to Debt Tracker" become the same action
// instead of a manual Add Debt afterward. Called once right after
// app/api/plaid/exchange links a new bank, and again on every subsequent
// lib/plaid-sync.js syncPlaidItem() pass (manual "Sync now", the
// SYNC_UPDATES_AVAILABLE/HISTORICAL_UPDATE/INITIAL_UPDATE webhook handlers)
// so a synced debt's balance/minimum payment/due day track reality instead
// of going stale the moment the card is linked. See roadmap item 10 /
// CLAUDE.md session log.
//
// `accounts` is this item's already-normalized account list (account_id/
// name/official_name/mask/type/subtype/balance/limit/available — see
// app/api/plaid/exchange and lib/plaid-sync.js), not a raw Plaid
// accountsGet response.
//
// Best-effort throughout: every failure is caught and logged rather than
// thrown, so a hiccup here never breaks bank linking or a routine sync (same
// philosophy as the balance refresh in lib/plaid-sync.js).
export async function syncDebtsFromPlaid({ userId, itemId, institution, accessToken, accounts }) {
  if (!supabaseAdmin || !userId) return
  const creditAccounts = (accounts || []).filter((a) => a.type === 'credit' && a.account_id)
  if (!creditAccounts.length) return

  // liabilitiesGet is a separate Plaid product from transactions/accounts —
  // an institution that doesn't support it (or hasn't been granted it) 4xx's
  // here. Requirement: degrade gracefully — the debt still gets auto-created
  // from accountsGet's own balance/limit (already on `accounts`), just
  // without APR/minimum payment/due day, which stay blank for the user to
  // fill in manually like any other debt.
  const creditLiabilities = new Map() // account_id -> CreditCardLiability
  try {
    const { data } = await plaidClient.liabilitiesGet({ access_token: accessToken })
    ;(data?.liabilities?.credit || []).forEach((l) => { if (l.account_id) creditLiabilities.set(l.account_id, l) })
  } catch (e) {
    console.warn('[plaid] liabilitiesGet unavailable — auto-creating/refreshing debts from balances only:', e?.response?.data?.error_code || e?.message)
  }

  let existingDebts
  try {
    const { data, error } = await supabaseAdmin.from('debts').select('*').eq('user_id', userId)
    if (error) throw error
    existingDebts = data || []
  } catch (e) {
    console.error('[plaid] could not read existing debts, skipping auto-sync to Debt Tracker:', e?.message || e)
    return
  }

  const byId = new Map(existingDebts.map((d) => [d.id, d]))
  let nextPosition = existingDebts.reduce((max, d) => Math.max(max, d.position ?? 0), -1) + 1

  for (const a of creditAccounts) {
    const liability = creditLiabilities.get(a.account_id)
    const purchaseApr = liability?.aprs?.find((x) => x.apr_type === 'purchase_apr')
    const apr = purchaseApr?.apr_percentage != null ? `${purchaseApr.apr_percentage}%` : null
    const minPayment = liability?.minimum_payment_amount ?? null
    // "YYYY-MM-DD" -> day-of-month int. Plaid's own credit liability object
    // has no credit-limit field (confirmed against the SDK's CreditCardLiability
    // type) — balances.limit (on `a`, from accountsGet) is the only real
    // source, this is just a defensive fallback in case a future API version
    // adds one under a different key.
    const dueDay = liability?.next_payment_due_date ? (parseInt(String(liability.next_payment_due_date).slice(8, 10), 10) || null) : null
    const limit = a.limit ?? liability?.limit ?? liability?.credit_limit ?? null
    const name = [institution, a.name, a.mask].filter(Boolean).join(' ').trim() || 'Credit card'

    const id = `pl_${a.account_id}`
    const existing = byId.get(id)

    if (existing) {
      // Pure Plaid-created row (id is deterministic from the account_id) —
      // balance/min payment/due day always track Plaid on every sync; APR/
      // credit limit refresh too whenever Plaid actually returns a value,
      // but a round where Plaid has nothing (liabilitiesGet failed, or the
      // issuer doesn't report APR) never blanks out a number that's already
      // there — see the requirement note on not overwriting with null.
      const patch = {
        balance: a.balance ?? existing.balance,
        ...(apr != null ? { apr } : {}),
        ...(limit != null ? { credit_limit: limit } : {}),
        ...(minPayment != null ? { min_payment: minPayment } : {}),
        ...(dueDay != null ? { due_day: dueDay } : {}),
      }
      const { error } = await supabaseAdmin.from('debts').update(patch).eq('user_id', userId).eq('id', id)
      if (error) console.error('[plaid] failed refreshing synced debt', id, error.message)
      continue
    }

    // No Plaid-linked row yet for this account — but don't duplicate a card
    // the user already tracks manually. Same fuzzy match (mask, then
    // name-token overlap) lib/accounts.js's reconcileDebtLimits() and
    // Debts.jsx's "Bank connected" badge already use: if an existing manual
    // debt (never linked to any Plaid account) matches, link this account to
    // *that* row instead of creating a second one for the same card.
    const manualMatch = existingDebts.find((d) => !d.plaid_account_id && matchesBankAccount(d, [{ ...a, institution }]))
    if (manualMatch) {
      const patch = {
        balance: a.balance ?? manualMatch.balance,
        // Fill-once semantics here, same as reconcileDebtLimits — this row
        // was hand-entered by the user before connecting the bank, so an
        // existing apr/credit_limit they already typed is left alone even if
        // Plaid reports something different; only an empty field gets filled.
        ...(manualMatch.apr == null && apr != null ? { apr } : {}),
        ...(manualMatch.credit_limit == null && limit != null ? { credit_limit: limit } : {}),
        ...(minPayment != null ? { min_payment: minPayment } : {}),
        ...(dueDay != null ? { due_day: dueDay } : {}),
        plaid_account_id: a.account_id,
        plaid_item_id: itemId || null,
      }
      let { error } = await supabaseAdmin.from('debts').update(patch).eq('user_id', userId).eq('id', manualMatch.id)
      if (error && /plaid_account_id|plaid_item_id/i.test(error.message || '')) {
        // supabase/debts-plaid.sql not run yet — retry without the new
        // columns so the balance/apr/min/due refresh still lands; the link
        // itself (and the "Synced from Plaid" badge) waits for the migration.
        const { plaid_account_id, plaid_item_id, ...rest } = patch
        ;({ error } = await supabaseAdmin.from('debts').update(rest).eq('user_id', userId).eq('id', manualMatch.id))
      }
      if (error) console.error('[plaid] failed linking synced debt', manualMatch.id, error.message)
      continue
    }

    // Brand-new debt, auto-created from this Plaid credit account.
    const insertRow = {
      user_id: userId, id, name, balance: a.balance ?? 0,
      apr, min_payment: minPayment ?? 0, due_day: dueDay,
      credit_limit: limit, note: null, position: nextPosition++,
      plaid_account_id: a.account_id, plaid_item_id: itemId || null,
    }
    let { error } = await supabaseAdmin.from('debts').insert(insertRow)
    if (error && /plaid_account_id|plaid_item_id/i.test(error.message || '')) {
      const { plaid_account_id, plaid_item_id, ...rest } = insertRow
      ;({ error } = await supabaseAdmin.from('debts').insert(rest))
    }
    if (error) console.error('[plaid] failed auto-creating debt for account', a.account_id, error.message)
  }
}
