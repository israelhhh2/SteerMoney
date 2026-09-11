// GET /api/reports/snapshot?grain=month&from=2026-01-01&to=2026-09-30&space_id=ws_...
//
// CONTRACT (kept stable — this is also what the in-app AI chat's tools call
// to answer questions about a user's spending/income history; changing the
// response shape here is a breaking change for that caller too):
//
//   query params:
//     grain     'day' | 'week' | 'month' | 'quarter' | 'year' (default 'month')
//     from, to  ISO dates (YYYY-MM-DD), both required together to override
//               the default window — omit both for lib/snapshots.js's own
//               sensible default range for the grain (see defaultRange())
//     space_id  optional — report on a shared space's data instead of the
//               caller's own personal data (see the auth note below)
//
//   response: {
//     grain: string,
//     periods: Snapshot[],       // one per period in [from, to], oldest first — full shape in lib/snapshots.js's buildSnapshot() header comment
//     latest: Snapshot | null,   // periods[periods.length - 1]
//     comparison: Comparison | null, // compare(latest, periods[periods.length - 2]) — see lib/snapshots.js's compare()
//   }
//
// Auth: the caller's own RLS-scoped Supabase client (createSupabaseServerClient),
// NEVER supabaseAdmin — see lib/reports-server.js's loadReportState for why
// `space_id` needs no separate membership check on a read-only route like
// this one.
import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { periodsFor, buildSnapshot, compare } from '@/lib/snapshots'
import { resolveGrain, resolveRange, loadReportState, catNameResolverFor, accountNameResolverFor } from '@/lib/reports-server'

export async function GET(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

    const { searchParams } = new URL(req.url)
    const targetId = searchParams.get('space_id') || user.id
    const grain = resolveGrain(searchParams.get('grain'))

    const state = await loadReportState(supabase, targetId)
    const { from, to } = resolveRange(grain, searchParams.get('from'), searchParams.get('to'), state.transactions)
    const opts = { catName: catNameResolverFor(state), accountName: accountNameResolverFor(state) }

    const periods = periodsFor(grain, from, to).map((p) => buildSnapshot(state, p, opts))
    const latest = periods[periods.length - 1] || null
    const previous = periods.length > 1 ? periods[periods.length - 2] : null
    const comparison = latest ? compare(latest, previous) : null

    return Response.json({ grain, periods, latest, comparison })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to build report' }, { status: 500 })
  }
}
