import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'

// Directory of all Supabase Auth users (id -> name/email) for the admin portal.
// Access requires a row in public.admins — verified against Supabase using the
// caller's own cookie-backed session (RLS via createSupabaseServerClient), so
// the `admins` table stays the single source of truth, same as before.
//
// Listing every user's profile needs Supabase's admin API
// (supabaseAdmin.auth.admin.listUsers), which only works with the
// service-role key — the same supabaseAdmin client already used for
// plaid_items/feedback (see lib/plaid-server.js). If SUPABASE_SERVICE_ROLE_KEY
// isn't configured, this degrades to returning just the calling admin's own
// directory entry rather than erroring outright — least-invasive fallback so
// the admin portal still renders something.
export async function GET() {
  const supabase = await createSupabaseServerClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

  const { data: adminRow, error: adminErr } = await supabase
    .from('admins').select('user_id').eq('user_id', user.id).maybeSingle()
  if (adminErr || !adminRow) return Response.json({ error: 'forbidden' }, { status: 403 })

  if (!supabaseAdmin) {
    return Response.json({
      users: [{
        id: user.id,
        name: [user.user_metadata?.first_name, user.user_metadata?.last_name].filter(Boolean).join(' ') || (user.email ? user.email.split('@')[0] : '—'),
        email: user.email || '',
        image: user.user_metadata?.avatar_url || null,
        created: user.created_at,
        lastActive: user.last_sign_in_at,
      }],
    })
  }

  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 200 })
  if (error) return Response.json({ error: error.message }, { status: 500 })

  return Response.json({
    users: (data.users || []).map((u) => ({
      id: u.id,
      name: [u.user_metadata?.first_name, u.user_metadata?.last_name].filter(Boolean).join(' ') || (u.email ? u.email.split('@')[0] : '—'),
      email: u.email || '',
      image: u.user_metadata?.avatar_url || null,
      created: u.created_at,
      lastActive: u.last_sign_in_at,
    })),
  })
}
