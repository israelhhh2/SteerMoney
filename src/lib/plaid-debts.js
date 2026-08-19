import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'
import { matchesBankAccount } from '@/lib/finance'

// Auto-populates the Debt Tracker from a linked credit-card OR loan account
// (auto/personal/student/mortgage/home-equity/line-of-credit — anything
// Plaid reports as AccountType 'loan'), so "link a card or loan in Plaid"
// and "add it to Debt Tracker" become the same action instead of a manual
// Add Debt afterward. Called once right after app/api/plaid/exchange links
// a new bank, and again on every subsequent lib/plaid-sync.js
// syncPlaidItem() pass (manual "Sync now", the
// SYNC_UPDATES_AVAILABLE/HISTORICAL_UPDATE/INITIAL_UPDATE webhook handlers)
// so a synced debt's balance/minimum payment/due day track reality instead
// of going stale the moment the card or loan is linked. See roadmap item 10 /
// CLAUDE.md session log.
//
// Debts.jsx already treats "no credit_limit" as its loan signal (the
// Cards/Loans filter tab and the "leave blank for loans" Add Debt hint both
// key off `d.limit` truthiness — see lib/accounts.js's `kind: limitTruthy ?
// 'credit' : 'loan'` too) — that's why a loan row below never gets a
// credit_limit invented for it; a null limit IS what makes it read as a loan
// in the existing UI, no new column required.
//
// `accounts` is this item's already-normalized account list (account_id/
// name/official_name/mask/type/subtype/balance/limit/available — see
// app/api/plaid/exchange and lib/plaid-sync.js), not a raw Plaid
// accountsGet response.
//
// Best-effort throughout: every failure is caught and logged rather than
// thrown, so a hiccup here never breaks bank linking or a routine sync (same
// philosophy as the balance refresh in lib/plaid-sync.js).
// True when a Postgres/PostgREST error means "that column doesn't exist yet"
// (supabase/debts-plaid.sql hasn't been run) rather than some other failure
// (network, RLS, bad data) that a caller should NOT silently swallow by
// stripping columns and retrying. PostgREST returns PGRST204 with a message
// like "Could not find the 'plaid_account_id' column of 'debts' in the
// schema cache" for this; matched on both the code and a message regex since
// the exact wording isn't a stable public contract.
function isMissingColumnError(error) {
  if (!error) return false
  if (error.code === 'PGRST204') return true
  return /plaid_account_id|plaid_item_id/i.test(error.message || '')
}

