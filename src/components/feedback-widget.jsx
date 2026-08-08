'use client'
import { useEffect, useState } from 'react'
import { usePathname } from 'next/navigation'
import { useUser } from '@clerk/nextjs'
import { MessageCircle, X, Loader2, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Segmented } from '@/components/ui/segmented'
import { useCenterToast } from '@/components/toast'

// Floating "send feedback / report a bug" widget, mounted once in
// app/(app)/layout.jsx so it's on every authed page. Deliberately sits below
// the dialog z-index ladder documented in CLAUDE.md (@modal z-[60], ui/dialog
// Overlay z-[65]/Content z-[70], centerToast z-[80]) — this widget's button
// and panel are both z-[55], so any real dialog/modal always paints over it,
// and this session's own success centerToast (fired on send) still shows on
// top of the now-closed panel.
const TYPES = [['feedback', 'Feedback'], ['bug', 'Bug']]

export function FeedbackWidget() {
  const pathname = usePathname()
  const { user } = useUser()
  const centerToast = useCenterToast()
  const email = user?.primaryEmailAddress?.emailAddress || null

  const [open, setOpen] = useState(false)
  const [type, setType] = useState('feedback')
  const [message, setMessage] = useState('')
  const [wantsReply, setWantsReply] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, sending])

  function close() {
    if (sending) return
    setOpen(false)
    setError('')
  }

  async function send() {
    const trimmed = message.trim()
    if (!trimmed || sending) return
    setSending(true)
    setError('')
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type,
          message: trimmed,
          page: pathname,
          userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
          wantsReply,
        }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error || "Couldn't send that — try again")
      setMessage('')
      setOpen(false)
      centerToast('Thanks — we read every one!')
    } catch (e) {
      setError(e?.message || "Couldn't send that — try again")
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? 'Close feedback' : 'Send feedback or report a bug'}
        className={cn(
          'fixed right-4 z-[55] h-12 w-12 items-center justify-center rounded-full border border-border/60 bg-primary text-primary-foreground shadow-lg transition hover:opacity-90',
          'bottom-[calc(4.75rem+env(safe-area-inset-bottom))] md:bottom-6',
          open ? 'hidden md:flex' : 'flex'
        )}
      >
        {open ? <X className="h-5 w-5" /> : <MessageCircle className="h-5 w-5" />}
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-[54] md:hidden" onClick={close} />
          <div
            role="dialog"
            aria-label="Send feedback or report a bug"
            className={cn(
              'fixed z-[55] border-border/60 bg-card shadow-2xl',
              'inset-x-0 bottom-0 rounded-t-2xl border-t p-4',
              'md:inset-x-auto md:bottom-24 md:right-4 md:w-80 md:rounded-2xl md:border'
            )}
            style={{ paddingBottom: 'calc(1rem + env(safe-area-inset-bottom))' }}
          >
            <div className="mb-3 flex items-center justify-between">
              <h3 className="text-[0.9375rem] font-extrabold tracking-tight">Send us feedback</h3>
              <button type="button" onClick={close} className="text-muted-foreground hover:text-foreground md:hidden">
                <X className="h-4 w-4" />
              </button>
            </div>

            <Segmented options={TYPES} value={type} onChange={setType} className="mb-3" />

            <textarea
              autoFocus
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={
                type === 'bug'
                  ? "What happened? The more detail, the faster we can fix it."
                  : "What's on your mind? We read every note."
              }
              className="w-full resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring [color-scheme:dark]"
            />
            <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">
              No need for a screenshot — just describe it in your own words.
            </p>

            {email ? (
              <label className="mt-2.5 flex items-start gap-2 text-[0.75rem] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={wantsReply}
                  onChange={(e) => setWantsReply(e.target.checked)}
                  className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-primary"
                />
                <span className="flex min-w-0 items-start gap-1">
                  <Mail className="mt-0.5 h-3 w-3 shrink-0" />
                  Email me back at <span className="font-semibold text-foreground">{email}</span> if needed
                </span>
              </label>
            ) : null}

            {error ? <p className="mt-2 text-[0.75rem] font-semibold text-red-400">{error}</p> : null}

            <Button className="mt-3 w-full" disabled={!message.trim() || sending} onClick={send}>
              {sending ? <Loader2 className="animate-spin" /> : null}
              {sending ? 'Sending…' : 'Send'}
            </Button>
          </div>
        </>
      ) : null}
    </>
  )
}
