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

export default function SignUpPage() {
  const router = useRouter()
  const params = useSearchParams()
  const supabase = useSupabaseClient()
  const redirectUrl = params.get('redirect_url') || '/'

  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [checkEmail, setCheckEmail] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setError(null)
    if (password !== confirm) return setError('Passwords do not match')
    if (password.length < 8) return setError('Password must be at least 8 characters')
    setLoading(true)
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectUrl)}` },
    })
    setLoading(false)
    if (error) return setError(error.message)
    // Email confirmation is on by default in Supabase — no session yet until
    // the user clicks the link in their inbox (which lands on /auth/callback).
    if (data.session) router.push(redirectUrl)
    else setCheckEmail(true)
  }

  const withGoogle = async () => {
    setError(null)
    setLoading(true)
    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(redirectUrl)}` },
    })
    if (error) { setLoading(false); setError(error.message) }
  }

  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 p-6">
      <div className="flex items-center gap-2.5">
        <Logo className="h-9 w-9" />
        <Wordmark className="text-lg" />
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>Create your account</CardTitle>
          <CardDescription>Steer your money — debts, budgets, and bills, all in one place.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {checkEmail ? (
            <p className="text-sm text-muted-foreground">
              Check <b className="text-foreground">{email}</b> for a confirmation link to finish creating your account.
            </p>
          ) : (
            <>
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
                  <Label htmlFor="password">Password</Label>
                  <Input id="password" type="password" autoComplete="new-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
                </div>
                <div>
                  <Label htmlFor="confirm">Confirm password</Label>
                  <Input id="confirm" type="password" autoComplete="new-password" required value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                </div>
                {error ? <p className="text-xs text-red-400">{error}</p> : null}
                <Button type="submit" className="w-full" disabled={loading}>
                  {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Create account
                </Button>
              </form>
            </>
          )}

          <p className="text-center text-xs text-muted-foreground">
            Already have an account? <Link href="/sign-in" className="font-medium text-primary hover:underline">Sign in</Link>
          </p>
        </CardContent>
      </Card>
    </div>
  )
}
