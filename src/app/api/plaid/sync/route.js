import { auth } from '@clerk/nextjs/server'
import { plaidClient, plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'

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

// Pulls new/changed/removed transactions for every bank connected by this
// user and mirrors them into public.transactions. Personal data only (v1):
// synced rows always use the signed-in Clerk user id, never a shared space.
export async function POST() {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { data: items, error: itemsErr } = await supabaseAdmin.from('plaid_items').select('*').eq('user_id', userId)
    if (itemsErr) throw itemsErr

    let added = 0, modified = 0, removed = 0

    for (const item of items || []) {
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
        }))

      if (upsertRows.length) {
        const { error } = await supabaseAdmin.from('transactions').upsert(upsertRows, { onConflict: 'user_id,id' })
        if (error) throw error
      }
      added += allAdded.filter((t) => !t.pending).length
      modified += allModified.filter((t) => !t.pending).length

      if (allRemoved.length) {
        const ids = allRemoved.map((r) => 'pl_' + r.transaction_id)
        const { error } = await supabaseAdmin.from('transactions').delete().eq('user_id', userId).in('id', ids)
        if (error) throw error
        removed += ids.length
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

      const { error: updErr } = await supabaseAdmin
        .from('plaid_items')
        .update({ cursor, last_synced: new Date().toISOString(), accounts })
        .eq('id', item.id)
      if (updErr) throw updErr
    }

    return Response.json({ added, modified, removed })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Sync failed' }, { status: 500 })
  }
}
