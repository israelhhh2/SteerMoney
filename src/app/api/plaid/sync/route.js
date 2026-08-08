import { auth } from '@clerk/nextjs/server'
import { plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'
import { syncPlaidItem } from '@/lib/plaid-sync'

// Pulls new/changed/removed transactions for every bank connected by this
// user and mirrors them into public.transactions. Personal data only (v1):
// synced rows always use the signed-in Clerk user id, never a shared space.
// Per-item sync logic lives in lib/plaid-sync.js, shared with the webhook
// route's SYNC_UPDATES_AVAILABLE handler.
export async function POST() {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const { data: items, error: itemsErr } = await supabaseAdmin.from('plaid_items').select('*').eq('user_id', userId)
    if (itemsErr) throw itemsErr

    let added = 0, modified = 0, removed = 0
    for (const item of items || []) {
      const r = await syncPlaidItem(item)
      added += r.added
      modified += r.modified
      removed += r.removed
    }

    return Response.json({ added, modified, removed })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Sync failed' }, { status: 500 })
  }
}
