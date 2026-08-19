'use client'
import { useEffect } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { X, ExternalLink } from 'lucide-react'
import AccountDetail from '@/views/AccountDetail'

// Intercepted route: a same-origin <Link href="/accounts/[id]"> click from
// Dashboard/Accounts renders this overlay instead of navigating away — the
// URL still changes to /accounts/[id], so refresh or a direct link falls
// through to the real (non-intercepted) page at app/(app)/accounts/[id].
export default function AccountModal() {
  const router = useRouter()
  const { id } = useParams()

  const close = () => router.back()

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') close() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [])

  // "Open full page" needs a hard navigation — router.push would just hit
  // this same intercepted route again since we're already at that URL.
  const openFullPage = () => {
    if (typeof window !== 'undefined') window.location.assign(`/accounts/${id}`)
  }

  return (
    // "Put the workspace in the middle it's off centered" (reported from
    // /accounts, where every row opens this modal): `fixed inset-0` makes
    // this overlay span the *entire* browser window, but app/(app)/layout.jsx's
    // desktop sidebar (<aside className="... w-60 ...">) is a sticky sibling
    // inside the page's own flex layout, not a viewport-fixed element — it
    // never actually reserves space from this overlay. So the old single
    // `justify-center` centered the dialog on the *full* window width, which
    // sits visibly left of where the rest of the app (main's own `mx-auto`,
    // confined to the area right of the sidebar) reads as centered. Backdrop
    // stays full-bleed (dimming behind the sidebar too is correct); only the
    // inner wrapper that actually centers the dialog panel gets nudged right
    // by the sidebar's width at the same md breakpoint the sidebar itself
    // appears at — mobile/tablet (no sidebar) is unaffected.
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-[2px] fade-in" onClick={close} />
      <div className="relative flex h-full items-end justify-center sm:items-center md:pl-60">
        <div
          className="relative z-10 flex max-h-[92vh] w-full flex-col overflow-y-auto rounded-t-3xl border-t bg-card p-5 pb-8 shadow-2xl fade-in sm:max-h-[85vh] sm:w-full sm:max-w-lg sm:rounded-2xl sm:border sm:p-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="mx-auto mb-3 h-1.5 w-10 shrink-0 rounded-full bg-secondary sm:hidden" />
          <div className="mb-2 flex items-center justify-between">
            <button onClick={openFullPage} className="flex items-center gap-1 text-[0.75rem] font-semibold text-muted-foreground transition hover:text-foreground" title="Open full page">
              Open full page <ExternalLink className="h-3.5 w-3.5" />
            </button>
            <button onClick={close} className="text-muted-foreground transition hover:text-foreground" title="Close">
              <X className="h-4 w-4" />
            </button>
          </div>
          <AccountDetail id={id} />
        </div>
      </div>
    </div>
  )
}
