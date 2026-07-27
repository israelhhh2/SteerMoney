import { clerkMiddleware, createRouteMatcher } from '@clerk/nextjs/server'
import { NextResponse } from 'next/server'

const isPublicRoute = createRouteMatcher(['/home', '/sign-in(.*)', '/sign-up(.*)'])

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
