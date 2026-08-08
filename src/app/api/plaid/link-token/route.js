import { auth } from '@clerk/nextjs/server'
import { plaidClient, plaidConfigured, supabaseAdmin, getAppUrl } from '@/lib/plaid-server'

// Creates a Plaid Link token for the signed-in user so the client can open
// Plaid Link (react-plaid-link) and start a bank connection.
//
// Two modes:
//  - New connection (default): products: ['transactions'].
//  - Update mode / re-auth (roadmap item 5): pass { item_id } in the JSON
//    body to instead create the link token with that item's access_token,
//    which puts Plaid Link into update mode for a broken/expired connection.
//    Ownership is verified against the signed-in Clerk user before use.
export async function POST(req) {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
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
      if (!row || row.user_id !== userId) return Response.json({ error: 'Not found' }, { status: 404 })
      params.access_token = row.access_token
    } else {
      params.products = ['transactions']
    }

    const { data } = await plaidClient.linkTokenCreate(params)
    return Response.json({ link_token: data.link_token })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Failed to create link token' }, { status: 500 })
  }
}
