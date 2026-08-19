'use client'
import { useEffect, useState } from 'react'
import { usePlaidLink } from 'react-plaid-link'
import { Landmark, Loader2, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useToast } from '@/components/toast'
import { exchangeAndSync, PLAID_LINK_TOKEN_KEY } from '@/lib/plaid-client'
import { useApp } from '@/store'
import { usePlaidItems } from '@/lib/accounts'
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

// Shown right after a successful link when the exchange route (see
// app/api/plaid/exchange/route.js) flags the just-added item as a FULL
// duplicate of one already connected — same institution+mask+type match as
// lib/accounts.js's findDuplicateItems() (which covers duplicates that
// predate this check, surfaced from Accounts.jsx's banner instead). Reused
// as-is from both call sites (this component and app/(app)/plaid-oauth/
// page.jsx, and Accounts.jsx's cleanup banner) so the copy and behavior
// never drift between them.
//
// Removal always targets `itemId` — the caller is responsible for that
// always being the newer/just-added connection, never the original the user
// already relies on — and reuses the exact same DELETE /api/plaid/items
// call Settings' "Remove" button uses, including its cleanup of any
// Debt Tracker rows tied to that item (see that route). The "transactions
// stay" reassurance mirrors Settings' own RemoveBankDialog copy verbatim
// (views/Settings.jsx) since disconnecting behaves identically either way.
export function DuplicateBankDialog({ institution, itemId, onRemoved, onClose }) {
  const t = useT()
  const toast = useToast()
  const [busy, setBusy] = useState(false)

  const remove = async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/plaid/items', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: itemId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Couldn't remove that connection")
      toast(t('Duplicate connection removed'))
      await onRemoved()
    } catch (e) {
      toast(e.message, 'error')
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('Remove the duplicate connection?')}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t('It looks like {institution} is already connected — these accounts are the same. Remove the duplicate connection?', { institution: institution || t('this bank') })}
        </p>
        <p className="text-xs text-muted-foreground">
          {t('SteerMoney stops pulling new transactions from this bank. Transactions already imported stay in your account.')}
        </p>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('Keep both')}</Button>
          <Button variant="destructive" disabled={busy} onClick={remove}>
            {busy ? <Loader2 className="animate-spin" /> : null}{t('Remove duplicate')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
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
  // Pending duplicate-connection confirm (see DuplicateBankDialog above) —
  // holds the just-linked item off from finishing (onDone/reload) until the
  // user picks "Remove duplicate" or "Keep both".
  const [duplicate, setDuplicate] = useState(null)

  const stop = () => {
    setLinkToken(null)
    try { sessionStorage.removeItem(PLAID_LINK_TOKEN_KEY) } catch { /* sessionStorage unavailable, harmless */ }
  }

  const finish = () => {
    if (onDone) onDone()
    else setTimeout(() => window.location.reload(), 1200)
  }

  const handleSuccess = async (public_token, metadata) => {
    stop()
    try {
      const data = await exchangeAndSync(public_token, metadata?.institution?.name, toast)
      if (data?.duplicate) {
        setDuplicate({ item_id: data.item_id, institution: data.duplicateOf?.institution || metadata?.institution?.name })
        return // finish() runs once the dialog below resolves, either way
      }
      finish()
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
      {duplicate && (
        <DuplicateBankDialog
          institution={duplicate.institution}
          itemId={duplicate.item_id}
          onRemoved={() => { setDuplicate(null); finish() }}
          onClose={() => { setDuplicate(null); finish() }}
        />
      )}
    </>
  )
}

// "Sync all" — pulls the latest transactions/balances for every connected
// bank at once, so a user doesn't have to go into Settings > Connected
// banks and click "Sync now" per row. Same POST /api/plaid/sync request and
// toast handling as that per-row button (views/Settings.jsx) — just fired
// once for every item instead of scoped to one — so the success/error
// messaging matches exactly what's already shown there. Rendered in the
// Accounts page toolbar and the app header (app/(app)/layout.jsx); hides
// itself with nothing connected yet (nothing to sync). `iconOnly` swaps in a
// plain icon button matching the header's existing RemindersBell/CloudOff
// style, for the header's tighter space — title-attributed either way.
export function SyncAllButton({ variant = 'outline', size = 'sm', iconOnly = false, className }) {
  const t = useT()
  const toast = useToast()
  const { refetch } = useApp()
  const { plaidItems, refetchPlaidItems } = usePlaidItems()
  const [syncing, setSyncing] = useState(false)

  if (!plaidItems.length) return null

  const syncAll = async () => {
    if (syncing) return // disabled state already blocks this, but a second guard costs nothing against a double-fire
    setSyncing(true)
    try {
      const res = await fetch('/api/plaid/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Sync failed')
      // itemErrors: some connections synced fine, one or more others hit an
      // error (reauth needed, Plaid outage, etc.) — same per-item isolation
      // Settings' "Sync now" surfaces (see lib/plaid-sync.js).
      if (data.itemErrors?.length) {
        toast(t('Synced {n} new transactions, but {count} connection{plural} failed ({banks}) — try Fix connection below', {
          n: data.added, count: data.itemErrors.length, plural: data.itemErrors.length > 1 ? 's' : '',
          banks: data.itemErrors.map((e) => e.institution || t('a bank')).join(', '),
        }), 'error')
      } else {
        toast(t('Synced: {n} new transactions', { n: data.added }))
      }
      // No page reload — refresh the shared usePlaidItems() consumers
      // (header/Accounts/AccountDetail/Settings) and the store's own
      // debts/transactions/etc., same as Settings' "Sync now".
      await refetchPlaidItems()
      refetch()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setSyncing(false)
    }
  }

  if (iconOnly) {
    return (
      <button
        type="button"
        onClick={syncAll}
        disabled={syncing}
        title={t('Sync all')}
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground disabled:opacity-50"
      >
        {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
      </button>
    )
  }

  return (
    <Button variant={variant} size={size} className={className} disabled={syncing} onClick={syncAll}>
      {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}
      {t('Sync all')}
    </Button>
  )
}
