import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { plaidClient, plaidConfigured, supabaseAdmin, ownerIdsFor } from '@/lib/plaid-server'

// Lists this user's connected banks. Access tokens are never selected here,
// let alone returned to the client. Includes `status` (roadmap item 5:
// 'ok' | 'reauth_required' | 'revoked') and `last_balance_at` (the
// balance-only-refresh feature — see lib/plaid-balance.js, CLAUDE.md session
// log) — both defensive if the column isn't migrated yet, in which case
// `status` defaults to 'ok' and `last_balance_at` defaults to null (the
// account modal's "Updated <time>" line then falls back to `last_synced`).
//
// Tries progressively narrower column sets on a "column does not exist"
// error instead of one hardcoded fallback, so this degrades correctly
// whether last_balance_at, status, both, or neither have been migrated yet —
// same defensive intent as the single-column check this replaced, just able
// to shed more than one newer column.
const COLUMN_TIERS = [
  'id, item_id, institution, accounts, last_synced, created_at, status, last_balance_at',
  'id, item_id, institution, accounts, last_synced, created_at, status',
  'id, item_id, institution, accounts, last_synced, created_at',
]
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
    let data, error
    for (const cols of COLUMN_TIERS) {
      ;({ data, error } = await supabaseAdmin
        .from('plaid_items')
        .select(cols)
        .in('user_id', ownerIds)
        .order('created_at', { ascending: false }))
      if (!error || !/column .* does not exist/i.test(error.message || '')) break
    }
    if (error) throw error

    return Response.json({ items: (data || []).map((it) => ({ ...it, status: it.status || 'ok', last_balance_at: it.last_balance_at || null })) })
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
      .select('id, user_id, access_token')
      .in('user_id', ownerIds)
      .eq('item_id', item_id)
      .maybeSingle()
    if (findErr) throw findErr
    if (!row) return Response.json({ error: 'Not found' }, { status: 404 })

    try { await plaidClient.itemRemove({ access_token: row.access_token }) } catch { /* best effort, Plaid may already have revoked it */ }

    const { error: delErr } = await supabaseAdmin.from('plaid_items').delete().eq('id', row.id)
    if (delErr) throw delErr

    // Debt Tracker rows tied to this connection (lib/plaid-debts.js's
    // syncDebtsFromPlaid stamps every debt it touches with plaid_item_id —
    // this Plaid item_id, not plaid_items.id). Disconnecting a bank never
    // deletes transactions already imported (see Settings.jsx's own
    // RemoveBankDialog copy — mirrored on the client-side duplicate dialogs
    // that call this same route), but a left-behind debts row pointing at a
    // now-gone connection would show a stale/broken "Synced from Plaid"
    // badge forever, and matters even more here: removing a *duplicate*
    // connection (see lib/accounts.js's findDuplicateItems /
    // app/api/plaid/exchange's duplicate flag) is exactly the case that
    // leaves one of these behind, since the duplicate item's own account_id
    // never matched the original's debts row and so got auto-created a
    // second one. A row with the deterministic `pl_<account_id>` id was
    // auto-created purely from this connection's data, so it's safe to
    // delete outright. A row without that id prefix started life as a
    // manual entry that a later sync fuzzy-linked to this connection (see
    // plaid-debts.js's manualMatch path) — deleting it would destroy the
    // user's own hand-entered balance/APR/history, so it's only unlinked
    // (plaid_account_id/plaid_item_id cleared) and falls back to being a
    // plain manual debt again. Best-effort: never blocks the disconnect
    // itself, and degrades quietly if debts.plaid_item_id isn't migrated yet
    // (see plaid-debts.js's isMissingColumnError note on the same column).
    try {
      const { data: linkedDebts, error: linkedErr } = await supabaseAdmin
        .from('debts')
        .select('id')
        .eq('user_id', row.user_id)
        .eq('plaid_item_id', item_id)
      if (linkedErr) throw linkedErr
      const autoCreatedIds = (linkedDebts || []).filter((d) => d.id.startsWith('pl_')).map((d) => d.id)
      const manualIds = (linkedDebts || []).filter((d) => !d.id.startsWith('pl_')).map((d) => d.id)
      if (autoCreatedIds.length) {
        await supabaseAdmin.from('debts').delete().eq('user_id', row.user_id).in('id', autoCreatedIds)
      }
      if (manualIds.length) {
        await supabaseAdmin.from('debts').update({ plaid_account_id: null, plaid_item_id: null }).eq('user_id', row.user_id).in('id', manualIds)
      }
    } catch (e) {
      console.error('[plaid] cleaning up debts for removed connection failed (non-fatal)', e?.message || e)
    }

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
