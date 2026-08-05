import Link from 'next/link'
import { BarChart3, Bell, CreditCard, Target } from 'lucide-react'
import { Logo, Wordmark } from '@/components/logo'

export const metadata = { title: 'SteerMoney: take control of your money' }

const FEATURES = [
  [CreditCard, 'Crush your debt', 'Track every card and loan, and see your debt-free date with avalanche or snowball plans.'],
  [Target, 'Budgets that stick', 'Set monthly limits per category and watch spending against them in real time.'],
  [Bell, 'Never miss a payment', 'Get reminded about every bill and minimum due before they turn late.'],
  [BarChart3, 'See the whole picture', 'Cash flow, trends, and payoff projections from your real transactions.'],
]

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* header */}
      <header className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 py-5">
        <Logo className="h-8 w-8" />
        <Wordmark />
        <div className="ml-auto flex items-center gap-2">
          <Link href="/sign-in" className="rounded-lg px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition hover:text-foreground">
            Log in
          </Link>
          <Link href="/sign-up" className="rounded-lg bg-primary px-3.5 py-2 text-[13px] font-semibold text-primary-foreground shadow transition hover:bg-primary/90">
            Sign up
          </Link>
        </div>
      </header>

      {/* hero */}
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-6 py-14 text-center">
        <Logo className="mb-6 h-14 w-14 rounded-2xl shadow-lg" />
        <h1 className="max-w-2xl text-4xl font-bold tracking-tight sm:text-5xl">
          Steer your money to <span className="bg-gradient-to-r from-emerald-400 to-sky-400 bg-clip-text text-transparent">financial freedom.</span>
        </h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-muted-foreground">
          Debts, budgets, bills, and spending, tracked together so you always know
          where you stand and exactly when you&apos;ll be debt-free.
        </p>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row">
          <Link href="/sign-up" className="rounded-xl bg-primary px-7 py-3 text-sm font-semibold text-primary-foreground shadow-lg transition hover:bg-primary/90">
            Get started free
          </Link>
          <Link href="/sign-in" className="rounded-xl border border-border bg-secondary/40 px-7 py-3 text-sm font-semibold transition hover:bg-secondary">
            Log in
          </Link>
        </div>

        {/* features */}
        <div className="mt-16 grid w-full gap-4 text-left sm:grid-cols-2 lg:grid-cols-4">
          {FEATURES.map(([Icon, title, body]) => (
            <div key={title} className="rounded-xl border bg-card p-5">
              <Icon className="mb-3 h-5 w-5 text-emerald-400" />
              <div className="text-[13.5px] font-semibold">{title}</div>
              <p className="mt-1 text-[12.5px] leading-snug text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="border-t py-6 text-center text-[11px] text-muted-foreground">
        SteerMoney · made with ❤️ ·{' '}
        <Link href="/privacy" className="underline underline-offset-2 hover:text-foreground">
          Privacy
        </Link>
      </footer>
    </div>
  )
}
