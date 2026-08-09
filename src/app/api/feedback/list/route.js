import { auth } from '@clerk/nextjs/server'
import { supabaseAdmin } from '@/lib/plaid-server'

// Admin-only inbox for the feedback widget's DB channel (public.feedback).
// Access check mirrors app/api/admin/users/route.js exactly: verified against
// the caller's own session token so Supabase RLS on `admins` is the single
// source of truth, not a hardcoded id list. The actual row read then goes
// through supabaseAdmin (service role) since `feedback` has RLS enabled with
// no policies at all — same as plaid_items — so no client-side key can read
// it directly, admin or not.
export async function GET() {
  const { userId, getToken } = await auth()
  if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const token = await getToken()
  const apikey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
  const check = await fetch(
    `${process.env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/admins?select=user_id&user_id=eq.${userId}`,
    { headers: { apikey, Authorization: `Bearer ${token}` }, cache: 'no-store' }
  )
  const rows = check.ok ? await check.json() : []
  if (!rows.length) return Response.json({ error: 'forbidden' }, { status: 403 })

  if (!supabaseAdmin) {
    return Response.json({ error: 'Server not configured (missing SUPABASE_SERVICE_ROLE_KEY)' }, { status: 500 })
  }

  const { data, error } = await supabaseAdmin
    .from('feedback')
    .select('id,user_id,email,type,message,page,user_agent,created_at')
    .order('created_at', { ascending: false })
    .limit(200)

  if (error) {
    console.error('[feedback/list] query failed — has the `feedback` table migration from CLAUDE.md been run?', error.message || error)
    return Response.json({ error: error.message || 'Failed to load feedback' }, { status: 500 })
  }

  return Response.json({ feedback: data || [] })
}
