'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { usePlaidLink } from 'react-plaid-link'
import { Loader2, Landmark } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/toast'
import { exchangeAndSync, PLAID_LINK_TOKEN_KEY } from '@/lib/plaid-client'

// Landing point for Plaid's OAuth redirect (roadmap item 3). Some banks
// (Chase, Bank of America, ...) force Plaid Link out to their own login page
// instead of handling auth inline; Plaid then redirects the browser back to
// this exact URL (`redirect_uri` in linkTokenCreate — see
// app/api/plaid/link-token/route.js) with query params Link needs to resume
// the same session.
//
// MANUAL STEP: this path — `${APP_URL}/plaid-oauth` — must be registered in
// Plaid Dashboard → Team Settings → API → Allowed redirect URIs, or OAuth
// banks will fail to complete. See CLAUDE.md.
//
// React state doesn't survive the trip out to the bank and back, so the
// link_token that started this Link session is read from sessionStorage
// (written by connect-bank.jsx / this page right before Link opens).
export default function PlaidOAuthPage() {
  const router = useRouter()
  const toast = useToast()
  const [linkToken, setLinkToken] = useState(undefined) // undefined = checking sessionStorage, null = none found
  const [status, setStatus] = useState('connecting') // connecting | error

  useEffect(() => {
    try {
      setLinkToken(sessionStorage.getItem(PLAID_LINK_TOKEN_KEY) || null)
    } catch {
      setLinkToken(null)
    }
  }, [])

  const { open, ready } = usePlaidLink({
    token: linkToken || null,
    receivedRedirectUri: typeof window !== 'undefined' ? window.location.href : undefined,
    onSuccess: async (public_token, metadata) => {
      try { sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY) } catch { /* harmless */ }
      try {
        await exchangeAndSync(public_token, metadata?.institution?.name, toast)
        router.push('/accounts')
      } catch (e) {
        toast(e.message, 'error')
        setStatus('error')
      }
    },
    onExit: (err) => {
      try { sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY) } catch { /* harmless */ }
      if (err) toast(err.display_message || err.error_message || 'Bank connection was not completed', 'error')
      setStatus('error')
    },
  })

  useEffect(() => { if (linkToken && ready) open() }, [linkToken, ready, open])

  if (linkToken === undefined) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-sm text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin" />
        Finishing up…
      </div>
    )
  }

  if (linkToken === null) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-sm text-muted-foreground">
        <Landmark className="h-6 w-6" />
        <p className="max-w-xs">
          Couldn't find your bank connection session. Head back to Accounts and try connecting again.
        </p>
        <Button onClick={() => router.push('/accounts')}>Back to Accounts</Button>
      </div>
    )
  }

  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-center text-sm text-muted-foreground">
      <Loader2 className="h-5 w-5 animate-spin" />
      {status === 'error' ? (
        <>
          <p>That didn't complete. You can head back and try again.</p>
          <Button onClick={() => router.push('/accounts')}>Back to Accounts</Button>
        </>
      ) : (
        <p>Finishing up your bank connection…</p>
      )}
    </div>
  )
}
