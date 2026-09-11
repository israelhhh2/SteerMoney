import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'
import { dedupeOrphanedTransactions } from '@/lib/transactions-dedupe'

// "Clean up transactions" (Settings → Connected banks) — see
// lib/transactions-dedupe.js for the actual matching rule and the PM/
// CLAUDE.md note on why it exists (a disconnect + reconnect of the same
// bank leaves every historical transaction imported twice, under a
// no-longer-live account_id). This route is also what the button's
// dry-run preview hits before showing a ConfirmDialog with real counts.
//
// Scoping mirrors app/api/account/erase exactly: no `space_id` in the body
// -> wipes the caller's own personal duplicate rows only; a `space_id` ->
// that shared space's rows, but ONLY if the caller owns the space (a
// non-owner member gets 403, never lets them run a cleanup pass over data
// they don't own).
export async function POST(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    if (!supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const body = await req.json().catch(() => ({}))
    const spaceId = body?.space_id || null
    const dryRun = !!body?.dry_run

    let targetId = userId
    if (spaceId) {
      const { data: ws, error: wsErr } = await supabase.from('workspaces').select('owner_id').eq('id', spaceId).maybeSingle()
      if (wsErr) return Response.json({ error: wsErr.message }, { status: 500 })
      if (!ws || ws.owner_id !== userId) return Response.json({ error: 'Only the space owner can clean up this space' }, { status: 403 })
      targetId = spaceId
    }

    const result = await dedupeOrphanedTransactions({ userId: targetId, dryRun })
    if (!result.ok) return Response.json({ error: result.error || 'Dedupe failed' }, { status: 500 })
    return Response.json(result)
  } catch (e) {
    return Response.json({ error: e?.message || 'Dedupe failed' }, { status: 500 })
  }
}
