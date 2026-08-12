import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { plaidConfigured, supabaseAdmin, ownerIdsFor } from '@/lib/plaid-server'
import { refreshItemBalances } from '@/lib/plaid-balance'

// Manual "Refresh" button (views/AccountDetail.jsx) — rate-limited per
// signed-in human (their own auth user id, NOT ownerIdsFor's broadened list —
// the limit is about the person clicking the button, not the space they're
// viewing, so it can't be reset just by switching spaces) to keep Plaid
// Balance-product call volume predictable. See CLAUDE.md for the full cost
// rationale: Transactions is billed per item/month, Balance per call — this
// route and app/api/cron/balances are the only two places that ever call
// accountsBalanceGet (lib/plaid-balance.js), deliberately never
// transactionsSync/accountsGet.
const MAX_MANUAL_REFRESHES_PER_DAY = 5

// Per-item cooldown, independent of the daily counter below. This is the
// real backstop if balance_refreshes is missing/unreadable (migration not
// run yet): without it, a broken counter would fail open into effectively
// unlimited Plaid calls. Always applied (not just in the fail-open path) —
// also cheaply protects against a double-click firing two requests before
// the first one's counter write has landed.
const ITEM_COOLDOWN_MS = 60 * 1000

function todayUtc() { return new Date().toISOString().slice(0, 10) }
function nextUtcMidnightIso() {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString()
}

// Reads today's refresh count for this user. `ok:false` means the table is
// missing or unreadable (most likely: the balance_refreshes migration — see
// CLAUDE.md — hasn't run yet). Deliberate design decision: FAIL OPEN on the
// daily counter in that case (log loudly, don't brick the feature over a
// missing migration) rather than fail closed — but ITEM_COOLDOWN_MS above is
// unconditional regardless of this, so "table missing" never means
// "unlimited Plaid calls," only "no daily cap yet, just a 60s-per-item one."
async function getRefreshCount(userId, day) {
  try {
    const { data, error } = await supabaseAdmin.from('balance_refreshes').select('count').eq('user_id', userId).eq('day', day).maybeSingle()
    if (error) throw error
    return { count: data?.count || 0, ok: true }
  } catch (e) {
    console.warn('[plaid balance] balance_refreshes unreadable (migration not run?) — failing open on the daily cap for this request:', e?.message || e)
    return { count: 0, ok: false }
  }
}

// Read-then-write increment, not an atomic RPC — acceptable here: worst case
// under a race is a couple of extra Plaid Balance calls in the same second,
// not an unbounded abuse vector (ITEM_COOLDOWN_MS still caps that), and this
// app has no Postgres function defined to increment atomically without one
// more migration this feature doesn't strictly need.
async function recordRefresh(userId, day, nextCount) {
  try {
    const { error } = await supabaseAdmin.from('balance_refreshes').upsert({ user_id: userId, day, count: nextCount }, { onConflict: 'user_id,day' })
    if (error) throw error
  } catch (e) {
    console.warn('[plaid balance] failed to persist refresh count (migration not run?):', e?.message || e)
  }
}

export async function POST(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ error: 'Plaid is not configured yet' }, { status: 503 })

    const day = todayUtc()
    const resetsAt = nextUtcMidnightIso()
    const { count, ok: counterOk } = await getRefreshCount(userId, day)

    // Never call Plaid past the cap — that's the entire point of this route.
    // Enforced strictly whenever the counter is actually readable.
    if (counterOk && count >= MAX_MANUAL_REFRESHES_PER_DAY) {
      return Response.json({
        error: "You've used today's 5 balance refreshes — they reset at midnight.",
        remaining: 0, limit: MAX_MANUAL_REFRESHES_PER_DAY, resetsAt,
      }, { status: 429 })
    }

    const { item_id } = await req.json().catch(() => ({}))

    // Ownership resolved via ownerIdsFor (the caller's own id + every shared
    // space they belong to) so an item already moved into a shared space
    // (see CLAUDE.md 2026-08-08 (17)) is still refreshable from the account
    // that moved it — same pattern every other app/api/plaid/* route uses.
    // The daily *rate limit* above is still keyed on the caller's own
    // `userId`, not these broadened ids — deliberately.
    const ownerIds = await ownerIdsFor(userId)
    let query = supabaseAdmin.from('plaid_items').select('*').in('user_id', ownerIds)
    if (item_id) query = query.eq('item_id', item_id)
    const { data: items, error: itemsErr } = await query
    if (itemsErr) throw itemsErr
    if (!items || !items.length) return Response.json({ error: 'No connected bank found' }, { status: 404 })

    let refreshed = 0
    const errors = []
    for (const item of items) {
      const lastMs = item.last_balance_at ? Date.now() - new Date(item.last_balance_at).getTime() : Infinity
      if (lastMs < ITEM_COOLDOWN_MS) { refreshed++; continue } // already fresh — skip the Plaid call entirely
      try {
        await refreshItemBalances(item)
        refreshed++
      } catch (e) {
        console.error('[plaid balance] refresh failed for item', item.item_id, e?.response?.data || e?.message || e)
        errors.push({ item_id: item.item_id, error: e?.response?.data?.error_message || e?.message || 'Refresh failed' })
      }
    }

    // One click of "Refresh" spends one unit of today's quota, regardless of
    // how many accounts/items that one click touched — the limit is about
    // the human's click, not a per-item tally.
    const nextCount = count + 1
    if (counterOk) await recordRefresh(userId, day, nextCount)

    return Response.json({
      ok: true, refreshed, remaining: Math.max(0, MAX_MANUAL_REFRESHES_PER_DAY - nextCount),
      limit: MAX_MANUAL_REFRESHES_PER_DAY, resetsAt, ...(errors.length ? { itemErrors: errors } : {}),
    })
  } catch (e) {
    return Response.json({ error: e?.response?.data?.error_message || e?.message || 'Refresh failed' }, { status: 500 })
  }
}

// Lazy counter check for the UI ("N left today") — reads the count without
// spending a Plaid call or touching the daily quota itself.
export async function GET() {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const day = todayUtc()
    const resetsAt = nextUtcMidnightIso()
    const { count, ok } = await getRefreshCount(user.id, day)
    return Response.json({
      remaining: Math.max(0, MAX_MANUAL_REFRESHES_PER_DAY - count), limit: MAX_MANUAL_REFRESHES_PER_DAY, resetsAt,
      ...(ok ? {} : { unknown: true }),
    })
  } catch (e) {
    return Response.json({ error: e?.message || 'Failed to load refresh status' }, { status: 500 })
  }
}
