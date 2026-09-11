import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'
import { matchPaymentsForUser } from '@/lib/debt-payments'

// "Clean up transactions" (Settings → Connected banks), fourth pass — scans
// up to 24 months of transactions and logs an automatic payment on any
// manual (no Plaid link) debt whose payee_pattern matches, exactly like
// Debts.jsx's manual "Log payment" but hands-off. See lib/debt-payments.js
// for the matching/disambiguation rules, the missing-migration guard, and
// this route's own manual "Sync now"/webhook-side twin (lib/plaid-sync.js's
// syncPlaidItem, which runs the same matcher scoped to just that sync's
// batch after every connected-bank sync).
//
// Scoping is identical to app/api/transactions/dedupe and reclassify: no
// `space_id` in the body -> the caller's own personal debts/transactions; a
// `space_id` -> that shared space's, but only if the caller owns the space.
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

    const result = await matchPaymentsForUser({ userId: targetId, dryRun })
    if (!result.ok) {
      // A clear "run the migration" message rather than a bare, unexplained
      // 500 when supabase/debt-payments-auto.sql hasn't been run yet — see
      // lib/debt-payments.js's isMissingColumnError/MISSING_COLUMN_MSG.
      const missingMigration = /debt-payments-auto\.sql/i.test(result.error || '')
      return Response.json({ error: result.error || 'Payment matching failed' }, { status: missingMigration ? 503 : 500 })
    }
    return Response.json(result)
  } catch (e) {
    return Response.json({ error: e?.message || 'Payment matching failed' }, { status: 500 })
  }
}
