import { supabaseAdmin } from '@/lib/plaid-server'

// Shared core behind POST /api/transactions/dedupe, and the automatic
// best-effort cleanup called from app/api/plaid/sync (end of each item's
// sync) and app/api/plaid/exchange (right after a bank is (re)connected).
//
// PM/CLAUDE.md note (production data, 2026-09): disconnecting a bank keeps
// its imported transactions by design (see app/api/account/erase's "stays
// in your account" comment), but re-connecting the SAME bank makes Plaid
// issue brand-new account_ids AND transaction_ids for the new item — there's
// nothing linking them back to the old ones, so every historical
// transaction lands in `transactions` a SECOND time under the new ids. This
// was found live: the three Capital One accounts each had an exact
// duplicate (same counts, same date ranges) filed under an account_id that
// no longer appeared in any plaid_items row.
//
// lib/plaid-sync.js's own re-point guard (see its big comment) stops this
// from happening on every FUTURE sync by re-pointing the old row instead of
// inserting a new one. This function is the "clean up what already
// happened" half: it finds transactions filed under an account_id that's
// "orphaned" — not present in ANY of this user's current plaid_items rows —
// and deletes the ones that have an identical (date, amount, description)
// twin filed under a currently-connected ("live") account, keeping the twin
// under the live account. An orphaned transaction with NO live twin is left
// completely alone — that's real history from a bank that's simply not
// connected anymore, not a duplicate, and this app's own philosophy
// (app/api/account/erase, "Remove" on a bank connection) is that
// disconnecting a bank never deletes what it already imported.
export async function dedupeOrphanedTransactions({ userId, dryRun = false }) {
  if (!supabaseAdmin) return { ok: false, error: 'Supabase admin client not configured' }

  const { data: items, error: itemsErr } = await supabaseAdmin.from('plaid_items').select('accounts').eq('user_id', userId)
  if (itemsErr) return { ok: false, error: itemsErr.message }

  const liveAccountIds = new Set()
  for (const row of items || []) for (const a of (row.accounts || [])) if (a?.account_id) liveAccountIds.add(a.account_id)

  // Paginate — PostgREST caps a single response (default/max 1000 rows) and
  // a long-lived account can easily have more transactions than that.
  const PAGE = 1000
  let all = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from('transactions')
      .select('id, date, amount, description, account_id')
      .eq('user_id', userId)
      .not('account_id', 'is', null)
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1)
    if (error) return { ok: false, error: error.message }
    all = all.concat(data || [])
    if (!data || data.length < PAGE) break
  }

  const txKey = (row) => row.date + '|' + Number(row.amount).toFixed(2) + '|' + String(row.description || '').trim().toLowerCase()

  const liveKeys = new Set()
  const orphaned = []
  for (const row of all) {
    if (liveAccountIds.has(row.account_id)) liveKeys.add(txKey(row))
    else orphaned.push(row)
  }

  const dupIds = []
  const byAccount = new Map() // account_id -> { account_id, orphaned, duplicatesRemoved, orphanedKept }
  for (const row of orphaned) {
    const b = byAccount.get(row.account_id) || { account_id: row.account_id, orphaned: 0, duplicatesRemoved: 0, orphanedKept: 0 }
    b.orphaned++
    if (liveKeys.has(txKey(row))) {
      b.duplicatesRemoved++
      dupIds.push(row.id)
    } else {
      b.orphanedKept++
    }
    byAccount.set(row.account_id, b)
  }

  if (!dryRun && dupIds.length) {
    // Chunked deletes — the same reason app/api/account/erase avoids a
    // single giant `.in(...)` call: PostgREST's query string blows up long
    // before a user with thousands of duplicate rows would hit its limit.
    const CHUNK = 100
    for (let i = 0; i < dupIds.length; i += CHUNK) {
      const chunk = dupIds.slice(i, i + CHUNK)
      const { error } = await supabaseAdmin.from('transactions').delete().eq('user_id', userId).in('id', chunk)
      if (error) return { ok: false, error: error.message }
    }
  }

  return {
    ok: true,
    dryRun,
    orphaned: orphaned.length,
    duplicatesRemoved: dupIds.length,
    orphanedKept: orphaned.length - dupIds.length,
    byAccount: [...byAccount.values()],
  }
}
