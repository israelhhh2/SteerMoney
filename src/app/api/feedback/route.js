import { auth, clerkClient } from '@clerk/nextjs/server'
import { supabaseAdmin } from '@/lib/plaid-server'

// Backend for the floating feedback/bug widget (components/feedback-widget.jsx,
// mounted in app/(app)/layout.jsx). Two independent, best-effort channels so a
// user's note is never silently lost:
//   1. Insert into public.feedback via the service-role client (RLS enabled,
//      no policies — same pattern as plaid_items, see CLAUDE.md). Defensive:
//      if the table isn't migrated yet, log loudly and fall through to the
//      email channel instead of failing the request.
//   2. Email info@wagewatchcompliance.com via Resend's plain REST API — no
//      SDK, just global fetch, per CLAUDE.md's no-npm-install-required note.
//      Skipped gracefully (logged loudly) if RESEND_API_KEY isn't set.
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

    let emailOk = false
    let emailSkipped = false
    if (process.env.RESEND_API_KEY) {
      try {
        const subject = `[SteerMoney ${feedbackType}] from ${email || 'unknown user'}`
        const text = [
          `Type: ${feedbackType}`,
          `From: ${email || 'unknown'} (user_id: ${userId})`,
          `Wants a reply: ${wantsReply === false ? 'no' : 'yes'}`,
          `Page: ${page || 'unknown'}`,
          `User agent: ${userAgent || 'unknown'}`,
          '',
          trimmed,
        ].join('\n')

        const payload = {
          from: 'SteerMoney Feedback <onboarding@resend.dev>',
          to: ['info@wagewatchcompliance.com'],
          subject,
          text,
        }
        if (email && wantsReply !== false) payload.reply_to = email

        const res = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          const errBody = await res.text().catch(() => '')
          throw new Error(`Resend responded ${res.status}: ${errBody}`)
        }
        emailOk = true
      } catch (e) {
        console.error('[feedback] Resend email send failed:', e?.message || e)
      }
    } else {
      emailSkipped = true
      console.error('[feedback] RESEND_API_KEY not set — skipping email entirely. Add it in Vercel to enable feedback emails to info@wagewatchcompliance.com (see CLAUDE.md).')
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
