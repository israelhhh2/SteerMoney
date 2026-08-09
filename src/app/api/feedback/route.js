import { auth, clerkClient } from '@clerk/nextjs/server'
import { supabaseAdmin } from '@/lib/plaid-server'

// Backend for the floating feedback/bug widget (components/feedback-widget.jsx,
// mounted in app/(app)/layout.jsx). Two independent, best-effort channels so a
// user's note is never silently lost:
//   1. Insert into public.feedback via the service-role client (RLS enabled,
//      no policies — same pattern as plaid_items, see CLAUDE.md). Defensive:
//      if the table isn't migrated yet, log loudly and fall through to the
//      email channel instead of failing the request.
//   2. Email info@wagewatchcompliance.com via FormSubmit (formsubmit.co) —
//      free relay, no API key/account. First-ever submission requires a
//      one-time activation click in a confirmation email sent to the inbox.
// The user only needs to know "did my note get through", not which pipe
// carried it — this only returns an error if BOTH channels failed.
export async function POST(req) {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })

    const body = await req.json().catch(() => ({}))
    const { type, message, page, userAgent, wantsReply } = body || {}
    const trimmed = typeof message === 'string' ? message.trim().slice(0, 5000) : ''
    if (!trimmed) return Response.json({ error: 'Message is required' }, { status: 400 })
    const feedbackType = type === 'bug' ? 'bug' : 'feedback'

    // Fetch the user's email from Clerk server-side rather than trusting the
    // client payload — the widget only sends {type, message, page, userAgent,
    // wantsReply}, no email field.
    let email = null
    try {
      const client = await clerkClient()
      const u = await client.users.getUser(userId)
      email = u?.primaryEmailAddress?.emailAddress || u?.emailAddresses?.[0]?.emailAddress || null
    } catch (e) {
      console.error('[feedback] Clerk user lookup failed:', e?.message || e)
    }

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
      console.error('[feedback] supabaseAdmin not configured (missing SUPABASE_SERVICE_ROLE_KEY) — skipping DB insert, relying on email only')
    }

    // Email via FormSubmit (formsubmit.co) — free form-to-email relay, no API
    // key or account needed. One-time setup: the FIRST submission triggers a
    // confirmation email to info@wagewatchcompliance.com with an activation
    // link that must be clicked once; every submission after that is
    // delivered normally. Using the AJAX endpoint so we get a JSON response
    // instead of a redirect.
    let emailOk = false
    const emailSkipped = false
    try {
      const res = await fetch('https://formsubmit.co/ajax/info@wagewatchcompliance.com', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          _subject: `[SteerMoney ${feedbackType}] from ${email || 'unknown user'}`,
          _template: 'table',
          _captcha: 'false',
          type: feedbackType,
          from: `${email || 'unknown'} (user_id: ${userId})`,
          wants_reply: wantsReply === false ? 'no' : 'yes',
          page: page || 'unknown',
          user_agent: userAgent || 'unknown',
          message: trimmed,
          ...(email && wantsReply !== false ? { _replyto: email } : {}),
        }),
      })
      const out = await res.json().catch(() => null)
      if (!res.ok || !out || out.success === 'false' || out.success === false) {
        throw new Error(`FormSubmit responded ${res.status}: ${JSON.stringify(out).slice(0, 300)}`)
      }
      emailOk = true
    } catch (e) {
      console.error('[feedback] FormSubmit email send failed:', e?.message || e)
    }

    // Only fail the user if neither channel captured their note at all.
    if (!dbOk && !emailOk) {
      return Response.json({ error: "Couldn't save your feedback — please try again in a moment" }, { status: 500 })
    }

    return Response.json({ ok: true, dbOk, emailOk, emailSkipped })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to send feedback' }, { status: 500 })
  }
}
