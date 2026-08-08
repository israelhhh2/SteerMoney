'use client'
import { useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { Landmark, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/toast'
import { exchangeAndSync, PLAID_LINK_TOKEN_KEY } from '@/lib/plaid-client'

// Reusable "Connect a bank" button: fetches a Plaid Link token, opens Plaid
// Link, exchanges the resulting public token, and kicks off a sync. Used by
// Settings (Connected banks) and Accounts (top bar + empty state).
//
// The link_token is persisted to sessionStorage as soon as Link opens
// (roadmap item 3, OAuth support): some banks (Chase, BofA, ...) force Link
// out to their own login page and back via a redirect to /plaid-oauth, which
// needs that same link_token to resume the session — see
// app/(app)/plaid-oauth/page.jsx.
export function ConnectBankButton({ onDone, variant = 'default', size, children }) {
  const toast = useToast()
  const [linkToken, setLinkToken] = useState(null)
  const [connecting, setConnecting] = useState(false)

  const handleSuccess = async (public_token, metadata) => {
    try {
      await exchangeAndSync(public_token, metadata?.institution?.name, toast)
      if (onDone) onDone()
      else setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token, metadata) => {
      handleSuccess(public_token, metadata)
      setLinkToken(null)
      try { sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY) } catch { /* sessionStorage unavailable, harmless */ }
    },
    onExit: () => {
      setLinkToken(null)
      try { sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY) } catch { /* sessionStorage unavailable, harmless */ }
    },
  })

  useEffect(() => {
    if (linkToken && ready) {
      try { sessionStorage.setItem(PLAID_LINK_TOKEN_KEY, linkToken) } catch { /* sessionStorage unavailable, harmless */ }
      open()
    }
  }, [linkToken, ready, open])

  const connect = async () => {
    setConnecting(true)
    try {
      const res = await fetch('/api/plaid/link-token', { method: 'POST' })
      const data = await res.json()
      if (res.status === 503) {
        toast(data.error || 'Bank connections are not set up yet. Add the Plaid keys to the server to turn this on.', 'error')
      } else if (!res.ok) {
        throw new Error(data.error || "Couldn't start a bank connection")
      } else {
        setLinkToken(data.link_token)
      }
    } catch (e) {
      toast(e.message, 'error')
    }
    setConnecting(false)
  }

  return (
    <Button variant={variant} size={size} disabled={connecting} onClick={connect}>
      {connecting ? <Loader2 className="animate-spin" /> : <Landmark />}
      {children || 'Connect a bank'}
    </Button>
  )
}
