import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { plaidClient, plaidConfigured, supabaseAdmin, getAppUrl, ownerIdsFor } from '@/lib/plaid-server'

// Creates a Plaid Link token for the signed-in user so the client can open
// Plaid Link (react-plaid-link) and start a bank connection.
//
// Two modes:
//  - New connection (default): products: ['transactions'].
//  - Update mode / re-auth (roadmap item 5): pass { item_id } in the JSON
//    body to instead create the link token with that item's access_token,
//    which puts Plaid Link into update mode for a broken/expired connection.
//    Ownership is verified against the signed-in user before use.
export async function POST(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    if (!plaidConfigured) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    let body = {}
    try { body = await req.json() } catch { /* no JSON body sent — plain "connect a bank" flow */ }
    const { item_id } = body || {}

    const params = {
      user: { client_user_id: userId },
      client_name: 'SteerMoney',
      country_codes: ['US'],
      language: 'en',
    }

    // OAuth support (roadmap item 3) + webhooks (roadmap item 4): both need
    // an absolute app URL. Omit entirely when unknown (e.g. local dev with no
    // NEXT_PUBLIC_APP_URL/VERCEL_URL) — sandbox never required these, so
    // behavior is unchanged when APP_URL can't be resolved.
    const appUrl = getAppUrl(req)
    if (appUrl) {
      // NOTE: this exact URL must also be registered in Plaid Dashboard →
      // Team Settings → API → Allowed redirect URIs, or OAuth banks will
      // reject the redirect. See CLAUDE.md.
      params.redirect_uri = `${appUrl}/plaid-oauth`
      params.webhook = `${appUrl}/api/plaid/webhook`
    }

    if (item_id) {
      if (!supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })
      const { data: row, error } = await supabaseAdmin
        .from('plaid_items')
        .select('id, access_token, user_id')
        .eq('item_id', item_id)
        .maybeSingle()
      if (error) throw error
      // Ownership check widened to ownerIdsFor (own id + any shared space
      // this user belongs to) — a connection moved into a space via
      // "Move my data into this space" (app/api/plaid/transfer) has
      // plaid_items.user_id set to the space id, not this user's own id.
      const ownerIds = await ownerIdsFor(userId)
      if (!row || !ownerIds.includes(row.user_id)) return Response.json({ error: 'Not found' }, { status: 404 })
      params.access_token = row.access_token
    } else {
      params.products = ['transactions']
      // Liabilities (roadmap item 10 — auto-fill the Debt Tracker's APR/min
      // payment/due date from Plaid instead of fuzzy-matching guesswork):
      // required_if_supported_products asks for it on every institution that
      // offers it, without narrowing which institutions show up in Link at
      // all for ones that don't (unlike putting it in `products`, which
      // would hide any bank lacking Liabilities support entirely). See
      // app/api/plaid/exchange and lib/plaid-sync.js's syncDebtsFromPlaid()
      // (lib/plaid-debts.js), which handles a liabilitiesGet failure on an
      // unsupported Item gracefully either way.
      params.required_if_supported_products = ['liabilities']
      // Request the maximum available history (Plaid's cap is 730 days) so a
      // freshly connected account backfills as much of the user's real
      // transaction history as the institution will give up, instead of the
      // 90-day default. Only meaningful for brand-new Items — update mode
      // (the `item_id` branch above) can't change history depth on an Item
      // that already has Transactions added, so it's omitted there.
      params.transactions = { days_requested: 730 }
    }

    const { data } = await plaidClient.linkTokenCreate(params)
    return Response.json({ link_token: data.link_token })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Failed to create link token' }, { status: 500 })
  }
}
