import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'

// "Move my data into this space" (Settings → Shared spaces →
// store.jsx's transferPersonalDataToSpace, called from
// views/Settings.jsx's SharedSpacesSection). plaid_items is service-role
// only — RLS with no policies at all (see supabase/plaid.sql) — so unlike
// every other slice (debts/budgets/transactions/etc., which the client
// moves itself via store.jsx's normal Supabase calls) a connected bank can
// only be reassigned from a server route holding the service-role key.
//
// Reassigns every plaid_items row currently owned by the signed-in user
// to the target space id. Two checks gate it: the caller must
// actually be a member of that workspace (workspace_members), and only
// rows whose user_id is literally this user's own id are touched —
// never another member's connections, even inside the same target space.
// After this, app/api/plaid/items (GET/DELETE/PATCH) and app/api/plaid/sync
// find the row again via ownerIdsFor(userId) (lib/plaid-server.js), and
// lib/plaid-sync.js's syncPlaidItem() already writes transactions under the
// row's own user_id — so nothing downstream needs to change for a
// transferred connection to keep working.
export async function POST(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    // Nothing to move if Plaid isn't set up at all — not an error, just a no-op.
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ moved: 0 })

    const { to_space_id } = await req.json()
    if (!to_space_id) return Response.json({ error: 'Missing to_space_id' }, { status: 400 })
    if (to_space_id === userId) return Response.json({ error: 'Invalid target space' }, { status: 400 })

    const { data: membership, error: memErr } = await supabaseAdmin
      .from('workspace_members')
      .select('workspace_id')
      .eq('user_id', userId)
      .eq('workspace_id', to_space_id)
      .maybeSingle()
    if (memErr) throw memErr
    if (!membership) return Response.json({ error: "You're not a member of that space" }, { status: 403 })

    const { data: rows, error: findErr } = await supabaseAdmin.from('plaid_items').select('id').eq('user_id', userId)
    if (findErr) throw findErr
    if (!rows || !rows.length) return Response.json({ moved: 0 })

    const { error: updErr } = await supabaseAdmin.from('plaid_items').update({ user_id: to_space_id }).eq('user_id', userId)
    if (updErr) throw updErr

    return Response.json({ moved: rows.length })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to move bank connections' }, { status: 500 })
  }
}
