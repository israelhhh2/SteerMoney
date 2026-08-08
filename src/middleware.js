import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

// /api/plaid/webhook is called server-to-server by Plaid (no Clerk session
// exists on those requests) — it's verified separately via Plaid's JWT
// signature inside the route itself (see app/api/plaid/webhook/route.js).
const isPublicRoute = createRouteMatcher(['/home', '/privacy', '/sign-in(.*)', '/sign-up(.*)', '/api/plaid/webhook'])

export default clerkMiddleware(async (auth, req) => {
  const { userId } = await auth()

  // signed-in visitors skip the landing page
  if (userId && req.nextUrl.pathname === '/home') {
    return NextResponse.redirect(new URL('/', req.url))
  }
  if (isPublicRoute(req)) return

  // signed-out visitors hitting the app root land on the marketing page
  if (!userId && req.nextUrl.pathname === '/') {
    return NextResponse.redirect(new URL('/home', req.url))
  }
  await auth.protect()
})

export const config = {
  matcher: [
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    '/(api|trpc)(.*)',
  ],
}
