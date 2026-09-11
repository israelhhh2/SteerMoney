import { supabaseAdmin } from '@/lib/plaid-server'
import { cleanMerchant } from '@/lib/merchant'
import { askJson, claudeConfigured, NOT_CONFIGURED_MESSAGE } from '@/lib/claude'
import { CATEGORY_DEFS } from '@/lib/categories'

// Shared core behind POST /api/ai/categorize — the optional fifth "Clean up
// transactions" pass (Settings.jsx): after dedupe/reclassify/backfill-
// categories/match-payments have all done their deterministic best, this
// asks Claude to take a guess at whatever's STILL sitting in 'other',
// grouped by merchant so the whole app only ever pays for one Claude call
// per distinct merchant, not one per transaction.
//
// SAFETY RULES (same posture as lib/transactions-backfill.js's — read
// before changing):
//   1. Only ever considers a row whose category is 'other' AND whose
//      cat_source is null/undefined, 'plaid', 'rule', or 'import' — NEVER
//      'manual' (a person's own pick) and NEVER 'ai' (already run through
//      this exact pass once — re-running it would just burn tokens
//      re-guessing the same merchant).
//   2. A merchant's rows are only actually recategorized when the model's
//      own confidence for that merchant is >= CONFIDENCE_THRESHOLD (0.75) —
//      everything below that comes back as a `suggestions` entry for the
//      owner to review, never silently applied.
//   3. cat_source 'ai' is written on every row this pass DOES touch — see
//      lib/plaid-sync.js's cat_source protection (treats 'ai' exactly like
//      'manual'/'rule': a routine Plaid re-sync must never revert it) and
//      lib/transactions-backfill.js/lib/transactions-reclassify.js (same).
//      It's still freely overwritable by a person picking a category by
//      hand (that path never checks cat_source at all before writing
//      'manual') — 'ai' is protected from every OTHER automatic pass, not
//      from a deliberate manual edit.
const MAX_MERCHANTS_PER_CALL = 150
const CONFIDENCE_THRESHOLD = 0.75
export const ALLOWED_AI_CATEGORIES = new Set([...CATEGORY_DEFS.map(([id]) => id), 'debt', 'income', 'transfer', 'refund'])
const SAFE_SOURCES = new Set([null, undefined, 'plaid', 'rule', 'import'])

