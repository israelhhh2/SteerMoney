// Supabase Auth client helpers (@supabase/ssr) — replaces the Clerk-bridged
// client in lib/supabase.js. Two entry points:
//
//   - createSupabaseBrowserClient(): 'use client' components. Session lives
//     in cookies (readable/writable by the browser), kept fresh automatically.
//   - createSupabaseServerClient(): route handlers / server components. Reads
//     the incoming request's cookies via next/headers to authenticate as the
//     signed-in user (RLS-scoped — NOT the service-role client; see
//     lib/plaid-server.js's supabaseAdmin for the RLS-bypassing one).
//
// Both use the same publishable/anon key; @supabase/ssr's cookie-backed
// storage is what makes the session available identically on client and
// server, which the old Clerk-token bridge could never do server-side.
import { createBrowserClient, createServerClient } from '@supabase/ssr'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
// either env name works: ANON_KEY (legacy) or PUBLISHABLE_KEY (Supabase's new naming)
const SUPABASE_ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY

// Singleton on the client: avoids re-creating (and re-subscribing) a new
// GoTrue client on every render/import. Server client is intentionally NOT
// singleton — it's bound to a single request's cookies.
let browserClient = null

export function createSupabaseBrowserClient() {
  if (browserClient) return browserClient
  browserClient = createBrowserClient(SUPABASE_URL, SUPABASE_ANON_KEY)
  return browserClient
}

// Route handlers only (app/api/**/route.js) and server components. `cookies()`
// is async in Next 15/16, so this helper is async too — call sites must
// `await createSupabaseServerClient()`.
export async function createSupabaseServerClient() {
  const { cookies } = await import('next/headers')
  const cookieStore = await cookies()
  return createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    cookies: {
      getAll() {
        return cookieStore.getAll()
      },
      setAll(cookiesToSet) {
        try {
          cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
        } catch {
          // setAll called from a Server Component (not a route handler/action) —
          // cookies() is read-only there. Harmless as long as middleware.js is
          // refreshing the session cookie on every request (it is).
        }
      },
    },
  })
}
