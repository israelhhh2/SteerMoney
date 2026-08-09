import { createServerClient } from '@supabase/ssr'
import { NextResponse } from 'next/server'

// @supabase/ssr cookie-refresh + route-protection middleware — replaces
// clerkMiddleware. Semantics are copied 1:1 from the previous Clerk
// middleware (git history): same public routes, same two redirects.
//
// /api/plaid/webhook is called server-to-server by Plaid (no browser session
// exists on those requests) — it's verified separately via Plaid's JWT
// signature inside the route itself (see app/api/plaid/webhook/route.js).
//
// /auth/callback (new in this migration) must also be public: it's the
// OAuth redirect target (see app/auth/callback/route.js) and runs before a
// session cookie exists yet.
const PUBLIC_PATTERNS = [
  /^\/home$/,
  /^\/privacy$/,
  /^\/sign-in(\/.*)?$/,
  /^\/sign-up(\/.*)?$/,
  /^\/auth\/callback$/,
  /^\/api\/plaid\/webhook$/,
]

function isPublicRoute(pathname) {
  return PUBLIC_PATTERNS.some((re) => re.test(pathname))
}

export default async function middleware(req) {
  let response = NextResponse.next({ request: req })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => req.cookies.set(name, value))
          response = NextResponse.next({ request: req })
          cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options))
        },
      },
    }
  )

  // getUser() (not getSession()) — revalidates the JWT against Supabase Auth
  // on every request rather than trusting an unverified cookie value.
  const { data: { user } } = await supabase.auth.getUser()
  const pathname = req.nextUrl.pathname

  // signed-in visitors skip the landing page
  if (user && pathname === '/home') {
    return NextResponse.redirect(new URL('/', req.url))
  }
  if (isPublicRoute(pathname)) return response

  // signed-out visitors hitting the app root land on the marketing page
  if (!user && pathname === '/') {
    return NextResponse.redirect(new URL('/home', req.url))
  }
  if (!user) {
    const redirectUrl = new URL('/sign-in', req.url)
    redirectUrl.searchParams.set('redirect_url', pathname + req.nextUrl.search)
    return NextResponse.redirect(redirectUrl)
  }

  return response
}

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
