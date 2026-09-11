// GET /api/chat/usage — today's AI token usage for the signed-in user, for
// components/finance-chat.jsx's small footer ("X tokens left today"). Always
// scoped to the AUTHENTICATED caller, never a space_id — see
// lib/chat-usage.js's header comment for why usage is per-person, not
// per-space.
import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { claudeConfigured } from '@/lib/claude'
import { checkCap } from '@/lib/chat-usage'

export async function GET() {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

    const { used, cap } = await checkCap(user.id)
    return Response.json({ configured: claudeConfigured, used, cap, remaining: Math.max(0, cap - used) })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to check AI usage' }, { status: 500 })
  }
}
