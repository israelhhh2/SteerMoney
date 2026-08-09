'use client'
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { createSupabaseBrowserClient } from '@/lib/supabase-clients'

// Supabase Auth context — deliberately shaped to MIMIC the subset of
// @clerk/nextjs's client API this app already uses (useSession/useUser),
// so swapping call sites is close to a rename rather than a rewrite:
//
//   Clerk                                  ->  Supabase (this file)
//   ---------------------------------------------------------------------
//   const { session } = useSession()       ->  const { session } = useAuthSession()
//   const { user, isLoaded } = useUser()   ->  const { user, isLoaded, isSignedIn } = useAuthUser()
//   user.id                                ->  user.id                 (Supabase uuid)
//   user.firstName                         ->  user.firstName          (user_metadata.first_name, else email prefix)
//   user.fullName                          ->  user.fullName
//   user.imageUrl                          ->  user.imageUrl           (user_metadata.avatar_url)
//   user.unsafeMetadata                    ->  user.unsafeMetadata     (alias of user_metadata)
//   user.primaryEmailAddress.emailAddress  ->  user.email              (NOTE: shape differs — no .primaryEmailAddress)
//   await user.update({ unsafeMetadata })  ->  await user.update({ unsafeMetadata })  (same call shape)
//   useClerk().signOut()                   ->  signOut()               (from useAuthUser() or useAuthSession())
//
// TODO for the sweep: every `user.primaryEmailAddress?.emailAddress` call
// site needs to become `user.email` — that's the one field Clerk's User
// shape has no direct equivalent name for here.
const Ctx = createContext(null)

function metadataFromSupabaseUser(u) {
  if (!u) return null
  const meta = u.user_metadata || {}
  const email = u.email || ''
  const firstName = meta.first_name || (email ? email.split('@')[0] : '') || ''
  const lastName = meta.last_name || ''
  const fullName = meta.full_name || [firstName, lastName].filter(Boolean).join(' ') || null
  return {
    id: u.id,
    email,
    firstName,
    lastName,
    fullName,
    imageUrl: meta.avatar_url || null,
    unsafeMetadata: meta,
  }
}

export function AuthProvider({ children }) {
  const supabase = useMemo(() => createSupabaseBrowserClient(), [])
  const [session, setSession] = useState(undefined) // undefined = not checked yet, null = signed out
  const [supaUser, setSupaUser] = useState(undefined)

  useEffect(() => {
    let on = true
    supabase.auth.getSession().then(({ data }) => {
      if (!on) return
      setSession(data.session || null)
      setSupaUser(data.session?.user || null)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession || null)
      setSupaUser(newSession?.user || null)
    })
    return () => { on = false; sub.subscription.unsubscribe() }
  }, [supabase])

  const isLoaded = session !== undefined
  const isSignedIn = isLoaded ? !!session : undefined

  const user = useMemo(() => {
    const base = metadataFromSupabaseUser(supaUser)
    if (!base) return supaUser === undefined ? undefined : null
    return {
      ...base,
      // update({ unsafeMetadata }) mirrors Clerk's user.update() call shape —
      // merges into user_metadata (Supabase has no separate "unsafe" bucket).
      update: async ({ unsafeMetadata, firstName, lastName, ...rest } = {}) => {
        const data = {
          ...(unsafeMetadata !== undefined ? unsafeMetadata : {}),
          ...(firstName !== undefined ? { first_name: firstName } : {}),
          ...(lastName !== undefined ? { last_name: lastName } : {}),
        }
        const { data: res, error } = await supabase.auth.updateUser({ data, ...rest })
        if (error) throw error
        return res
      },
    }
  }, [supaUser, supabase])

  const signOut = async () => {
    await supabase.auth.signOut()
  }

  const value = useMemo(() => ({
    supabase,
    session,
    user,
    isLoaded,
    isSignedIn,
    signOut,
  }), [supabase, session, user, isLoaded, isSignedIn])

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

function useAuthCtx() {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useAuthUser/useAuthSession must be used within <AuthProvider>')
  return ctx
}

// Mirrors Clerk's useUser(): { user, isLoaded, isSignedIn }.
// `user` is `undefined` before the initial session check resolves, `null`
// when signed out, otherwise the shaped object described above.
export function useAuthUser() {
  const { user, isLoaded, isSignedIn } = useAuthCtx()
  return { user, isLoaded, isSignedIn }
}

// Mirrors Clerk's useSession(): { session }. `session` is the raw Supabase
// session (has .access_token, .user, etc.) — undefined until loaded, null
// when signed out.
export function useAuthSession() {
  const { session } = useAuthCtx()
  return { session }
}

// Mirrors Clerk's useClerk().signOut().
export function useSignOut() {
  const { signOut } = useAuthCtx()
  return signOut
}

// Escape hatch for call sites that want the raw browser Supabase client
// directly (same singleton lib/supabase-clients.js hands out) without
// threading it through store.jsx.
export function useSupabaseClient() {
  const { supabase } = useAuthCtx()
  return supabase
}
