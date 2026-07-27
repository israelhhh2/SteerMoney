'use client'
import { createClient } from '@supabase/supabase-js'

// Supabase client that authenticates with the Clerk session token.
// Requires the Clerk <-> Supabase native integration:
//   1. Clerk Dashboard -> Integrations -> Supabase -> activate (copy the Clerk domain)
//   2. Supabase Dashboard -> Authentication -> Sign In / Providers -> Third Party Auth -> add Clerk
export function createClerkSupabaseClient(session) {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    // either env name works: ANON_KEY (legacy) or PUBLISHABLE_KEY (Supabase's new naming)
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    { accessToken: async () => (session ? await session.getToken() : null) }
  )
}
