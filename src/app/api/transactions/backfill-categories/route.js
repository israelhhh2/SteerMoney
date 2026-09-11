import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'
import { backfillCategoriesFromPlaid } from '@/lib/transactions-backfill'

// "Clean up transactions" (Settings → Connected banks), third step — see
// lib/transactions-backfill.js for the actual algorithm and its safety
// rules (never overwrites a 'manual'/'rule'-sourced category). Re-pulls each
// connected bank's transaction history straight from Plaid so `merchant`/
// `pfc_primary`/`pfc_detailed` (supabase/categories-v2.sql) get filled in
// and every transaction gets a chance at the fuller category taxonomy
// (lib/categories.js) that existed sync passes never had.
//
// Scoping is identical to app/api/transactions/dedupe and
// app/api/transactions/reclassify: no `space_id` -> the caller's own
// personal rows; a `space_id` -> that shared space's rows, owner-only.
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

    const result = await backfillCategoriesFromPlaid({ userId: targetId, dryRun })
    if (!result.ok) return Response.json({ error: result.error || 'Backfill failed' }, { status: 500 })
    return Response.json(result)
  } catch (e) {
    return Response.json({ error: e?.message || 'Backfill failed' }, { status: 500 })
  }
}
