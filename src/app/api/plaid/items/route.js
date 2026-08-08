import { auth } from '@clerk/nextjs/server'
import { plaidClient, plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'

// Lists this user's connected banks. Access tokens are never selected here,
// let alone returned to the client. Includes `status` (roadmap item 5:
// 'ok' | 'reauth_required' | 'revoked') so Settings can surface a "Fix
// connection" action — defensive if the column isn't migrated yet (see
// CLAUDE.md: `ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS status text
// DEFAULT 'ok';`), in which case every item is treated as 'ok'.
export async function GET() {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ items: [] })

    let { data, error } = await supabaseAdmin
      .from('plaid_items')
      .select('id, item_id, institution, accounts, last_synced, created_at, status')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })

    if (error && /status/i.test(error.message || '')) {
      ;({ data, error } = await supabaseAdmin
        .from('plaid_items')
        .select('id, item_id, institution, accounts, last_synced, created_at')
        .eq('user_id', userId)
        .order('created_at', { ascending: false }))
    }
    if (error) throw error

    return Response.json({ items: (data || []).map((it) => ({ ...it, status: it.status || 'ok' })) })
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

// Update-mode re-auth (roadmap item 5): after Plaid Link's update-mode flow
// succeeds, the client PATCHes the item back to 'ok' (no new access_token is
// issued in update mode, so there's nothing to exchange — just clear the
// flag) and separately triggers a sync. Defensive against a missing `status`
// column, same as GET above.
export async function PATCH(req) {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { item_id, status } = await req.json()
    if (!item_id || !status) return Response.json({ error: 'Missing item_id or status' }, { status: 400 })

    const { error } = await supabaseAdmin.from('plaid_items').update({ status }).eq('user_id', userId).eq('item_id', item_id)
    if (error && /status/i.test(error.message || '')) {
      // Column not migrated yet — nothing to persist, but don't fail the
      // re-auth flow over it.
      return Response.json({ ok: true, skipped: true })
    }
    if (error) throw error

    return Response.json({ ok: true })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to update connection' }, { status: 500 })
  }
}
