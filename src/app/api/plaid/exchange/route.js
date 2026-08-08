import { auth } from '@clerk/nextjs/server'
import { plaidClient, plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'

// Exchanges a Plaid Link public_token for a permanent access_token and
// stores the connection. The access token never leaves this route.
export async function POST(req) {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { public_token, institution } = await req.json()
    if (!public_token) return Response.json({ error: 'Missing public_token' }, { status: 400 })

    const exchange = await plaidClient.itemPublicTokenExchange({ public_token })
    const { access_token, item_id } = exchange.data

    const accountsRes = await plaidClient.accountsGet({ access_token })
    const accounts = accountsRes.data.accounts.map((a) => ({
      account_id: a.account_id,
      name: a.name,
      official_name: a.official_name,
      mask: a.mask,
      type: a.type,
      subtype: a.subtype,
      balance: a.balances?.current ?? null,
      // Credit-card limit / depository available balance — same fields
      // lib/plaid-sync.js's balance refresh now stores, so a freshly
      // connected account has them from the very first snapshot instead of
      // waiting on the next sync. See lib/accounts.js buildAccountInventory.
      limit: a.balances?.limit ?? null,
      available: a.balances?.available ?? null,
    }))

    // New connections start life 'syncing' — Plaid's initial
    // transactionsSync call returns recent data fast, but the 730-day
    // historical backfill (days_requested, see app/api/plaid/link-token)
    // lands minutes later via the webhook's HISTORICAL_UPDATE/
    // SYNC_UPDATES_AVAILABLE handling (lib/plaid-sync.js). The client shows
    // a "pulling in your transactions" placeholder for as long as this is
    // 'syncing'. Defensive: retried below without `status` if the column
    // isn't migrated yet (see CLAUDE.md).
    const insertRow = {
      user_id: userId,
      item_id,
      access_token,
      institution: institution || null,
      accounts,
      status: 'syncing',
    }
    let { error } = await supabaseAdmin.from('plaid_items').insert(insertRow)
    if (error && /status/i.test(error.message || '')) {
      const { status, ...rest } = insertRow
      ;({ error } = await supabaseAdmin.from('plaid_items').insert(rest))
    }
    if (error) throw error

    return Response.json({ ok: true, institution: institution || null })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Failed to link bank' }, { status: 500 })
  }
}
