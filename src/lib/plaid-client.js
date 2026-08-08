'use client'
// Shared client-side Plaid Link flow. `components/connect-bank.jsx` (normal
// "Connect a bank" button) and `app/(app)/plaid-oauth/page.jsx` (the redirect
// landing page some banks force Plaid Link through — Chase, BofA, etc.) both
// need to run the exact same onSuccess sequence: exchange the public_token
// for an access_token server-side, then trigger a sync. Kept here so the two
// never drift.

// sessionStorage key connect-bank.jsx / plaid-oauth page use to persist the
// in-flight link_token across the OAuth redirect round-trip (the tab
// navigates away to the bank's login page and back, so React state alone
// doesn't survive).
export const PLAID_LINK_TOKEN_KEY = 'plaid_link_token'

export async function exchangeAndSync(public_token, institution, toast) {
  const res = await fetch('/api/plaid/exchange', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ public_token, institution }),
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error || "Couldn't link that bank")
  toast(`${institution || 'Bank'} connected`)

  try {
    const syncRes = await fetch('/api/plaid/sync', { method: 'POST' })
    const syncData = await syncRes.json()
    if (!syncRes.ok) throw new Error(syncData.error || 'Sync failed')
    toast(`Synced: ${syncData.added} new transactions`)
  } catch (e) {
    toast(e.message, 'error')
  }
}
