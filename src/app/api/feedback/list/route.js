import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'

// Admin-only inbox for the feedback widget's DB channel (public.feedback).
// Access check mirrors app/api/admin/users/route.js exactly: verified against
// the caller's own cookie-backed session so Supabase RLS on `admins` is the
// single source of truth, not a hardcoded id list. The actual row read then
// goes through supabaseAdmin (service role) since `feedback` has RLS enabled
// with no policies at all — same as plaid_items — so no client-side key can
// read it directly, admin or not.
export async function GET() {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const { data: adminRow, error: adminErr } = await supabase
    .from('admins').select('user_id').eq('user_id', user.id).maybeSingle()
  if (adminErr || !adminRow) return Response.json({ error: 'forbidden' }, { status: 403 })

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
