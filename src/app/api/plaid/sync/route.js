import { auth } from '@clerk/nextjs/server'
import { plaidConfigured, supabaseAdmin, ownerIdsFor } from '@/lib/plaid-server'
import { syncPlaidItem } from '@/lib/plaid-sync'

// Pulls new/changed/removed transactions for every bank connected by this
// user and mirrors them into public.transactions. Looked up via
// ownerIdsFor(userId) rather than a flat `.eq('user_id', userId)` — a
// connection moved into a shared space via "Move my data into this space"
// (app/api/plaid/transfer) has plaid_items.user_id set to the space id, and
// syncPlaidItem() below already writes transactions under *that* row's own
// user_id (item.user_id), so once the item is found here everything else
// keeps working unchanged. Per-item sync logic lives in lib/plaid-sync.js,
// shared with the webhook route's SYNC_UPDATES_AVAILABLE handler.
export async function POST() {
  try {
    const { userId } = await auth()
    if (!userId) return Response.json({ error: 'unauthorized' }, { status: 401 })
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const ownerIds = await ownerIdsFor(userId)
    const { data: items, error: itemsErr } = await supabaseAdmin.from('plaid_items').select('*').in('user_id', ownerIds)
    if (itemsErr) throw itemsErr

    let added = 0, modified = 0, removed = 0
    const itemErrors = []
    for (const item of items || []) {
      // Per-item try/catch: one broken connection (reauth required, a bad
      // cursor, a Plaid outage for that institution) must not stop every
      // *other* connected bank from syncing in the same "Sync now" click —
      // previously a single throwing item aborted this whole loop, so a
      // user with e.g. one Capital One item stuck needing reauth would never
      // get their Wells Fargo item's transactions (or Debt Tracker
      // auto-sync, see lib/plaid-debts.js) refreshed either, even though
      // nothing was wrong with it.
      try {
        // Fallback for a 'syncing' item whose HISTORICAL_UPDATE/
        // SYNC_UPDATES_AVAILABLE webhook never arrived (not registered yet,
        // delivery failure, etc): once the item is old enough that Plaid's
        // backfill has almost certainly finished, a manual "Sync now" clears
        // the flag too, same as the webhook route does on its own timer.
        const ageMs = item.created_at ? Date.now() - new Date(item.created_at).getTime() : Infinity
        const r = await syncPlaidItem(item, { clearSyncing: ageMs > 15 * 60 * 1000 })
        added += r.added
        modified += r.modified
        removed += r.removed
      } catch (e) {
        console.error('[plaid] sync failed for item', item.item_id, item.institution, e?.response?.data || e?.message || e)
        itemErrors.push({ item_id: item.item_id, institution: item.institution || null, error: e?.response?.data?.error_message || e?.message || 'Sync failed' })
      }
    }

    return Response.json({ added, modified, removed, ...(itemErrors.length ? { itemErrors } : {}) })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Sync failed' }, { status: 500 })
  }
}
