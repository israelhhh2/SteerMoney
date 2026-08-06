'use client'
import { useParams, useRouter } from 'next/navigation'
import { ArrowLeft } from 'lucide-react'
import AccountDetail from '@/views/AccountDetail'

// Standalone full page for /accounts/[id] — renders on refresh or a direct
// link (no history to intercept). Notion-style in-app clicks instead open
// this same URL inside app/(app)/@modal/(.)accounts/[id]/page.jsx.
export default function Page() {
  const router = useRouter()
  const { id } = useParams()

  const back = () => {
    if (typeof window !== 'undefined' && window.history.length > 1) router.back()
    else router.push('/accounts')
  }

  return (
    <div className="fade-in space-y-5">
      <button onClick={back} className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-muted-foreground transition hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" /> Back
      </button>
      <AccountDetail id={id} />
    </div>
  )
}
