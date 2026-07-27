'use client'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { UserButton } from '@clerk/nextjs'
import { Eye, LayoutDashboard, CreditCard, Repeat, Target, BarChart3, FlaskConical, Receipt, CloudOff, Loader2, ShieldCheck } from 'lucide-react'
import { cn } from '@/lib/utils'
import { AppProvider, useApp } from '@/store'
import { ToastProvider } from '@/components/toast'
import { RemindersBell } from '@/components/reminders'
import { Onboarding } from '@/components/onboarding'
import { Logo, Wordmark } from '@/components/logo'
import { useIsAdmin } from '@/lib/useIsAdmin'

const NAV = [
  ['/', LayoutDashboard, 'Dashboard'],
  ['/debts', CreditCard, 'Debt Tracker'],
  ['/recurring', Repeat, 'Recurring'],
  ['/budgets', Target, 'Budgets'],
  ['/charts', BarChart3, 'Charts'],
  ['/simulator', FlaskConical, 'Simulator'],
  ['/transactions', Receipt, 'Transactions'],
]
const TITLES = {
  '/': 'Dashboard', '/debts': 'Debt Tracker', '/recurring': 'Recurring Payments',
  '/budgets': 'Budgets', '/charts': 'Charts & Trends', '/simulator': 'Monthly Simulator', '/transactions': 'Transactions',
  '/admin': 'Admin Portal',
}

function Frame({ children }) {
  const pathname = usePathname()
  const router = useRouter()
  const { state, syncError, viewingAs, exitViewAs } = useApp()
  const isAdmin = useIsAdmin()
  const nav = isAdmin ? [...NAV, ['/admin', ShieldCheck, 'Admin']] : NAV

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 z-40 flex h-screen w-[3.75rem] shrink-0 flex-col gap-1 border-r bg-[hsl(240_6%_3%)] p-2 md:w-60 md:p-3">
        <div className="mb-1 flex items-center gap-2.5 px-1.5 py-4 md:px-2">
          <Logo className="h-8 w-8" />
          <div className="hidden leading-tight md:block">
            <Wordmark className="text-[13px]" />
            <div className="text-[10.5px] text-muted-foreground">your money, steered</div>
          </div>
        </div>
        {nav.map(([href, Icon, label]) => (
          <Link
            key={href}
            href={href}
            title={label}
            className={cn(
              'flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[13px] font-medium transition md:px-3',
              pathname === href
                ? 'border-l-2 border-emerald-400/70 bg-accent text-foreground shadow-sm'
                : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground'
            )}
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="hidden md:inline">{label}</span>
          </Link>
        ))}
      </aside>
      <div className="min-w-0 flex-1">
        {viewingAs && (
          <div className="sticky top-0 z-40 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-[12px] font-medium text-amber-300 backdrop-blur-md">
            <Eye className="h-3.5 w-3.5" />
            Viewing as <b>{viewingAs.name}</b> (read-only, changes won't save)
            <button
              className="rounded-md border border-amber-400/40 px-2 py-0.5 text-[11px] font-semibold transition hover:bg-amber-400/20"
              onClick={() => { exitViewAs(); router.push('/admin') }}
            >
              Exit
            </button>
          </div>
        )}
        <header className="sticky top-0 z-30 flex h-14 items-center border-b bg-background/85 px-4 backdrop-blur-md sm:px-8">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
            <h1 className="mr-auto text-[15px] font-semibold tracking-tight">{TITLES[pathname] || 'Finances'}</h1>
            {syncError ? (
              <span className="flex items-center gap-1.5 rounded-md border border-red-400/25 bg-red-400/10 px-2 py-1 text-[11px] font-medium text-red-400" title={syncError}>
                <CloudOff className="h-3.5 w-3.5" /> Sync failed
              </span>
            ) : null}
            {state ? <RemindersBell /> : null}
            <UserButton afterSignOutUrl="/sign-in" />
          </div>
        </header>
        <main className="mx-auto max-w-6xl px-4 py-6 sm:px-8">
          {state ? children : (
            <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading your finances…
            </div>
          )}
        </main>
        <Onboarding />
      </div>
    </div>
  )
}

export default function AppLayout({ children }) {
  return (
    <AppProvider>
      <ToastProvider>
        <Frame>{children}</Frame>
      </ToastProvider>
    </AppProvider>
  )
}
