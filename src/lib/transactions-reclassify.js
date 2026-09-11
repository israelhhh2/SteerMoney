import { supabaseAdmin } from '@/lib/plaid-server'
import { isCardPaymentDescription } from '@/lib/recurring-detect'

// Shared core behind POST /api/transactions/reclassify — a one-time
// backfill that re-applies lib/plaid-sync.js's account-type-aware
// payment/refund category rule (see the big comment inside that file's
// classifyTx()) to transactions that were synced BEFORE that rule existed.
//
// This can only work from what's actually stored on public.transactions —
// the original Plaid `personal_finance_category` and the transaction's
// signed amount are gone by the time a row is sitting in the database (this
// app stores category + Math.abs(amount), never the raw PFC). So unlike
// classifyTx() itself, this leans on the STORED category/type plus a
// description match (isCardPaymentDescription, shared with lib/plaid-sync.js
// and lib/recurring-detect.js's own recurring-bill filter) instead of PFC.
//
// The id prefix ('pl_' = Plaid-imported, anything else = manually-added —
// see store.jsx's mappers / Transactions.jsx's uid('tx')) is why this only
// ever touches 'pl_' rows in the first place. UPDATE (categories-v2.sql):
// a Plaid-imported row the owner already recategorized by hand used to be
// fair game for this pass too (still keeping its 'pl_' id, with no way to
// tell it apart from one never touched) — this now also skips any row whose
// `cat_source` is 'manual' (a person picked it in the UI), 'rule' (the
// keyword-backfill set it), or 'ai' (POST /api/ai/categorize set it), the
// same protection lib/plaid-sync.js's sync upsert and
// lib/transactions-backfill.js apply. Degrades to no protection
// at all (same behavior as before this column existed) on a project that
// hasn't run categories-v2.sql yet — see hasCatSource below.
export async function reclassifyPlaidTransactions({ userId, dryRun = false }) {
  if (!supabaseAdmin) return { ok: false, error: 'Supabase admin client not configured' }

  const { data: items, error: itemsErr } = await supabaseAdmin.from('plaid_items').select('accounts').eq('user_id', userId)
  if (itemsErr) return { ok: false, error: itemsErr.message }
  const accountType = new Map()
  for (const row of items || []) for (const a of (row.accounts || [])) if (a?.account_id) accountType.set(a.account_id, a.type || null)

  // cat_source (supabase/categories-v2.sql) may not be migrated yet on an
  // older project — select it when available so the loop below can honor
  // the same "never override a manual/rule categorization" rule
  // lib/plaid-sync.js's sync upsert and lib/transactions-backfill.js already
  // do; degrade to selecting without it (no protection possible — no row
  // could have a 'manual'/'rule' cat_source recorded yet anyway on a project
  // this far behind) rather than failing the whole reclassify pass.
  let hasCatSource = true
  {
    const { error: probeErr } = await supabaseAdmin.from('transactions').select('cat_source').eq('user_id', userId).limit(1)
    if (probeErr) hasCatSource = false
  }
  const selectCols = hasCatSource ? 'id, description, type, category, account_id, cat_source' : 'id, description, type, category, account_id'

  const PAGE = 1000
  let all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select(selectCols)
      .eq('user_id', userId)
      .like('id', 'pl_%')
      .not('account_id', 'is', null)
      .range(from, from + PAGE - 1)
    if (error) return { ok: false, error: error.message }
    all = all.concat(data || [])
    if (!data || data.length < PAGE) break
  }

  const updates = [] // { id, category }
  const byReason = { creditCardPayment: 0, creditRefund: 0, depositoryCardPayment: 0 }

  for (const row of all) {
    if (row.cat_source === 'manual' || row.cat_source === 'rule' || row.cat_source === 'ai') continue // never override a person's own pick, a rule-backfill's result, or a Claude categorization
    const acctType = accountType.get(row.account_id)
    if (!acctType) continue // account not found in any current plaid_items row — leave alone

    if (acctType === 'credit' && row.type === 'income') {
      // Every negative-Plaid-amount transaction on a credit account was
      // filed type:'income' before this fix — see lib/plaid-sync.js's
      // classifyTx() for the full "why". `category === 'debt'` covers rows
      // Plaid enriched with a LOAN_PAYMENTS personal_finance_category (the
      // production evidence: 29 Chase/33 Wells Fargo/25 Target rows), and
      // isCardPaymentDescription catches the same thing by description when
      // it wasn't. Everything else type:'income' on a credit account is a
      // merchant refund/return credited back to the card — 'refund', not
      // income, same reasoning as classifyTx().
      const looksLikePayment = row.category === 'debt' || isCardPaymentDescription(row.description)
      const nextCat = looksLikePayment ? 'transfer' : 'refund'
      if (nextCat !== row.category) {
        updates.push({ id: row.id, category: nextCat })
        byReason[looksLikePayment ? 'creditCardPayment' : 'creditRefund']++
      }
    } else if (acctType === 'depository' && row.type === 'expense' && row.category === 'debt' && isCardPaymentDescription(row.description)) {
      // Money leaving checking specifically to pay off a card — already
      // counted as spending when the card purchases posted, so this would
      // double-count it. Other LOAN_PAYMENTS_* (auto/student/mortgage/
      // personal loan) stay 'debt' — this only fires on a description match
      // since the original PFC `detailed` value isn't stored.
      updates.push({ id: row.id, category: 'transfer' })
      byReason.depositoryCardPayment++
    }
  }

  if (!dryRun) {
    for (const u of updates) {
      const { error } = await supabaseAdmin.from('transactions').update({ category: u.category }).eq('user_id', userId).eq('id', u.id)
      if (error) return { ok: false, error: error.message }
    }
  }

  return { ok: true, dryRun, changed: updates.length, byReason }
}
