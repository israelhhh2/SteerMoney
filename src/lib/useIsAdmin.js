'use client'
import { useEffect, useState } from 'react'
import { useAuthUser } from '@/components/auth-provider'
import { createAuthedSupabaseClient } from './supabase'

// True when the signed-in user has a row in public.admins (see supabase/admin.sql).
// Defaults to false and RESETS on every session change — admin status must be
// re-proven per session, never carried over from a previous account.
export function useIsAdmin() {
  const { user } = useAuthUser()
  const [isAdmin, setIsAdmin] = useState(false)
  useEffect(() => {
    setIsAdmin(false)
    if (!user) return
    let on = true
    createAuthedSupabaseClient()
      .from('admins').select('user_id').eq('user_id', user.id).maybeSingle()
      .then(({ data, error }) => { if (on) setIsAdmin(!error && !!data) })
      .catch(() => { if (on) setIsAdmin(false) })
    return () => { on = false }
  }, [user?.id])
  return isAdmin
}
