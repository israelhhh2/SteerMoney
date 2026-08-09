import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { plaidClient, plaidConfigured, supabaseAdmin, ownerIdsFor } from '@/lib/plaid-server'

// Lists this user's connected banks. Access tokens are never selected here,
// let alone returned to the client. Includes `status` (roadmap item 5:
// 'ok' | 'reauth_required' | 'revoked') so Settings can surface a "Fix
// connection" action — defensive if the column isn't migrated yet (see
// CLAUDE.md: `ALTER TABLE plaid_items ADD COLUMN IF NOT EXISTS status text
// DEFAULT 'ok';`), in which case every item is treated as 'ok'.
//
// Filters by ownerIdsFor(userId) (the caller's own id + every shared space
// they belong to), not a flat `.eq('user_id', userId)` — a connection moved
// into a shared space via "Move my data into this space" (app/api/plaid/
// transfer) has plaid_items.user_id set to the space id, so a flat equality
// check would make it disappear from the very account that moved it.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ items: [] })

    const ownerIds = await ownerIdsFor(userId)
    let { data, error } = await supabaseAdmin
      .from('plaid_items')
      .select('id, item_id, institution, accounts, last_synced, created_at, status')
      .in('user_id', ownerIds)
      .order('created_at', { ascending: false })

    if (error && /status/i.test(error.message || '')) {
      ;({ data, error } = await supabaseAdmin
        .from('plaid_items')
        .select('id, item_id, institution, accounts, last_synced, created_at')
        .in('user_id', ownerIds)
        .order('created_at', { ascending: false }))
    }
    if (error) throw error

    return Response.json({ items: (data || []).map((it) => ({ ...it, status: it.status || 'ok' })) })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to load connections' }, { status: 500 })
  }
}

// Removes a bank connection: best-effort revoke with Plaid, then delete the row.
// Looked up via ownerIdsFor (see GET above) so a connection already moved
// into a shared space can still be removed from there; the delete itself
// targets the row's own primary key rather than repeating the user_id
// match, since that row's user_id may legitimately be a space id, not this
// caller's own id.
//
// Also accepts `workspace_id` instead of `item_id` — bulk-disconnects every
// bank connection owned by that shared space in one call, for Settings'
// "Delete space" (src/store.jsx's deleteSpace()). plaid_items is
// service-role only (see supabase/plaid.sql), so unlike every other
// space-scoped table (which the client wipes itself via normal Supabase
// calls, RLS-permitted while still a member) this needs a server route.
// Ownership is checked explicitly here — service-role bypasses RLS, so
// "only the space's owner can delete it" has to be enforced in this route,
// not assumed from the caller having a valid session.
export async function DELETE(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { item_id, workspace_id } = await req.json()

    if (workspace_id) {
      const { data: ws, error: wsErr } = await supabaseAdmin
        .from('workspaces').select('owner_id').eq('id', workspace_id).maybeSingle()
      if (wsErr) throw wsErr
      if (!ws || ws.owner_id !== userId) return Response.json({ error: 'Only the space owner can do that' }, { status: 403 })

      const { data: rows, error: findErr } = await supabaseAdmin
        .from('plaid_items').select('id, access_token').eq('user_id', workspace_id)
      if (findErr) throw findErr

      for (const row of rows || []) {
        try { await plaidClient.itemRemove({ access_token: row.access_token }) } catch { /* best effort */ }
      }
      const { error: delErr } = await supabaseAdmin.from('plaid_items').delete().eq('user_id', workspace_id)
      if (delErr) throw delErr

      return Response.json({ ok: true, removed: (rows || []).length })
    }

    if (!item_id) return Response.json({ error: 'Missing item_id or workspace_id' }, { status: 400 })

    const ownerIds = await ownerIdsFor(userId)
    const { data: row, error: findErr } = await supabaseAdmin
      .from('plaid_items')
      .select('id, access_token')
      .in('user_id', ownerIds)
      .eq('item_id', item_id)
      .maybeSingle()
    if (findErr) throw findErr
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    try { await plaidClient.itemRemove({ access_token: row.access_token }) } catch { /* best effort, Plaid may already have revoked it */ }

    const { error: delErr } = await supabaseAdmin.from('plaid_items').delete().eq('id', row.id)
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
// column, same as GET above. Looked up via ownerIdsFor so a transferred
// connection's status can still be fixed from the account that moved it.
export async function PATCH(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { item_id, status } = await req.json()
    if (!item_id || !status) return Response.json({ error: 'Missing item_id or status' }, { status: 400 })

    const ownerIds = await ownerIdsFor(userId)
    const { error } = await supabaseAdmin.from('plaid_items').update({ status }).in('user_id', ownerIds).eq('item_id', item_id)
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
