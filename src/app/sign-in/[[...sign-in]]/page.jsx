'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Loader2 } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Logo, Wordmark } from '@/components/logo'
import { useSupabaseClient } from '@/components/auth-provider'

function GoogleIcon() {
  return (
    <svg viewBox="0 0 48 48" className="h-4 w-4" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6 29.6 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.7-.4-3.5z" />
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.6 15.9 18.9 13 24 13c3.1 0 5.8 1.1 8 3l5.7-5.7C34.6 6.9 29.6 5 24 5c-7.5 0-14 4.2-17.7 9.7z" />
      <path fill="#4CAF50" d="M24 44c5.5 0 10.4-1.8 14.2-5l-6.6-5.5c-2 1.5-4.6 2.5-7.6 2.5-5.3 0-9.7-3.4-11.3-8.1l-6.6 5.1C9.9 39.7 16.4 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.5l6.6 5.5C41.4 35.8 44 30.4 44 24c0-1.3-.1-2.7-.4-3.5z" />
    </svg>
  )
}

export default function SignInPage() {
  const router = useRouter()
  const params = useSearchParams()
  const supabase = useSupabaseClient()
  const redirectUrl = params.get('redirect_url') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [mode, setMode] = useState('sign-in') // 'sign-in' | 'reset'
  const [resetSent, setResetSent] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithPassword({ email, password })
    setLoading(false)
    if (error) return setError(error.message)
    router.push(redirectUrl)
  }

  const sendReset = async (e) => {
    e.preventDefault()
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: `${window.location.origin}/auth/callback?next=/settings`,
    })
    setLoading(false)
    if (error) return setError(error.message)
    setResetSent(true)
  }

  const withGoogle = async () => {
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectUrl)}` },
    })
    if (error) { setLoading(false); setError(error.message) }
    // on success the browser navigates away to Google — no further state to set
  }

  if (mode === 'reset') {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
        <div className="flex items-center gap-2.5">
          <Logo className="h-9 w-9" />
          <Wordmark className="text-lg" />
        </div>
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>Reset your password</CardTitle>
            <CardDescription>We'll email you a link to get back in.</CardDescription>
          </CardHeader>
          <CardContent>
            {resetSent ? (
              <p className="text-sm text-muted-foreground">
                If an account exists for <b className="text-foreground">{email}</b>, a reset link is on its way.
              </p>
            ) : (
              <form onSubmit={sendReset} className="space-y-3">
                <div>
                  <Label htmlFor="reset-email">Email</Label>
                  <Input id="reset-email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Send reset link
                </Button>
              </form>
            )}
            <button type="button" onClick={() => { setMode('sign-in'); setError(null); setResetSent(false) }} className="mt-4 text-xs font-medium text-primary hover:underline">
              Back to sign in
            </button>
          </CardContent>
        </Card>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-2.5">
        <Logo className="h-9 w-9" />
        <Wordmark className="text-lg" />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Sign in</CardTitle>
          <CardDescription>Steer your money — debts, budgets, and bills, all in one place.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button type="button" variant="outline" className="w-full" onClick={withGoogle} disabled={loading}>
            <GoogleIcon /> Continue with Google
          </Button>

          <div className="flex items-center gap-3 text-[0.6875rem] font-medium uppercase text-muted-foreground">
            <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
          </div>

          <form onSubmit={submit} className="space-y-3">
            <div>
              <Label htmlFor="email">Email</Label>
              <Input id="email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <div className="flex items-center justify-between">
                <Label htmlFor="password" className="mb-1.5">Password</Label>
                <button type="button" onClick={() => { setMode('reset'); setError(null) }} className="mb-1.5 text-xs font-medium text-primary hover:underline">
                  Forgot password?
                </button>
              </div>
              <Input id="password" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            {error ? <p className="text-xs text-red-400">{error}</p> : null}
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Sign in
            </Button>
          </form>

          <p className="text-center text-xs text-muted-foreground">
            Don&apos;t have an account? <Link href="/sign-up" className="font-medium text-primary hover:underline">Sign up</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