export async function syncDebtsFromPlaid({ userId, itemId, institution, accessToken, accounts }) {
  if (!supabaseAdmin || !userId) {
    console.warn('[plaid] syncDebtsFromPlaid skipped: missing supabaseAdmin or userId', { hasAdmin: Boolean(supabaseAdmin), userId })
    return
  }
  // Robust to how an institution reports a credit card or loan: `type`
  // should always be 'credit' or 'loan' per Plaid's AccountType enum, but
  // fall back to subtype matching in case an institution reports it oddly
  // (type missing/other, or a stale cached `accounts` snapshot from before
  // this app started storing `type` on every account). The loan subtype
  // fallback is deliberately broad — auto/student/mortgage/personal/home
  // equity/line of credit are all real Plaid loan subtypes and none of them
  // contain the word "loan" itself for every institution, so this matches on
  // any of the subtype keywords rather than requiring one exact string.
  const debtAccounts = (accounts || []).filter((a) => {
    if (!a.account_id) return false
    if (a.type === 'credit' || a.type === 'loan') return true
    const subtype = String(a.subtype || '').toLowerCase()
    return subtype.includes('credit card') || /loan|mortgage|student|auto|line of credit|home equity/.test(subtype)
  })
  console.log(`[plaid] syncDebtsFromPlaid: ${debtAccounts.length}/${(accounts || []).length} accounts look like credit cards or loans for item ${itemId || '(new)'}`, debtAccounts.map((a) => ({ id: a.account_id, name: a.name, type: a.type, subtype: a.subtype })))
  if (!debtAccounts.length) return

  // liabilitiesGet is a separate Plaid product from transactions/accounts —
  // an institution that doesn't support it (or hasn't been granted it) 4xx's
  // here. Requirement: degrade gracefully — the debt still gets auto-created
  // from accountsGet's own balance/limit (already on `accounts`), just
  // without APR/minimum payment/due day, which stay blank for the user to
  // fill in manually like any other debt. This applies just as much to
  // auto/personal loans, which Plaid never returns a liability object for at
  // all (no interest rate, no minimum payment product exists for them) —
  // they fall all the way through to the balance-only path below every time,
  // same as a credit card from an issuer liabilitiesGet doesn't cover.
  const creditLiabilities = new Map() // account_id -> CreditCardLiability
  const studentLiabilities = new Map() // account_id -> StudentLoan
  const mortgageLiabilities = new Map() // account_id -> MortgageLiability
  try {
    const { data } = await plaidClient.liabilitiesGet({ access_token: accessToken })
    ;(data?.liabilities?.credit || []).forEach((l) => { if (l.account_id) creditLiabilities.set(l.account_id, l) })
    ;(data?.liabilities?.student || []).forEach((l) => { if (l.account_id) studentLiabilities.set(l.account_id, l) })
    ;(data?.liabilities?.mortgage || []).forEach((l) => { if (l.account_id) mortgageLiabilities.set(l.account_id, l) })
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
  // A debt that started life as a manual row and got fuzzy-matched/linked
  // below (rather than auto-created with the deterministic `pl_<account_id>`
  // id in the first place) keeps its *original* id forever — linking never
  // renames a row. Without this second index, the very next sync pass would
  // look it up by `byId.get('pl_<account_id>')`, miss (wrong key), then miss
  // the manualMatch check too (it's disqualified there precisely because it
  // already has a plaid_account_id) and fall through to inserting a second
  // `pl_<account_id>` row for the same account — the exact duplicate this
  // whole dedupe exists to prevent. Keyed on plaid_account_id so either path
  // finds the one true row for a given Plaid account.
  const byPlaidAccountId = new Map(existingDebts.filter((d) => d.plaid_account_id).map((d) => [d.plaid_account_id, d]))
  let nextPosition = existingDebts.reduce((max, d) => Math.max(max, d.position ?? 0), -1) + 1

  for (const a of debtAccounts) {
    // Exactly one of these can match (an account_id is only ever in one of
    // liabilitiesGet's three arrays) — pick whichever's present and read its
    // APR/minimum-payment/due-date fields under that liability type's own
    // names, since Plaid doesn't normalize those across credit/student/
    // mortgage. Auto and personal loans have no liability object at all (no
    // Plaid product covers them) — all three lookups miss and this account
    // falls straight through to the balance-only fields already on `a`,
    // same graceful-degrade as a credit card liabilitiesGet couldn't reach.
    const creditLiability = creditLiabilities.get(a.account_id)
    const studentLiability = studentLiabilities.get(a.account_id)
    const mortgageLiability = mortgageLiabilities.get(a.account_id)

    let apr = null, minPayment = null, dueDate = null
    if (creditLiability) {
      // Prefer the purchase APR, but fall back to ANY reported APR entry —
      // some institutions label theirs differently (balance_transfer_apr,
      // cash_apr, etc.) and reporting one of those beats reporting nothing.
      const aprEntry = creditLiability.aprs?.find((x) => x.apr_type === 'purchase_apr' && x.apr_percentage != null)
        || creditLiability.aprs?.find((x) => x.apr_percentage != null)
      apr = aprEntry?.apr_percentage != null ? `${aprEntry.apr_percentage}%` : null
      minPayment = creditLiability.minimum_payment_amount ?? null
      dueDate = creditLiability.next_payment_due_date ?? null
    } else if (studentLiability) {
      apr = studentLiability.interest_rate_percentage != null ? `${studentLiability.interest_rate_percentage}%` : null
      minPayment = studentLiability.minimum_payment_amount ?? null
      dueDate = studentLiability.next_payment_due_date ?? null
    } else if (mortgageLiability) {
      apr = mortgageLiability.interest_rate?.percentage != null ? `${mortgageLiability.interest_rate.percentage}%` : null
      // Mortgages don't have a "minimum payment" concept the way revolving
      // credit/student loans do — next_monthly_payment is the closest
      // equivalent (the scheduled principal+interest+escrow payment) and is
      // what the payoff calculators (parseAPR/payoffMonths in finance.js)
      // expect in min_payment anyway.
      minPayment = mortgageLiability.next_monthly_payment ?? null
      dueDate = mortgageLiability.next_payment_due_date ?? null
    }
    // "YYYY-MM-DD" -> day-of-month int.
    const dueDay = dueDate ? (parseInt(String(dueDate).slice(8, 10), 10) || null) : null
    // credit_limit stays null for basically every loan — none of the three
    // liability types above carry a limit field, and accountsGet's own
    // balances.limit (on `a`) is only ever populated for revolving products
    // (credit cards, HELOCs/lines of credit), which is exactly the set of
    // loans a limit is meaningful for. `credit_limit` fallback here is
    // deliberately scoped to creditLiability only — student/mortgage have no
    // such concept and reporting anything for them would be made up.
    const limit = a.limit ?? creditLiability?.limit ?? creditLiability?.credit_limit ?? null
    const isLoan = a.type === 'loan' || /loan|mortgage|student|auto|line of credit|home equity/.test(String(a.subtype || '').toLowerCase())
    const name = [institution, a.name, a.mask].filter(Boolean).join(' ').trim() || (isLoan ? 'Loan' : 'Credit card')

    const id = `pl_${a.account_id}`
    // Either a pure Plaid-created row (found by its deterministic id) or a
    // manual row that got linked on some earlier sync (found by
    // plaid_account_id instead, since linking never renames it) — either way
    // this account already has exactly one debts row, so refresh in place
    // rather than falling through to the manual-match/insert paths below and
    // risking a second row for the same account. See the note on
    // byPlaidAccountId above.
    const existing = byId.get(id) || byPlaidAccountId.get(a.account_id)

    if (existing) {
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
      const { error } = await supabaseAdmin.from('debts').update(patch).eq('user_id', userId).eq('id', existing.id)
      if (error) console.error('[plaid] failed refreshing synced debt', existing.id, error.message)
      else console.log('[plaid] refreshed synced debt', existing.id)
      continue
    }

    // No Plaid-linked row yet for this account — but don't duplicate a card
    // or loan the user already tracks manually. E.g. a manual debt named
    // "Wescom Auto Loan ••1234" matches on the mask, and one named just
    // "Wescom Auto Loan" still matches on the "wescom" institution token —
    // matchesBankAccount's ACCOUNT_FILLER set already treats bare words like
    // "loan"/"auto"/"student"/"mortgage" as too generic to prove a match on
    // their own (finance.js), so this can't false-positive-link two
    // unrelated loans that just happen to both say "Auto Loan". Same
    // fuzzy match (mask, then name-token overlap) lib/accounts.js's
    // reconcileDebtLimits() and Debts.jsx's "Bank connected" badge already
    // use: if an existing manual debt (never linked to any Plaid account)
    // matches, link this account to *that* row instead of creating a second
    // one for the same card or loan. `existingDebts` is only fetched once
    // above (not re-queried per account), so a debt just linked to account #1
    // this same pass must be marked in-memory too — otherwise a second
    // account that also fuzzy-matches the same manual debt (plausible:
    // "Capital One Venture" and "Capital One Venture X" both overlap on the
    // "capital"/"venture" tokens) would steal the link right back off
    // account #1 and silently merge two different debts into one row.
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
      if (error && isMissingColumnError(error)) {
        // supabase/debts-plaid.sql not run yet — retry without the new
        // columns so the balance/apr/min/due refresh still lands; the link
        // itself (and the "Synced from Plaid" badge) waits for the migration.
        console.warn('[plaid] debts.plaid_account_id/plaid_item_id columns missing — run supabase/debts-plaid.sql. Linking', manualMatch.id, 'without them for now.')
        const { plaid_account_id, plaid_item_id, ...rest } = patch
        ;({ error } = await supabaseAdmin.from('debts').update(rest).eq('user_id', userId).eq('id', manualMatch.id))
      }
      if (error) {
        console.error('[plaid] failed linking synced debt', manualMatch.id, error.message)
      } else {
        console.log('[plaid] linked existing manual debt to Plaid account', manualMatch.id, a.account_id)
        manualMatch.plaid_account_id = a.account_id // keep in-memory copy in sync, see note above
      }
      continue
    }

    // Brand-new debt, auto-created from this Plaid credit card or loan
    // account. credit_limit is `limit`, which for a loan is null unless
    // accountsGet actually reported one (line of credit / HELOC) — that's
    // deliberate, see the comment above on `limit`, and it's also exactly
    // what makes Debts.jsx's existing Cards/Loans filter and utilization
    // math treat this new row as a loan with no further changes needed.
    const insertRow = {
      user_id: userId, id, name, balance: a.balance ?? 0,
      apr, min_payment: minPayment ?? 0, due_day: dueDay,
      credit_limit: limit, note: null, position: nextPosition++,
      plaid_account_id: a.account_id, plaid_item_id: itemId || null,
    }
    let { error } = await supabaseAdmin.from('debts').insert(insertRow)
    if (error && isMissingColumnError(error)) {
      console.warn('[plaid] debts.plaid_account_id/plaid_item_id columns missing — run supabase/debts-plaid.sql. Creating', id, 'without them for now.')
      const { plaid_account_id, plaid_item_id, ...rest } = insertRow
      ;({ error } = await supabaseAdmin.from('debts').insert(rest))
    }
    if (error) console.error('[plaid] failed auto-creating debt for account', a.account_id, error.message)
    else console.log('[plaid] auto-created Debt Tracker row for Plaid credit/loan account', a.account_id, '->', id)
  }
}

