import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'
import { reclassifyPlaidTransactions } from '@/lib/transactions-reclassify'

// "Clean up transactions" (Settings → Connected banks), second half — see
// lib/transactions-reclassify.js for the actual rule, its LIMITATION note
// (only 'pl_'-prefixed rows are touched — there's no per-row "manually
// edited" marker on this schema), and the PM/CLAUDE.md evidence that drove
// it (card payments/merchant refunds on a credit account were counted as
// income, inflating both Money In and Money Out on the Dashboard).
//
// Scoping is identical to app/api/transactions/dedupe and
// app/api/account/erase: no `space_id` -> the caller's own personal rows; a
// `space_id` -> that shared space's rows, owner-only.
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

    const result = await reclassifyPlaidTransactions({ userId: targetId, dryRun })
    if (!result.ok) return Response.json({ error: result.error || 'Reclassify failed' }, { status: 500 })
    return Response.json(result)
  } catch (e) {
    return Response.json({ error: e?.message || 'Reclassify failed' }, { status: 500 })
  }
}
