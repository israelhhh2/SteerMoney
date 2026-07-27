'use client'
import { useEffect, useRef, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { Loader2, Users } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { useApp } from '@/store'

export default function JoinPage() {
  const { token } = useParams()
  const { joinSpace } = useApp()
  const router = useRouter()
  const [err, setErr] = useState(null)
  const ran = useRef(false)

  useEffect(() => {
    if (ran.current || !token) return
    ran.current = true
    joinSpace(String(token)).then((r) => {
      if (r.ok) router.replace('/')
      else setErr(r.error)
    })
  }, [token])

  if (err) {
    return (
      <Card className="mx-auto max-w-md p-8 text-center">
        <Users className="mx-auto mb-3 h-6 w-6 text-muted-foreground" />
        <p className="text-sm font-semibold">This invite didn&apos;t work</p>
        <p className="mt-1 text-xs text-muted-foreground">{err}</p>
        <p className="mt-1 text-xs text-muted-foreground">Ask for a fresh link. Invites expire after 7 days.</p>
        <Button className="mt-4" onClick={() => router.replace('/')}>Go to my dashboard</Button>
      </Card>
    )
  }
  return (
    <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" /> Joining the shared space…
    </div>
  )
}