// Cheaper sibling of syncDebtsFromPlaid() for the Balance-product paths
// (lib/plaid-balance.js's refreshItemBalances — the twice-daily cron and the
// rate-limited manual "Refresh" button): those deliberately never call
// liabilitiesGet (see the cost note in plaid-balance.js), so this only
// updates balance (and credit limit, when Plaid reports one) on debts rows
// already linked to a Plaid account via plaid_account_id — the same id
// buildAccountInventory() (lib/accounts.js) reads to display a debt-linked
// account's balance. Never creates or fuzzy-matches new debts (that stays
// syncDebtsFromPlaid()'s job, run from the Transactions-sync path); this is
// balance-only bookkeeping for rows that are already linked.
export async function updateDebtBalancesFromAccounts({ userId, accounts }) {
  if (!supabaseAdmin || !userId || !accounts?.length) return
  const byAccountId = new Map(accounts.filter((a) => a.account_id).map((a) => [a.account_id, a]))
  if (!byAccountId.size) return

  let linkedDebts
  try {
    const { data, error } = await supabaseAdmin.from('debts').select('id, plaid_account_id, balance, credit_limit').eq('user_id', userId).not('plaid_account_id', 'is', null)
    if (error) throw error
    linkedDebts = data || []
  } catch (e) {
    if (isMissingColumnError(e)) {
      // supabase/debts-plaid.sql not run yet — nothing to link balances to.
      console.warn('[plaid] debts.plaid_account_id column missing; skipping balance-only debt update. Run supabase/debts-plaid.sql.')
      return
    }
    console.error('[plaid] could not read linked debts for balance-only update, skipping:', e?.message || e)
    return
  }
  if (!linkedDebts.length) return

  for (const d of linkedDebts) {
    const a = byAccountId.get(d.plaid_account_id)
    if (!a) continue
    const patch = { balance: a.balance ?? d.balance, ...(a.limit != null ? { credit_limit: a.limit } : {}) }
    const { error } = await supabaseAdmin.from('debts').update(patch).eq('user_id', userId).eq('id', d.id)
    if (error) console.error('[plaid] failed balance-only update for debt', d.id, error.message)
  }
}
