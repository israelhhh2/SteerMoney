import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import { createClient } from '@supabase/supabase-js'

// Server-only Plaid client. Functional once PLAID_CLIENT_ID and PLAID_SECRET
// are set; routes should check plaidConfigured and degrade to a 503 note
// when they're absent instead of throwing.
export const plaidConfigured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)

const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '',
      'PLAID-SECRET': process.env.PLAID_SECRET || '',
    },
  },
})

export const plaidClient = new PlaidApi(configuration)

// Best-effort item revoke shared by every route that permanently removes a
// plaid_items row: app/api/plaid/items' DELETE handler (single item, and its
// workspace_id bulk-disconnect branch) and app/api/account/erase's backstop
// cleanup. Plaid may already have revoked the item itself (user removed
// access from their bank's side, item error, etc.) — that's not a reason to
// block deleting our own row, so failures here are swallowed, not thrown.
export async function revokePlaidItem(accessToken) {
  try { await plaidClient.itemRemove({ access_token: accessToken }) } catch { /* best effort */ }
}

// Service-role Supabase client: bypasses RLS entirely, so it must only ever
// be used from server routes, never imported into client components. This
// is the only client allowed to touch public.plaid_items (see
// supabase/plaid.sql, which enables RLS with no policies at all).
// Supabase renamed this credential: older projects issue it as the
// "service_role key" (SUPABASE_SERVICE_ROLE_KEY), newer dashboards call the
// same thing a "secret key" and people naturally name the env var
// SUPABASE_SECRET_KEY. Accept either, because getting this wrong fails
// SILENTLY and catastrophically: `supabaseAdmin` becomes null, and every
// route that guards on it (app/api/plaid/items returns `{ items: [] }`,
// sync/balance/webhook all bail early) behaves exactly as though the user
// has no connected banks — no error, no toast, just an app that never
// updates a balance and never lists a connection.
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SECRET_KEY
if (!SERVICE_KEY) console.error('[plaid-server] No SUPABASE_SERVICE_ROLE_KEY / SUPABASE_SECRET_KEY set — every Plaid server route will act as if no banks are connected.')
export const supabaseAdmin = SERVICE_KEY
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, SERVICE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null

// "Move my data into this space" (Settings → Shared spaces, see
// app/api/plaid/transfer) reassigns a connected bank's plaid_items.user_id
// from the signed-in user's own id to a shared space's id. Every route that
// looks up "this user's" plaid_items by a flat `.eq('user_id', ownerId)`
// would otherwise lose track of a transferred connection — this resolves
// every user_id a row could legitimately be filed under for that user: their
// own id, plus every workspace they're a member of. Falls back to just their
// own id if supabaseAdmin isn't configured or the workspace_members lookup
// fails, matching this app's existing "personal data only" behavior when
// shared spaces aren't in play.
export async function ownerIdsFor(ownerId) {
  if (!supabaseAdmin) return [ownerId]
  try {
    const { data, error } = await supabaseAdmin.from('workspace_members').select('workspace_id').eq('user_id', ownerId)
    if (error || !data) return [ownerId]
    return [ownerId, ...data.map((r) => r.workspace_id)]
  } catch {
    return [ownerId]
  }
}

// Resolves the app's public base URL (no trailing slash) so routes can build
// absolute `redirect_uri`/`webhook` URLs for Plaid. Priority: explicit
// NEXT_PUBLIC_APP_URL env var, then Vercel's auto-injected VERCEL_URL, then
// (if a request is passed) the incoming request's own Host header. Returns
// null when nothing is known — callers must omit the OAuth/webhook params
// entirely in that case rather than guessing, exactly like today's sandbox
// behavior with no APP_URL set.
export function getAppUrl(req) {
  if (process.env.NEXT_PUBLIC_APP_URL) return process.env.NEXT_PUBLIC_APP_URL.replace(/\/$/, '')
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`
  if (req) {
    const host = req.headers?.get?.('host')
    if (host) {
      const proto = req.headers.get('x-forwarded-proto') || (host.startsWith('localhost') || host.startsWith('127.') ? 'http' : 'https')
      return `${proto}://${host}`
    }
  }
  return null
}
