'use client'
import { useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { Landmark, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/toast'
import { exchangeAndSync, PLAID_LINK_TOKEN_KEY } from '@/lib/plaid-client'
import { useT } from '@/lib/i18n'

// The ONE place react-plaid-link's `usePlaidLink` hook gets called anywhere
// in this app. react-plaid-link creates a hidden, fullscreen "initial"
// iframe (`#plaid-link-iframe-N`, position:fixed, z-index 2147483647) the
// instant `usePlaidLink` runs — even with `token: null` — and that iframe
// sits on top of everything, capturing clicks, until it's told to open a
// real session. With several call sites (Connect-a-bank button(s), the
// per-row "Fix connection" button, the OAuth landing page) each holding
// their own `usePlaidLink`, every one of them (idle or not) stacks another
// fullscreen click-eating iframe on the page — that's the "Link modal opens
// but every click does nothing" bug.
//
// The fix: nobody calls `usePlaidLink` directly. Everybody renders this
// component, and ONLY while `token` is truthy (parent holds the token in
// state and renders `<PlaidLinkRunner .../>` conditionally). The instant the
// flow ends (success or exit), the parent sets its token back to null, this
// component unmounts, and react-plaid-link tears its iframe down with it —
// so at most one hidden/open iframe can ever exist on the page at a time,
// and only while a flow is actually in progress.
//
// Also persists the link_token to sessionStorage the moment Link is ready
// to open (roadmap item 3, OAuth support): some banks (Chase, BofA, ...)
// force Link out to their own login page and back via a redirect to
// /plaid-oauth, which needs that same link_token to resume the session.
export function PlaidLinkRunner({ token, receivedRedirectUri, onSuccess, onExit }) {
  const { open, ready } = usePlaidLink({ token, receivedRedirectUri, onSuccess, onExit })

  useEffect(() => {
    if (ready) {
      try { sessionStorage.setItem(PLAID_LINK_TOKEN_KEY, token) } catch { /* sessionStorage unavailable, harmless */ }
      open()
    }
  }, [ready, open, token])

  return null
}

// Reusable "Connect a bank" button: fetches a Plaid Link token, mounts a
// <PlaidLinkRunner> only while that token exists, exchanges the resulting
// public token, and kicks off a sync. Safe to render as many times as a
// page wants (Accounts' top bar + empty state, Settings' Connected Banks) —
// an idle button (no link_token yet) renders no PlaidLinkRunner at all, so
// it mounts zero iframes.
export function ConnectBankButton({ onDone, variant = 'default', size, children }) {
  const t = useT()
  const toast = useToast()
  const [linkToken, setLinkToken] = useState(null)
  const [connecting, setConnecting] = useState(false)

  const stop = () => {
    setLinkToken(null)
    try { sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY) } catch { /* sessionStorage unavailable, harmless */ }
  }

  const handleSuccess = async (public_token, metadata) => {
    stop()
    try {
      await exchangeAndSync(public_token, metadata?.institution?.name, toast)
      if (onDone) onDone()
      else setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const handleExit = (err) => {
    stop()
    if (err) toast(err.display_message || err.error_message || t('Bank connection failed'), 'error')
  }

  const connect = async () => {
    setConnecting(true)
    try {
      const res = await fetch('/api/plaid/link-token', { method: 'POST' })
      const data = await res.json()
      if (res.status === 503) {
        toast(data.error || t('Bank connections are not set up yet. Add the Plaid keys to the server to turn this on.'), 'error')
      } else if (!res.ok) {
        throw new Error(data.error || t("Couldn't start a bank connection"))
      } else {
        setLinkToken(data.link_token)
      }
    } catch (e) {
      toast(e.message, 'error')
    }
    setConnecting(false)
  }

  return (
    <>
      <Button variant={variant} size={size} disabled={connecting} onClick={connect}>
        {connecting ? <Loader2 className="animate-spin" /> : <Landmark />}
        {children || t('Connect a bank')}
      </Button>
      {linkToken && <PlaidLinkRunner token={linkToken} onSuccess={handleSuccess} onExit={handleExit} />}
    </>
  )
}
