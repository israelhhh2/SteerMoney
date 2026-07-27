'use client'
import { useEffect, useState } from 'react'
import { useSession } from '@clerk/nextjs'
import { createClerkSupabaseClient } from './supabase'

// True when the signed-in user has a row in public.admins (see supabase/admin.sql).
// Defaults to false and RESETS on every session change — admin status must be
// re-proven per session, never carried over from a previous account.
export function useIsAdmin() {
  const { session } = useSession()
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    setIsAdmin(false)
    if (!session) return
    let on = true
    createClerkSupabaseClient(session)
      .from('admins').select('user_id').eq('user_id', session.user.id).maybeSingle()
      .then(({ data, error }) => { if (on) setIsAdmin(!error && !!data) })
      .catch(() => { if (on) setIsAdmin(false) })
    return () => { on = false }
  }, [session?.id])
  return isAdmin
}
