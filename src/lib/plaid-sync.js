import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'
import { mapPlaidCategory } from '@/lib/plaid-categories'
import { syncDebtsFromPlaid } from '@/lib/plaid-debts'
import { isCardPaymentDescription } from '@/lib/recurring-detect'
import { cleanMerchant } from '@/lib/merchant'
import { matchPaymentsForUser } from '@/lib/debt-payments'

// Keyword map from Plaid's merchant/transaction name to this app's category
// ids — a defensive fallback for the rare transaction Plaid doesn't enrich
// with a `personal_finance_category` at all (the primary categorization path
// is mapPlaidCategory(), which reads Plaid's actual PFC taxonomy instead of
// guessing from the name), and also the ONLY categorizer available for
// imported/manual transactions that never went through Plaid at all (see
// lib/transactions-backfill.js's second pass). Extended to the full
// lib/categories.js taxonomy alongside mapPlaidCategory's PFC table — order
// matters (first match wins), and borrows some vocabulary from
// lib/wescom.js's own EXPENSE_RULES (that file's rules stay merchant-name
// specific to Wescom's CSV export; these stay generic enough for any
// institution's Plaid `name`/`merchant_name`).
export const CATEGORY_RULES = [
  ['housing', /\brent\b|mortgage|\bhoa\b/i],
  ['groceries', /grocery|market|supermarket|trader joe|whole foods|costco whse|vons|ralphs|albertsons|sprouts/i],
  ['dining', /restaurant|starbucks|coffee|pizza|mcdonald|chipotle|doordash|grubhub|\bcafe\b/i],
  ['transport', /\buber\b|\blyft\b|transit|\bmetro\b|amtrak|bike share|scooter/i],
  ['auto', /\bgas station\b|\bfuel\b|auto repair|chevron|\bshell\b|\barco\b|\bmobil\b|parking|\btoll/i],
  ['utilities', /electric|internet|\bcable\b|phone bill|utility|t-mobile|verizon|at&t|comcast/i],
  ['subscriptions', /netflix|\bhulu\b|spotify|disney\+|apple\.com\/bill|icloud|patreon|audible/i],
  ['entertainment', /cinema|movie|\bamc\b|regal |fandango|casino|amusement|museum/i],
  ['health', /pharmacy|\bcvs\b|walgreens|medical|clinic|doctor|dental|veterinary|\bvet\b/i],
  ['personal', /\bsalon\b|\bspa\b|barber|nails|beauty/i],
  ['household', /home depot|lowe.?s|\bikea\b|hardware|storage/i],
  ['kids', /daycare|childcare|toys.?r.?us/i],
  ['family', /\bgift\b|\bzelle\b|\bvenmo\b/i],
  ['travel', /airline|\bhotel\b|airbnb|expedia|\bdelta\b|united air|southwest/i],
  ['education', /tuition|\bschool\b|university|college/i],
  ['fees', /overdraft|late fee|interest charge|service fee|\birs\b|tax payment/i],
  ['cash', /\batm\b|cash withdrawal/i],
  ['business', /shipping|postage|legal services|accounting/i],
  ['shopping', /amazon|\btarget\b|walmart|\bebay\b/i],
]

export function guessCategory(tx) {
  const text = [tx.merchant_name, tx.name].filter(Boolean).join(' ')
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat
  return 'other'
}

