import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { claudeConfigured, MODEL } from '@/lib/claude'

// Tells the client (Settings' "Clean up transactions" checkbox, and any
// future AI entry point) whether the owner has set ANTHROPIC_API_KEY in
// Vercel yet, without exposing the key itself. Auth-gated like every other
// route in this app, even though the payload is harmless on its own — no
// route in this codebase responds to a signed-out request.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    return Response.json({ configured: claudeConfigured, model: MODEL })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to check AI status' }, { status: 500 })
  }
}
