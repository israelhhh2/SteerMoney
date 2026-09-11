import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'
import { categorizeResidualWithAI } from '@/lib/ai-categorize'

// "Clean up transactions" (Settings → Connected banks), optional fifth pass —
// see lib/ai-categorize.js for the actual algorithm/safety rules. Scoping
// identical to every other cleanup route (dedupe/reclassify/backfill-
// categories/match-payments): no `space_id` -> the caller's own personal
// transactions; a `space_id` -> that shared space's, owner-only.
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

    const result = await categorizeResidualWithAI({ userId: targetId, dryRun })
    if (!result.ok) {
      const notConfigured = /ANTHROPIC_API_KEY/i.test(result.error || '')
      return Response.json({ error: result.error || 'AI categorization failed' }, { status: notConfigured ? 503 : 500 })
    }
    return Response.json(result)
  } catch (e) {
    return Response.json({ error: e?.message || 'AI categorization failed' }, { status: 500 })
  }
}
