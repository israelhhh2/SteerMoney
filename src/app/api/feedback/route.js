import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { supabaseAdmin } from '@/lib/plaid-server'

// Backend for the floating feedback/bug widget (components/feedback-widget.jsx,
// mounted in app/(app)/layout.jsx). DB-only: inserts into public.feedback via
// the service-role client (RLS enabled, no policies — same pattern as
// plaid_items, see CLAUDE.md). Defensive: if the table isn't migrated yet,
// logs loudly and reports dbOk:false rather than throwing.
//
// The email channel (FormSubmit, formsubmit.co) moved to the BROWSER
// (components/feedback-widget.jsx) — FormSubmit blocks server-side/data-center
// requests (403), it's designed to be POSTed to directly from a page. This
// route no longer touches FormSubmit at all; the widget fires both this route
// and the FormSubmit request independently and only shows an error if both
// fail.
export async function POST(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    const email = user.email || null

    const body = await req.json().catch(() => ({}))
    const { type, message, page, userAgent } = body || {}
    const trimmed = typeof message === 'string' ? message.trim().slice(0, 5000) : ''
    if (!trimmed) return Response.json({ error: 'Message is required' }, { status: 400 })
    const feedbackType = type === 'bug' ? 'bug' : 'feedback'

    let dbOk = false
    if (supabaseAdmin) {
      try {
        const { error } = await supabaseAdmin.from('feedback').insert({
          user_id: userId,
          email,
          type: feedbackType,
          message: trimmed,
          page: page || null,
          user_agent: userAgent || null,
        })
        if (error) throw error
        dbOk = true
      } catch (e) {
        console.error('[feedback] DB insert failed — has the `feedback` table migration from CLAUDE.md been run? ', e?.message || e)
      }
    } else {
      console.error('[feedback] supabaseAdmin not configured (missing SUPABASE_SERVICE_ROLE_KEY) — skipping DB insert')
    }

    if (!dbOk) {
      return Response.json({ error: "Couldn't save your feedback — please try again in a moment", ok: false, dbOk: false }, { status: 500 })
    }

    return Response.json({ ok: true, dbOk })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to send feedback' }, { status: 500 })
  }
}