// PM/CLAUDE.md note (production data, 2026-09): Plaid's own convention —
// `type: tx.amount < 0 ? 'income' : 'expense'` — is right for a depository
// (checking/savings) account, where money coming IN really is income. It's
// WRONG on a CREDIT account: there, a negative Plaid amount is money moving
// TOWARD the card — either the owner paying their own bill (not new income,
// it's the same dollars already counted as spending when the purchases
// posted) or a merchant refund/return (a credit, not income either). Left
// unfixed, every card payment/refund got double-counted as both an expense
// (on the checking account that sent it) AND income (on the card that
// received it) — inflating Money In and Money Out on the Dashboard at once.
// This only changes CATEGORY, never the stored amount or the `income` type
// for a payment/refund landing on a credit account — see the big comment
// inside classifyTx() below for exactly why 'refund' (not a negative
// `expense` amount) is this app's fix for the refund case.
//
// Determines account TYPE ('credit' | 'depository' | 'loan' | ... | null)
// for a transaction from the item's own `accounts` snapshot (same shape
// insertRow/accountsGet refresh in this file and app/api/plaid/exchange
// store: {account_id, type, subtype, ...}). `accountsById` is built once per
// sync pass, not per transaction — see its call site below.
// Exported so lib/transactions-backfill.js (POST /api/transactions/
// backfill-categories) can reuse the exact same payment/refund logic against
// historical Plaid transactions instead of re-implementing it.
export function classifyTx(tx, accountsById) {
  const desc = tx.merchant_name || tx.name || ''
  const pfc = tx?.personal_finance_category
  const acctType = accountsById.get(tx.account_id)?.type || null

  // Unmodified fallback for a depository account, an account of unknown
  // type (accounts not migrated/refreshed yet), or any credit-account
  // transaction that ISN'T a negative amount (a purchase — plain 'expense',
  // exactly as before).
  let type = tx.amount < 0 ? 'income' : 'expense'
  let category = mapPlaidCategory(tx, guessCategory)

  if (acctType === 'credit' && tx.amount < 0) {
    // Money moving INTO the card. Two real cases, told apart by Plaid's own
    // PFC taxonomy first, this app's existing card-payment keyword list
    // (lib/recurring-detect.js's isCardPaymentDescription — shared with
    // that file's own "don't suggest this as a recurring bill" filter and
    // lib/wescom.js's manual-import 'debt' rule) as a fallback for
    // institutions that don't enrich a transaction with a
    // personal_finance_category at all:
    //   (a) a bill PAYMENT — LOAN_PAYMENTS/TRANSFER_IN primary, or a
    //       description like "AMEX Payment Thank You"/"Capital One Autopay"
    //       — files as 'transfer', same as this app's other internal-money-
    //       movement rows (store.jsx's incomeIn/expensesIn/dataMonths and
    //       every Dashboard/Charts/Budgets view already exclude cat
    //       'transfer' from every income AND spending total).
    //   (b) anything else — a merchant REFUND/return credited back to the
    //       card. Genuinely not income, but this app's `amount` column
    //       always stores a positive number (Math.abs(tx.amount) below) and
    //       Transactions.jsx/AccountDetail.jsx hardcode
    //       `tx.type === 'income' ? '+' : '−'` immediately before calling
    //       fmt() on that amount — fmt() ALSO prepends its own '-' for a
    //       negative number (lib/utils.js), so type:'expense' with a
    //       negative amount would render as a literal double-negative
    //       ("−-$12.34") on every transaction row, plus every other
    //       type==='expense' sum across Charts/Budgets/recurring-detect
    //       would need auditing for whether it tolerates a negative addend.
    //       Simplest and safest fix, and the one this app already has
    //       precedent for: keep type:'income' (so the stored amount stays
    //       positive and every existing render path is untouched) and give
    //       it its own dedicated category, 'refund', excluded from every
    //       income total the exact same way 'transfer' already is (see
    //       store.jsx's incomeIn and every other `cat !== 'transfer'` filter
    //       — grep for '"refund"' to find each one this change touched).
    const looksLikePayment = pfc?.primary === 'LOAN_PAYMENTS' || pfc?.primary === 'TRANSFER_IN' || isCardPaymentDescription(desc)
    category = looksLikePayment ? 'transfer' : 'refund'
    // type stays 'income' either way — see the block comment above.
  } else if (acctType === 'depository' && tx.amount > 0 && category === 'debt' &&
             (pfc?.detailed === 'LOAN_PAYMENTS_CREDIT_CARD_PAYMENT' || isCardPaymentDescription(desc))) {
    // Money LEAVING checking specifically to pay off a credit card — the
    // purchases it's covering were already counted as spending when they
    // posted to the card, so counting the payment too would double-count
    // the same spending twice. Only credit-card payments get this
    // treatment: mapPlaidCategory() already maps every OTHER LOAN_PAYMENTS_*
    // sub-type (auto/student/mortgage/personal loan) to 'debt', and those
    // stay 'debt' here — paying down an auto loan or mortgage is real, new
    // money leaving the household, not money that's already been spent.
    category = 'transfer'
  }
  // Transfers between the user's own depository accounts (Plaid's
  // TRANSFER_IN/TRANSFER_OUT primary, e.g. "To Share 01"/"From Share 00")
  // already map to 'transfer' via mapPlaidCategory's PRIMARY_MAP regardless
  // of account type — nothing to do here, just noting it's intentional.

  return { type, category }
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

  // ---- orphaned re-import guard (production bug, 2026-09) ---------------
  // Disconnecting a bank keeps its imported transactions by design ("stays
  // in your account" — see app/api/account/erase's comment on the same
  // philosophy), but re-connecting the SAME bank makes Plaid issue brand-new
  // account_ids AND transaction_ids for the new item — there's nothing
  // linking them back to the old ones. Left alone, every historical
  // transaction gets inserted a SECOND time under the new ids, permanently
  // inflating every total this app computes from `transactions` (see
  // supabase/dedupe-orphaned-transactions.sql / POST /api/transactions/
  // dedupe, which clean up existing duplicates after the fact — this block
  // is the "stop making more of them" half of that fix).
  //
  // Instead of letting that duplicate get inserted, re-point the ALREADY-
  // STORED row (under the dead account_id) at the new account_id/
  // transaction_id and skip inserting the "new" row entirely. That preserves
  // any manual edit the owner made to the old row (recategorized, renamed,
  // logged against a recurring bill, etc.) — something a delete-then-insert
  // would silently lose — and updating the `id` too (not just `account_id`)
  // means a LATER `modified`/`removed` from Plaid for this transaction_id
  // still finds the row by id instead of orphaning it a second time.
  const repointedIds = new Set() // transaction_ids handled by re-pointing, not upserted below
  const incoming = [...allAdded, ...allModified]
  if (incoming.length && supabaseAdmin) {
    try {
      const dates = incoming.map((tx) => tx.date).filter(Boolean)
      const minDate = dates.reduce((a, b) => (b < a ? b : a), dates[0])
      const maxDate = dates.reduce((a, b) => (b > a ? b : a), dates[0])

      // "Live" account_ids = every account any of this user's CURRENT
      // plaid_items rows knows about (this item included — its stored
      // snapshot, not yet refreshed below), plus every account_id this very
      // batch just saw (covers a brand-new account on THIS item, whose
      // `accounts` snapshot hasn't been written yet this pass).
      const { data: siblingItems } = await supabaseAdmin.from('plaid_items').select('accounts').eq('user_id', userId)
      const liveAccountIds = new Set()
      for (const row of siblingItems || []) for (const a of (row.accounts || [])) if (a?.account_id) liveAccountIds.add(a.account_id)
      for (const tx of incoming) if (tx.account_id) liveAccountIds.add(tx.account_id)

      // One query for the whole batch's date range (not one per
      // transaction) — same "query once, build a Set/Map" approach the
      // dedupe route uses, just scoped to this pass's dates for speed.
      const { data: candidateRows } = await supabaseAdmin
        .from('transactions')
        .select('id, date, amount, description, account_id')
        .eq('user_id', userId)
        .gte('date', minDate)
        .lte('date', maxDate)

      const orphanByKey = new Map()
      for (const row of candidateRows || []) {
        if (!row.account_id || liveAccountIds.has(row.account_id)) continue // not orphaned
        const key = row.date + '|' + Number(row.amount).toFixed(2) + '|' + String(row.description || '').trim().toLowerCase()
        if (!orphanByKey.has(key)) orphanByKey.set(key, row)
      }

      if (orphanByKey.size) {
        for (const tx of incoming) {
          const desc = tx.merchant_name || tx.name || ''
          const key = tx.date + '|' + Math.abs(tx.amount).toFixed(2) + '|' + desc.trim().toLowerCase()
          const orphan = orphanByKey.get(key)
          if (!orphan) continue
          orphanByKey.delete(key) // each orphaned row re-points at most one incoming transaction
          // Deliberately only ever writes id/account_id — never category or
          // cat_source, so a manually/rule-recategorized orphaned row keeps
          // exactly the category it had. This transaction_id also lands in
          // repointedIds below, which excludes it from upsertRows entirely,
          // so it never goes through the cat_source-protection path either —
          // there's simply nothing here that could clobber it.
          const { error: repointErr } = await supabaseAdmin
            .from('transactions')
            .update({ id: 'pl_' + tx.transaction_id, account_id: tx.account_id || null })
            .eq('user_id', userId)
            .eq('id', orphan.id)
          if (!repointErr) repointedIds.add(tx.transaction_id)
        }
      }
    } catch (e) {
      // Best-effort, same as the balance refresh / debt sync below — a
      // failure here must never block the transaction sync itself. Worst
      // case a duplicate slips through and gets cleaned up later by the
      // dedupe route/SQL instead of being prevented up front.
      console.error('[plaid] orphaned-transaction re-point check failed for item', item.item_id, e?.message || e)
    }
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
  const accountsById = new Map((item.accounts || []).map((a) => [a.account_id, a]))
  const upsertRows = incoming
    .filter((tx) => !repointedIds.has(tx.transaction_id))
    .map((tx) => {
      const { type, category } = classifyTx(tx, accountsById)
      const pfc = tx?.personal_finance_category
      return {
        user_id: userId,
        id: 'pl_' + tx.transaction_id,
        date: tx.date,
        description: tx.merchant_name || tx.name,
        amount: Math.abs(tx.amount),
        type,
        category,
        // Lets the Accounts detail sheet / Transactions page filter by account.
        account_id: tx.account_id || null,
        // Plaid's own clean merchant name when it has one, else this app's
        // own best-effort cleanup of the raw name (lib/merchant.js) — stored
        // separately from `description` (which stays the raw name, unchanged
        // behavior) so a future re-categorization pass or rules feature has
        // something normalized to work from without re-fetching from Plaid.
        merchant: tx.merchant_name || cleanMerchant(tx.name) || null,
        // The raw PFC this row was categorized from — see CLAUDE.md/this
        // session's note: previously dropped entirely, which meant history
        // could never be re-categorized (as the taxonomy above improved)
        // without re-pulling from Plaid. Kept even when it didn't change the
        // outcome, so a future backfill pass always has the real signal.
        pfc_primary: pfc?.primary || null,
        pfc_detailed: pfc?.detailed || null,
        // Every row synced from Plaid starts life 'plaid'-sourced; the UI
        // (Transactions.jsx's TxDialog, AccountDetail's inline select) sets
        // this to 'manual' the moment a person picks a different category by
        // hand, so a later re-categorization pass (see
        // lib/transactions-backfill.js) can tell "never touched" apart from
        // "the owner already fixed this" and never clobber the latter.
        cat_source: 'plaid',
      }
    })

  // ---- never clobber a manually/rule-categorized row on a `modified` event ----
  // A transaction already stored gets upserted again here on any later
  // `modified` from Plaid — a pending transaction settling, an amount
  // correction, a merchant name Plaid enriches after the fact, etc. Without
  // this check, that upsert always overwrote `category`/`cat_source` with a
  // fresh classifyTx() result, silently reverting a category the owner
  // picked by hand (Transactions.jsx's TxDialog, AccountDetail's inline
  // select — both set cat_source:'manual') or one the keyword-rule backfill
  // set (cat_source:'rule') back to whatever Plaid/mapPlaidCategory would
  // guess today. Fetching the currently-stored category/cat_source for this
  // batch's ids up front — one query, chunked by 200 ids the same way every
  // other id-list query in this app is (see lib/transactions-dedupe.js) —
  // lets every OTHER field (amount/date/description/merchant/pfc_*) still
  // refresh normally while `category`/`cat_source` are pinned back to
  // whatever the owner/rule-backfill already set.
  const catSourceById = new Map()
  let catSourceProtectionAvailable = true
  if (upsertRows.length) {
    const ids = upsertRows.map((r) => r.id)
    const FETCH_CHUNK = 200
    for (let i = 0; i < ids.length && catSourceProtectionAvailable; i += FETCH_CHUNK) {
      const chunk = ids.slice(i, i + FETCH_CHUNK)
      const { data, error } = await supabaseAdmin.from('transactions').select('id, category, cat_source').eq('user_id', userId).in('id', chunk)
      if (error) {
        // Most likely cat_source not migrated yet (supabase/categories-v2.sql)
        // — nothing to protect against in that case, since no row could have
        // a 'manual'/'rule' cat_source recorded at all yet. Any other query
        // failure degrades the exact same way: this protection check is
        // ancillary (same "never let a best-effort add-on block the actual
        // sync" philosophy as the balance refresh/debt sync below) — skip it
        // for this pass rather than throwing, and let the upsert proceed
        // with classifyTx()'s fresh category like before this check existed.
        console.warn('[plaid] transactions.cat_source protection query failed — skipping manual/rule category protection for this sync (run supabase/categories-v2.sql if the column is missing):', error.message)
        catSourceProtectionAvailable = false
        break
      }
      for (const row of data || []) if (row.cat_source === 'manual' || row.cat_source === 'rule') catSourceById.set(row.id, row)
    }
  }
  if (catSourceProtectionAvailable && catSourceById.size) {
    for (const row of upsertRows) {
      const existing = catSourceById.get(row.id)
      if (existing) { row.category = existing.category; row.cat_source = existing.cat_source }
    }
  }

  // Columns this app may not have migrated onto public.transactions yet:
  // account_id (older) and merchant/pfc_primary/pfc_detailed/cat_source (see
  // supabase/categories-v2.sql). PostgREST's "column ... does not exist"
  // error (PGRST204) names one missing column per response, so this retries
  // in a small loop — dropping whichever column the error names — rather
  // than a single hardcoded fallback, so sync degrades correctly whichever
  // subset of these has actually been migrated.
  const OPTIONAL_TX_COLUMNS = ['account_id', 'merchant', 'pfc_primary', 'pfc_detailed', 'cat_source']
  if (upsertRows.length) {
    let rows = upsertRows
    let { error } = await supabaseAdmin.from('transactions').upsert(rows, { onConflict: 'user_id,id' })
    let guard = 0
    while (error && guard < OPTIONAL_TX_COLUMNS.length) {
      guard++
      const missing = OPTIONAL_TX_COLUMNS.find((col) => col in rows[0] && new RegExp(col, 'i').test(error.message || ''))
      if (!missing) break
      console.warn(`[plaid] transactions.${missing} column missing — retrying sync without it. Run supabase/categories-v2.sql (or supabase/plaid.sql for account_id) to enable it.`)
      rows = rows.map((r) => { const { [missing]: _drop, ...rest } = r; return rest })
      ;({ error } = await supabaseAdmin.from('transactions').upsert(rows, { onConflict: 'user_id,id' }))
    }
    if (error) throw error
  }

  // ---- automatic payment matching for MANUAL (no Plaid link) debts ----
  // Best-effort, same posture as the balance refresh / Debt Tracker sync
  // below: a failure here (migration not run yet, a transient query error)
  // must never block the transaction sync itself. Scoped to just this
  // batch's transaction ids (see lib/debt-payments.js's `transactions` param)
  // rather than re-scanning this user's whole history on every sync — the
  // manual "Clean up transactions" backfill (POST /api/debts/match-payments)
  // covers the full 24-month catch-up separately.
  if (upsertRows.length) {
    try {
      const result = await matchPaymentsForUser({ userId, transactions: upsertRows })
      if (!result?.ok) {
        console.warn('[debt-payments] auto-match skipped for item', item.item_id, '—', result?.error)
      } else if (result.matched.length || result.ambiguous.length) {
        console.log(`[debt-payments] item ${item.item_id}: auto-matched ${result.matched.length} payment(s), ${result.ambiguous.length} ambiguous`)
      }
    } catch (e) {
      console.error('[debt-payments] auto-match failed for item', item.item_id, e?.message || e)
    }
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

  // Honest timestamps: only stamp last_synced when transactionsSync actually
  // succeeded above — a failed pull (txSyncError) leaves it unchanged rather
  // than lying that this item is fresh (a stale last_synced still correctly
  // reflects the last time data really landed).
  const update = { cursor, accounts, status: nextStatus, ...(txSyncError ? {} : { last_synced: new Date().toISOString() }) }
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
