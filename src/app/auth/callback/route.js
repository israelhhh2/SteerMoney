import { NextResponse } from 'next/server'
import { createSupabaseServerClient } from '@/lib/supabase-clients'

// Landing point for both Supabase OAuth (signInWithOAuth) and email-link
// flows (signUp's emailRedirectTo, resetPasswordForEmail's redirectTo) —
// exchanges the `code` query param for a session cookie, then redirects to
// `next` (defaults to `/`). Must stay in middleware.js's public-route list
// (no session cookie exists yet when this runs).
export async function GET(request) {
  const { searchParams, origin } = new URL(request.url)
  const code = searchParams.get('code')
  const next = searchParams.get('next') || '/'

  if (code) {
    const supabase = await createSupabaseServerClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`)
    }
    return NextResponse.redirect(`${origin}/sign-in?error=${encodeURIComponent(error.message)}`)
  }

  return NextResponse.redirect(`${origin}/sign-in?error=missing_code`)
}
