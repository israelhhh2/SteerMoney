import { auth } from '@clerk/nextjs/server'
import { plaidClient, plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'

// Lists this user's connected banks. Access tokens are never selected here,
// let alone returned to the client.
export async function GET() {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ items: [] })

    const { data, error } = await supabaseAdmin
      .from('plaid_items')
      .select('id, item_id, institution, accounts, last_synced, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
    if (error) throw error

    return Response.json({ items: data })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to load connections' }, { status: 500 })
  }
}

// Removes a bank connection: best-effort revoke with Plaid, then delete the row.
export async function DELETE(req) {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { item_id } = await req.json()
    if (!item_id) return Response.json({ error: 'Missing item_id' }, { status: 400 })

    const { data: row, error: findErr } = await supabaseAdmin
      .from('plaid_items')
      .select('id, access_token')
      .eq('user_id', userId)
      .eq('item_id', item_id)
      .maybeSingle()
    if (findErr) throw findErr
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    try { await plaidClient.itemRemove({ access_token: row.access_token }) } catch { /* best effort, Plaid may already have revoked it */ }

    const { error: delErr } = await supabaseAdmin.from('plaid_items').delete().eq('user_id', userId).eq('item_id', item_id)
    if (delErr) throw delErr

    return Response.json({ ok: true })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to remove connection' }, { status: 500 })
  }
}