export async function categorizeResidualWithAI({ userId, dryRun = false }) {
  if (!supabaseAdmin) return { ok: false, error: 'Supabase admin client not configured' }

  // ---- 1. collect candidate rows ----
  const PAGE = 1000
  let rows = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('id, description, merchant, amount, account_id, cat_source')
      .eq('user_id', userId)
      .eq('category', 'other')
      .range(from, from + PAGE - 1)
    if (error) {
      // Most likely cat_source/merchant not migrated yet (categories-v2.sql)
      if (/column .* does not exist/i.test(error.message || '')) {
        return { ok: false, error: 'Run supabase/categories-v2.sql first (transactions.merchant/cat_source columns are missing).' }
      }
      return { ok: false, error: error.message }
    }
    rows = rows.concat(data || [])
    if (!data || data.length < PAGE) break
  }
  const candidates = rows.filter((r) => SAFE_SOURCES.has(r.cat_source))
  if (!candidates.length) {
    return { ok: true, dryRun, merchantCount: 0, totalMerchants: 0, candidateTx: 0, applied: 0, byCategory: {}, suggestions: [] }
  }

  // ---- 2. group by cleanMerchant(description) ----
  // Account type (credit/depository/etc.) rides along per group as extra
  // context for the model — best-effort only, a manual/statement-imported
  // row's account_id won't resolve to a live Plaid account and just leaves
  // account_type null for that group, which is fine.
  const { data: items } = await supabaseAdmin.from('plaid_items').select('accounts').eq('user_id', userId)
  const accountType = new Map()
  for (const it of items || []) for (const a of (it.accounts || [])) if (a?.account_id) accountType.set(a.account_id, a.type || null)

  const groups = new Map() // lowercased merchant -> { merchant, ids, samples, amounts, accountTypes }
  for (const r of candidates) {
    const merchant = cleanMerchant(r.merchant || r.description) || String(r.description || '').slice(0, 60) || 'Unknown'
    const key = merchant.toLowerCase()
    if (!groups.has(key)) groups.set(key, { merchant, ids: [], samples: [], amounts: [], accountTypes: new Set() })
    const g = groups.get(key)
    g.ids.push(r.id)
    if (g.samples.length < 2 && r.description) g.samples.push(r.description)
    g.amounts.push(Number(r.amount) || 0)
    if (r.account_id && accountType.has(r.account_id)) g.accountTypes.add(accountType.get(r.account_id))
  }

  // Largest merchant groups first — caps at 150 merchants/call (per the
  // brief), so a huge backlog prioritizes the merchants covering the most
  // transactions rather than an arbitrary/alphabetical slice.
  const allGroups = [...groups.values()].sort((a, b) => b.ids.length - a.ids.length)
  const totalMerchants = allGroups.length
  const merchantList = allGroups.slice(0, MAX_MERCHANTS_PER_CALL)

  // Dry-run preview is FREE — no Claude call at all, just how many merchants
  // (and how many transactions those merchants cover) a real run would send.
  // Settings.jsx's "Clean up transactions" preview relies on this staying
  // free, same as every other pass's dry-run.
  if (dryRun) {
    return {
      ok: true, dryRun: true,
      merchantCount: merchantList.length, totalMerchants,
      candidateTx: candidates.length,
    }
  }

  if (!claudeConfigured) return { ok: false, error: NOT_CONFIGURED_MESSAGE }

  // ---- 3. ask Claude ----
  const payload = merchantList.map((g) => ({
    merchant: g.merchant,
    account_type: [...g.accountTypes].join(',') || null,
    amount_range: [Math.min(...g.amounts), Math.max(...g.amounts)].map((n) => Math.round(n * 100) / 100),
    samples: g.samples,
    transaction_count: g.ids.length,
  }))

  const categoryList = [...ALLOWED_AI_CATEGORIES].join(', ')
  const system = `You are categorizing uncategorized ("other") transaction merchants for a personal-finance app, from a batch of distinct merchants (not individual transactions). For EACH merchant given, pick the single best-fitting category id from exactly this list: ${categoryList}. Return ONLY valid JSON — no prose, no markdown fences — as an array with one entry per merchant given, in the same order: [{ "merchant": string (must exactly match the merchant string given), "category": string (one of the ids above), "confidence": number from 0 to 1, "reason": string, at most 8 words }]. If you genuinely can't tell what a merchant is, return "other" with a low confidence rather than guessing.`

  const { data: suggestionsRaw, usage } = await askJson({
    system,
    messages: [{ role: 'user', content: JSON.stringify(payload) }],
    maxTokens: 4096,
    label: 'ai/categorize',
  })

  const bySuggestedMerchant = new Map()
  for (const s of Array.isArray(suggestionsRaw) ? suggestionsRaw : []) {
    if (!s || typeof s.merchant !== 'string') continue
    const category = ALLOWED_AI_CATEGORIES.has(s.category) ? s.category : 'other'
    const confidence = typeof s.confidence === 'number' && Number.isFinite(s.confidence) ? Math.max(0, Math.min(1, s.confidence)) : 0
    bySuggestedMerchant.set(s.merchant.toLowerCase(), { merchant: s.merchant, category, confidence, reason: String(s.reason || '').slice(0, 120) })
  }

  const byCategory = {}
  const suggestions = [] // merchants below the confidence threshold, or the model skipped — surfaced for manual review, never applied
  let applied = 0
  const writes = [] // { ids, category }

  for (const g of merchantList) {
    const s = bySuggestedMerchant.get(g.merchant.toLowerCase())
    if (!s) {
      suggestions.push({ merchant: g.merchant, category: null, confidence: 0, reason: 'No response from the model', count: g.ids.length })
      continue
    }
    if (s.confidence >= CONFIDENCE_THRESHOLD) {
      writes.push({ ids: g.ids, category: s.category })
      byCategory[s.category] = (byCategory[s.category] || 0) + g.ids.length
      applied += g.ids.length
    } else {
      suggestions.push({ merchant: g.merchant, category: s.category, confidence: s.confidence, reason: s.reason, count: g.ids.length })
    }
  }

  if (writes.length) {
    const CHUNK = 100
    for (const w of writes) {
      for (let i = 0; i < w.ids.length; i += CHUNK) {
        const chunk = w.ids.slice(i, i + CHUNK)
        // cat_source: 'ai' — see the file-level comment above for why this
        // one string matters (protected from Plaid/backfill/reclassify,
        // freely overwritable by a person picking a category by hand).
        const { error } = await supabaseAdmin.from('transactions').update({ category: w.category, cat_source: 'ai' }).eq('user_id', userId).in('id', chunk)
        if (error) return { ok: false, error: error.message }
      }
    }
  }

  return {
    ok: true, dryRun: false,
    merchantsSent: merchantList.length, totalMerchants,
    applied, byCategory, suggestions, usage,
  }
}
