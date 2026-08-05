import { auth } from '@clerk/nextjs/server'
import { plaidClient, plaidConfigured } from '@/lib/plaid-server'

// Creates a Plaid Link token for the signed-in user so the client can open
// Plaid Link (react-plaid-link) and start a bank connection.
export async function POST() {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { data } = await plaidClient.linkTokenCreate({
      user: { client_user_id: userId },
      client_name: 'SteerMoney',
      products: ['transactions'],
      country_codes: ['US'],
      language: 'en',
    })
    return Response.json({ link_token: data.link_token })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Failed to create link token' }, { status: 500 })
  }
}
