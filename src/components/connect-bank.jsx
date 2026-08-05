'use client'
import { useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { Landmark, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/toast'

// Reusable "Connect a bank" button: fetches a Plaid Link token, opens Plaid
// Link, exchanges the resulting public token, and kicks off a sync. Used by
// Settings (Connected banks) and Accounts (top bar + empty state).
export function ConnectBankButton({ onDone, variant = 'default', size, children }) {
  const toast = useToast()
  const [linkToken, setLinkToken] = useState(null)
  const [connecting, setConnecting] = useState(false)

  const exchangeToken = async (public_token, institution) => {
    try {
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

      if (onDone) onDone()
      else setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const { open, ready } = usePlaidLink({
    token: linkToken,
    onSuccess: (public_token, metadata) => {
      exchangeToken(public_token, metadata?.institution?.name)
      setLinkToken(null)
    },
    onExit: () => setLinkToken(null),
  })

  useEffect(() => { if (linkToken && ready) open() }, [linkToken, ready, open])

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
