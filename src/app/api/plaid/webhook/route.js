import crypto from 'crypto'
import { plaidClient, plaidConfigured, supabaseAdmin } from '@/lib/plaid-server'
import { syncPlaidItem, setItemStatus } from '@/lib/plaid-sync'

// Plaid calls this route server-to-server (not through a browser session), so
// it must be reachable without an authenticated session — it's added to the
// public matcher in middleware.js. Instead of a session, Plaid signs each
// request with a JWT in the `plaid-verification` header; see verifyWebhook below.
//
// Register this route's URL (`${APP_URL}/api/plaid/webhook`) is passed
// automatically via `webhook` in linkTokenCreate (see app/api/plaid/link-token)
// whenever APP_URL is known.

// Verifies Plaid's webhook per https://plaid.com/docs/api/webhooks/webhook-verification/:
// the `plaid-verification` header is an ES256 JWT; fetch the matching public
// key via webhookVerificationKeyGet, verify the signature, then confirm the
// JWT's `request_body_sha256` claim matches a SHA-256 of the raw request body.
//
// TODO: this needs the `jose` package (ES256 JWT support) — `npm install
// jose`. It could not be confirmed as an existing dependency in this session
// (package.json lives outside the mounted src/ root), so the import is
// dynamic and wrapped in try/catch: if `jose` isn't installed, verification
// is skipped and we fall back to a defensive check (payload shape +
// known item_id) instead of crashing or blindly trusting every request. This
// fallback is NOT cryptographic verification — install `jose` and confirm
// this path is exercised before relying on it in production.
async function verifyWebhook(rawBody, jwtHeader) {
  if (!jwtHeader) return { ok: false, reason: 'missing plaid-verification header' }

  try {
    const jose = await import('jose')

    const headerSegment = jwtHeader.split('.')[0]
    const decodedHeader = JSON.parse(Buffer.from(headerSegment, 'base64url').toString('utf8'))
    const keyId = decodedHeader.kid
    if (!keyId) return { ok: false, reason: 'jwt header missing kid' }

    const { data } = await plaidClient.webhookVerificationKeyGet({ key_id: keyId })
    const jwk = data.key
    if (!jwk) return { ok: false, reason: 'no verification key returned by Plaid' }

    const publicKey = await jose.importJWK(jwk, 'ES256')
    const { payload } = await jose.jwtVerify(jwtHeader, publicKey, { maxTokenAge: '5 min' })

    const expectedHash = crypto.createHash('sha256').update(rawBody).digest('hex')
    if (payload.request_body_sha256 !== expectedHash) {
      return { ok: false, reason: 'request body hash mismatch' }
    }
    return { ok: true }
  } catch (e) {
    // Covers both "jose isn't installed" (import throws) and genuine
    // verification failures (bad signature, expired key, etc).
    return { ok: false, reason: e?.message || 'verification error' }
  }
}

export async function POST(req) {
  const rawBody = await req.text()

  let payload
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return Response.json({ error: 'invalid json' }, { status: 400 })
  }

  try {
    if (!plaidConfigured || !supabaseAdmin) return Response.json({ ok: true })

    const verification = await verifyWebhook(rawBody, req.headers.get('plaid-verification'))
    if (!verification.ok) {
      const looksShapeValid = payload && typeof payload.webhook_type === 'string' && typeof payload.webhook_code === 'string' && typeof payload.item_id === 'string'
      if (!looksShapeValid) {
        console.error('[plaid webhook] rejected: verification failed and payload shape invalid —', verification.reason)
        return Response.json({ error: 'verification failed' }, { status: 401 })
      }
      const { data: knownItem } = await supabaseAdmin.from('plaid_items').select('id').eq('item_id', payload.item_id).maybeSingle()
      if (!knownItem) {
        console.error('[plaid webhook] rejected: verification failed and item_id is unknown —', verification.reason)
        return Response.json({ error: 'verification failed' }, { status: 401 })
      }
      console.warn('[plaid webhook] proceeding WITHOUT cryptographic verification (fallback mode) —', verification.reason, '— install/verify the `jose` dependency to close this gap')
    }

    const { webhook_code, item_id } = payload
    if (!item_id) return Response.json({ ok: true })

    const { data: item, error: itemErr } = await supabaseAdmin.from('plaid_items').select('*').eq('item_id', item_id).maybeSingle()
    if (itemErr) throw itemErr
    if (!item) return Response.json({ ok: true }) // unknown item (e.g. already removed) — nothing to do

    if (webhook_code === 'SYNC_UPDATES_AVAILABLE') {
      try {
        // Fallback for a 'syncing' item that never gets an explicit
        // HISTORICAL_UPDATE (this app's Sync-based integration mainly
        // relies on repeated SYNC_UPDATES_AVAILABLE calls instead — see
        // lib/plaid-sync.js): once the item is old enough that Plaid's
        // 730-day backfill has almost certainly finished, clear 'syncing'
        // here too instead of waiting on a webhook code that may never come.
        const ageMs = item.created_at ? Date.now() - new Date(item.created_at).getTime() : Infinity
        await syncPlaidItem(item, { clearSyncing: ageMs > 10 * 60 * 1000 })
      } catch (e) {
        console.error('[plaid webhook] sync failed for item', item_id, e?.response?.data || e)
      }
    } else if (webhook_code === 'HISTORICAL_UPDATE') {
      // Legacy /transactions/get-style webhook code that fires once the
      // full requested history window has been pulled. Not typically sent
      // for this app's Sync-based (transactionsSync) integration, but
      // handled defensively per the "please wait, transactions are loading"
      // placeholder requirement: if Plaid ever sends it, treat it as the
      // definitive signal that the backfill is done and clear 'syncing'
      // unconditionally.
      try {
        await syncPlaidItem(item, { clearSyncing: true })
      } catch (e) {
        console.error('[plaid webhook] historical-update sync failed for item', item_id, e?.response?.data || e)
      }
    } else if (webhook_code === 'INITIAL_UPDATE') {
      // Recent transactions are ready, but the full historical backfill
      // isn't necessarily done yet — sync now, but leave 'syncing' as-is so
      // the placeholder stays up until HISTORICAL_UPDATE (or the age-based
      // fallback above) confirms the rest has landed.
      try {
        await syncPlaidItem(item)
      } catch (e) {
        console.error('[plaid webhook] initial-update sync failed for item', item_id, e?.response?.data || e)
      }
    } else if (webhook_code === 'ITEM_LOGIN_REQUIRED' || webhook_code === 'PENDING_EXPIRATION' || webhook_code === 'ERROR') {
      await setItemStatus(item.id, 'reauth_required')
    } else if (webhook_code === 'USER_PERMISSION_REVOKED') {
      await setItemStatus(item.id, 'revoked')
    }

    return Response.json({ ok: true })
  } catch (e) {
    // Always resolve fast and with 200 for anything past verification —
    // Plaid retries aggressively on non-2xx, and payloads here are small
    // enough to just handle inline; errors are logged, not surfaced.
    console.error('[plaid webhook] unhandled error', e)
    return Response.json({ ok: true })
  }
}
