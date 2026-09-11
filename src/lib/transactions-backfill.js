import { plaidClient, supabaseAdmin } from '@/lib/plaid-server'
import { classifyTx, guessCategory } from '@/lib/plaid-sync'
import { cleanMerchant } from '@/lib/merchant'

// Shared core behind POST /api/transactions/backfill-categories — a one-time
// (re-runnable) pass that re-pulls each connected bank's own transaction
// history from Plaid's /transactions/get and uses it to fill in what
// lib/plaid-sync.js's ongoing transactionsSync-based row builder didn't
// exist to capture yet: `merchant`/`pfc_primary`/`pfc_detailed` (see
// supabase/categories-v2.sql), and a re-categorization onto the fuller
// taxonomy (lib/categories.js / lib/plaid-categories.js) for rows that were
// synced back when this app only ever mapped Plaid's data onto 6 categories.
//
// SAFETY RULES (the whole point of this file, so read before changing it):
//   1. A row's category is NEVER touched when its cat_source is 'manual',
//      'rule', or 'ai' — those are a person's own edit, a deliberate
//      keyword-rule categorization, or a Claude categorization
//      (POST /api/ai/categorize) elsewhere, never Plaid's automatic guess.
//   2. cat_source 'plaid' (or, defensively, missing/undefined on a project
//      that hasn't run categories-v2.sql yet — see below) is always safe to
//      recategorize: it's Plaid's own guess, and this is a BETTER guess from
//      the exact same source of truth.
//   3. cat_source null with a category that's already 'other' is also safe
//      — 'other' was never a deliberate choice, it's just where every
//      unmapped PFC value used to land.
//   4. cat_source null with a category that's something ELSE (not 'other')
//      is genuinely ambiguous — it predates this column entirely, so there's
//      no way to tell "Plaid's old conservative mapper got lucky" apart from
//      "the owner hand-picked this category before this column existed."
//      Per the PM brief: do NOT touch it (category OR merchant/pfc columns),
//      just count it as `skippedAmbiguous` so the impact is visible without
//      risking a real manual edit.
export async function backfillCategoriesFromPlaid({ userId, dryRun = false }) {
  if (!supabaseAdmin) return { ok: false, error: 'Supabase admin client not configured' }

  // Unlike lib/plaid-sync.js's ongoing upsert (which degrades gracefully
  // column-by-column, since it must never block routine syncing), this whole
  // pass is pointless without merchant/pfc_primary/pfc_detailed/cat_source —
  // there's nothing to write and no provenance to check safety rule #1-4
  // against. Fail with a clear, actionable message up front instead of
  // partway through a run.
  const { error: colErr } = await supabaseAdmin.from('transactions').select('cat_source, merchant, pfc_primary, pfc_detailed').eq('user_id', userId).limit(1)
  if (colErr && /column .* does not exist/i.test(colErr.message || '')) {
    return { ok: false, error: 'Run supabase/categories-v2.sql first (transactions.merchant/pfc_primary/pfc_detailed/cat_source columns are missing).' }
  }

  const { data: items, error: itemsErr } = await supabaseAdmin
    .from('plaid_items')
    .select('id, item_id, access_token, accounts, status, institution')
    .eq('user_id', userId)
  if (itemsErr) return { ok: false, error: itemsErr.message }

  const itemErrors = [] // { institution, item_id, error }
  const skippedItems = [] // { institution, item_id, reason }
  let itemsProcessed = 0
  let matched = 0
  let recategorized = 0
  let skippedAmbiguous = 0
  let notFound = 0
  const byCategory = {}
  const bump = (cat) => { byCategory[cat] = (byCategory[cat] || 0) + 1 }

  const TWO_YEARS_AGO = new Date()
  TWO_YEARS_AGO.setMonth(TWO_YEARS_AGO.getMonth() - 24)
  const floorDate = TWO_YEARS_AGO.toISOString().slice(0, 10)
  const today = new Date().toISOString().slice(0, 10)

  for (const item of items || []) {
    if (item.status === 'reauth_required' || item.status === 'revoked') {
      skippedItems.push({ institution: item.institution || null, item_id: item.item_id, reason: item.status })
      continue
    }

    const accountIds = (item.accounts || []).map((a) => a.account_id).filter(Boolean)
    const accountsById = new Map((item.accounts || []).map((a) => [a.account_id, a]))

    try {
      // Range = as far back as we already have transactions for this item's
      // accounts (so a re-run doesn't blindly re-pull everything every time),
      // capped at 24 months either way (Plaid's own practical history limit).
      let startDate = floorDate
      if (accountIds.length) {
        const { data: earliest } = await supabaseAdmin
          .from('transactions')
          .select('date')
          .eq('user_id', userId)
          .in('account_id', accountIds)
          .order('date', { ascending: true })
          .limit(1)
        if (earliest?.[0]?.date && earliest[0].date > floorDate) startDate = earliest[0].date
      }

      // Page through /transactions/get in 500-row pages (Plaid's max count
      // per request) until total_transactions is exhausted.
      const all = []
      let total = Infinity
      for (let offset = 0; offset < total; offset += 500) {
        const resp = await plaidClient.transactionsGet({
          access_token: item.access_token,
          start_date: startDate,
          end_date: today,
          options: { count: 500, offset },
        })
        all.push(...resp.data.transactions)
        total = resp.data.total_transactions
      }

      // Batch-fetch this item's already-stored rows once (chunked .in()
      // calls, same reason lib/transactions-dedupe.js chunks its deletes —
      // an id list of any real size blows up PostgREST's querystring).
      const ids = all.map((tx) => 'pl_' + tx.transaction_id)
      const existingById = new Map()
      const FETCH_CHUNK = 200
      for (let i = 0; i < ids.length; i += FETCH_CHUNK) {
        const chunk = ids.slice(i, i + FETCH_CHUNK)
        if (!chunk.length) continue
        const { data, error } = await supabaseAdmin
          .from('transactions')
          .select('id, category, cat_source, merchant, pfc_primary, pfc_detailed')
          .eq('user_id', userId)
          .in('id', chunk)
        if (error) throw error
        for (const row of data || []) existingById.set(row.id, row)
      }

      const updates = [] // { id, category?, merchant, pfc_primary, pfc_detailed, cat_source }
      for (const tx of all) {
        const rowId = 'pl_' + tx.transaction_id
        const existing = existingById.get(rowId)
        if (!existing) { notFound++; continue }
        matched++

        const catSource = existing.cat_source
        if (catSource === 'manual' || catSource === 'rule' || catSource === 'ai') continue // rule #1 — never touched

        const { category: newCategory } = classifyTx(tx, accountsById)
        const pfc = tx?.personal_finance_category
        const merchant = tx.merchant_name || cleanMerchant(tx.name) || null

        if (catSource === 'plaid' || catSource === 'import') {
          // Safe to recategorize — Plaid's own prior guess, or an import row
          // whose category was never a manual pick either. Always refresh
          // merchant/pfc even when the category itself doesn't change, so
          // this data lands even on a row that was already correctly
          // categorized.
          if (newCategory !== existing.category) recategorized++
          bump(newCategory)
          updates.push({ id: rowId, category: newCategory, merchant, pfc_primary: pfc?.primary || null, pfc_detailed: pfc?.detailed || null, cat_source: 'plaid' })
        } else {
          // catSource is null/undefined — no recorded provenance at all
          // (every row synced before categories-v2.sql existed).
          if (existing.category === 'other' || existing.category === newCategory) {
            if (newCategory !== existing.category) recategorized++
            bump(newCategory)
            updates.push({ id: rowId, category: newCategory, merchant, pfc_primary: pfc?.primary || null, pfc_detailed: pfc?.detailed || null, cat_source: 'plaid' })
          } else {
            // Rule #4 — genuinely ambiguous, could be a pre-existing manual
            // edit. Leave EVERYTHING alone (category and merchant/pfc both)
            // rather than guess.
            skippedAmbiguous++
          }
        }
      }

      if (!dryRun && updates.length) {
        const WRITE_CHUNK = 100
        for (let i = 0; i < updates.length; i += WRITE_CHUNK) {
          const chunk = updates.slice(i, i + WRITE_CHUNK)
          // Per-row update (category/merchant/pfc differ row to row) — plain
          // .update().eq('id', ...) per row rather than upsert, since upsert
          // would need every NOT NULL column (date/description/amount/type)
          // re-specified, which this pass doesn't have loaded and doesn't
          // want to risk clobbering.
          await Promise.all(chunk.map(({ id, ...patch }) =>
            supabaseAdmin.from('transactions').update(patch).eq('user_id', userId).eq('id', id)
          ))
        }
      }

      itemsProcessed++
    } catch (e) {
      itemErrors.push({ institution: item.institution || null, item_id: item.item_id, error: e?.response?.data?.error_message || e?.message || String(e) })
    }

    // Small pause between items — sequential on purpose, not a throughput
    // concern for a handful of connected banks, and easy on Plaid's rate
    // limits for an account with several.
    await new Promise((r) => setTimeout(r, 150))
  }

  // ---- second pass: transactions with no Plaid match at all ---------------
  // Imported (Wescom CSV) rows, manually-added rows, and any orphaned
  // history from a disconnected bank never show up in the loop above (they
  // have no 'pl_' counterpart in what Plaid just returned) — apply the same
  // keyword fallback lib/plaid-sync.js uses for a Plaid transaction with no
  // personal_finance_category, plus cleanMerchant() for a merchant guess.
  // Same safety rule as above: only ever touches a row that's still 'other'
  // AND has no recorded cat_source (never a 'manual'/'rule'/'import'-sourced
  // 'other' — that's a deliberate categorization choice, even if the chosen
  // category happens to be 'other').
  let ruleRecategorized = 0
  try {
    const PAGE = 1000
    let allOther = []
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('transactions')
        .select('id, description')
        .eq('user_id', userId)
        .eq('category', 'other')
        .is('cat_source', null)
        .range(from, from + PAGE - 1)
      if (error) break // best-effort — the first pass's results still stand either way
      allOther = allOther.concat(data || [])
      if (!data || data.length < PAGE) break
    }
    const ruleUpdates = []
    for (const row of allOther) {
      const guessed = guessCategory({ name: row.description })
      if (guessed === 'other') continue
      ruleUpdates.push({ id: row.id, category: guessed, merchant: cleanMerchant(row.description) || null, cat_source: 'rule' })
      bump(guessed)
    }
    ruleRecategorized = ruleUpdates.length
    if (!dryRun && ruleUpdates.length) {
      const WRITE_CHUNK = 100
      for (let i = 0; i < ruleUpdates.length; i += WRITE_CHUNK) {
        const chunk = ruleUpdates.slice(i, i + WRITE_CHUNK)
        await Promise.all(chunk.map(({ id, ...patch }) =>
          supabaseAdmin.from('transactions').update(patch).eq('user_id', userId).eq('id', id)
        ))
      }
    }
  } catch (e) {
    console.error('[backfill-categories] keyword-fallback pass failed (first pass results are unaffected):', e?.message || e)
  }

  return {
    ok: true,
    dryRun,
    itemsProcessed,
    matched,
    recategorized,
    ruleRecategorized,
    skippedAmbiguous,
    notFound,
    byCategory,
    itemErrors,
    skippedItems,
  }
}
