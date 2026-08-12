import { plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'
import { refreshItemBalances } from '@/lib/plaid-balance'

// Twice-daily automatic balance refresh (Vercel Cron) — the cheap Balance-
// product half of roadmap item 7 ("background sync"), see CLAUDE.md session
// log for the cost rationale. System job: loops every plaid_items row for
// every user via supabaseAdmin (service role — there's no signed-in session
// on a cron request), isolated per item so one bad connection can't abort
// the run for everyone else's.
//
// Vercel Hobby plan allows only 2 cron jobs total, each triggered at most
// once per day — so "twice daily" is achieved with TWO vercel.json entries
// both pointing at this same path, at different hours (see CLAUDE.md for the
// exact JSON; this repo's vercel.json lives at the repo root, outside this
// project's mounted src/ folder, so it had to be documented rather than
// written directly this session).
//
// Auth: Vercel signs real cron invocations with `Authorization: Bearer
// $CRON_SECRET`. This route is public (see middleware.js — no Clerk/Supabase
// session exists on a cron request), so without *some* check anyone who
// finds the URL could trigger unlimited Plaid Balance calls, which defeats
// the entire cost-control point of this feature. Rule: if CRON_SECRET is
// set, the header must match exactly — no exceptions. If it's NOT set (not
// configured yet), log loudly and fall back to a weak signal (Vercel's own
// `vercel-cron/1.0` user-agent) rather than wide open — better than nothing,
// but NOT a real access control; set CRON_SECRET before trusting this in
// production.
function isAuthorized(req) {
  const secret = process.env.CRON_SECRET
  const authHeader = req.headers.get('authorization') || ''
  if (secret) return authHeader === `Bearer ${secret}`
  console.warn('[cron/balances] CRON_SECRET is not set — falling back to a weak vercel-cron user-agent check. Set CRON_SECRET in Vercel env vars.')
  return (req.headers.get('user-agent') || '').includes('vercel-cron')
}

export async function GET(req) {
  if (!isAuthorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  if (!plaidConfigured || !supabaseAdmin) return Response.json({ items: 0, refreshed: 0, errors: [] })

  const { data: items, error } = await supabaseAdmin.from('plaid_items').select('*')
  if (error) return Response.json({ error: error.message }, { status: 500 })

  let refreshed = 0
  const errors = []
  for (const item of items || []) {
    try {
      await refreshItemBalances(item)
      refreshed++
    } catch (e) {
      console.error('[cron/balances] refresh failed for item', item.item_id, e?.response?.data || e?.message || e)
      errors.push({ item_id: item.item_id, error: e?.response?.data?.error_message || e?.message || 'refresh failed' })
    }
  }

  return Response.json({ items: (items || []).length, refreshed, errors })
}
