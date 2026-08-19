'use client'
import { useEffect, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useAuthUser, useSignOut } from '@/components/auth-provider'
import { Eye, LayoutDashboard, Wallet, CreditCard, Repeat, Target, Flag, BarChart3, FlaskConical, Receipt, CloudOff, Loader2, ShieldCheck, Link2, Menu, Settings, LogOut } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Select } from '@/components/ui/select'
import { Button } from '@/components/ui/button'
import { AppProvider, useApp } from '@/store'
import { ToastProvider, useToast } from '@/components/toast'
import { RemindersBell } from '@/components/reminders'
import { Onboarding } from '@/components/onboarding'
import { FeedbackWidget } from '@/components/feedback-widget'
import { Logo, Wordmark } from '@/components/logo'
import { useIsAdmin } from '@/lib/useIsAdmin'
import { SpaceNameDialog, InviteLinkDialog } from '@/components/space-name-dialog'
import { usePlaidItems, relTime, lastUpdatedAt } from '@/lib/accounts'
import { useT } from '@/lib/i18n'

const NAV = [
  ['/', LayoutDashboard, 'Dashboard'],
  ['/accounts', Wallet, 'Accounts'],
  ['/debts', CreditCard, 'Debt Tracker'],
  ['/recurring', Repeat, 'Recurring'],
  ['/budgets', Target, 'Budgets'],
  ['/goals', Flag, 'Goals'],
  ['/charts', BarChart3, 'Charts'],
  ['/simulator', FlaskConical, 'Simulator'],
  ['/transactions', Receipt, 'Transactions'],
]
const TITLES = {
  '/': 'Dashboard', '/accounts': 'Accounts', '/debts': 'Debt Tracker', '/recurring': 'Recurring Payments',
  '/budgets': 'Budgets', '/goals': 'Goals', '/charts': 'Charts & Trends', '/simulator': 'Monthly Simulator', '/transactions': 'Transactions',
  '/admin': 'Admin Portal', '/settings': 'Settings', '/plaid-oauth': 'Connecting your bank',
}

function BottomNav({ isAdmin }) {
  const pathname = usePathname()
  const t = useT()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setOpen(false)
  }, [pathname])

  const primary = [
    ['/', LayoutDashboard, 'Home'],
    ['/transactions', Receipt, 'Activity'],
    ['/budgets', Target, 'Budgets'],
    ['/goals', Flag, 'Goals'],
  ]

  const sheetRoutes = [
    ['/accounts', Wallet, 'Accounts'],
    ['/debts', CreditCard, 'Debt Tracker'],
    ['/recurring', Repeat, 'Recurring'],
    ['/charts', BarChart3, 'Charts'],
    ['/simulator', FlaskConical, 'Simulator'],
    ['/settings', Settings, 'Settings'],
    ...(isAdmin ? [['/admin', ShieldCheck, 'Admin']] : []),
  ]

  const moreActive = sheetRoutes.some(([href]) => href === pathname)

  return (
    <>
      <nav
        className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 border-t border-border/60 bg-background/90 backdrop-blur-md md:hidden"
        style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      >
        {primary.map(([href, Icon, label]) => {
          const on = pathname === href
          return (
            <Link
              key={href}
              href={href}
              className={cn('flex flex-col items-center gap-1 py-2', on ? 'text-primary' : 'text-muted-foreground')}
            >
              <Icon className="h-5 w-5" />
              <span className="text-[0.65625rem] font-bold">{t(label)}</span>
            </Link>
          )
        })}
        <button
          type="button"
          onClick={() => setOpen(true)}
          className={cn('flex flex-col items-center gap-1 py-2', moreActive ? 'text-primary' : 'text-muted-foreground')}
        >
          <Menu className="h-5 w-5" />
          <span className="text-[0.65625rem] font-bold">{t('More')}</span>
        </button>
      </nav>

      {open ? (
        <div className="fixed inset-0 z-50 md:hidden">
          <div className="absolute inset-0 bg-black/60" onClick={() => setOpen(false)} />
          <div className="fade-in absolute inset-x-0 bottom-0 rounded-t-2xl border-t bg-card p-4 pb-8">
            <div className="mx-auto mb-3 h-1 w-10 rounded-full bg-secondary" />
            {sheetRoutes.map(([href, Icon, label]) => {
              const on = pathname === href
              return (
                <Link
                  key={href}
                  href={href}
                  onClick={() => setOpen(false)}
                  className={cn(
                    'flex items-center gap-3 rounded-xl px-3 py-3 text-[0.84375rem] font-bold transition',
                    on ? 'bg-primary/[0.13] text-foreground' : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
                  )}
                >
                  <Icon className={cn('h-4 w-4 shrink-0', on && 'text-primary')} />
                  {t(label)}
                </Link>
              )
            })}
          </div>
        </div>
      ) : null}
    </>
  )
}

// Small avatar dropdown — replaces Clerk's <UserButton>, which had no direct
// Supabase Auth equivalent. Shows the user's photo (imageUrl) or first-name
// initial in a circle, matching the existing header buttons' sizing; opens a
// tiny menu with a link into Settings (where profile/account live now) and
// a "Sign out" action wired to useSignOut(). Closes on outside click or Esc.
function AvatarMenu() {
  const { user } = useAuthUser()
  const signOut = useSignOut()
  const router = useRouter()
  const t = useT()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const close = () => setOpen(false)
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('click', close)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('click', close); document.removeEventListener('keydown', onKey) }
  }, [open])

  const initial = (user?.firstName || user?.email || '?').slice(0, 1).toUpperCase()

  const handleSignOut = async () => {
    await signOut()
    router.push('/sign-in')
  }

  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full border border-border/60 bg-secondary text-xs font-bold text-foreground/90 transition hover:opacity-90"
      >
        {user?.imageUrl ? <img src={user.imageUrl} alt="" className="h-full w-full object-cover" /> : initial}
      </button>
      {open && (
        <div className="absolute right-0 top-10 z-50 w-44 overflow-hidden rounded-xl border border-border/60 bg-card py-1 shadow-2xl">
          <Link
            href="/settings"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-2 text-[0.8125rem] font-medium text-foreground/90 transition hover:bg-secondary/60"
          >
            <Settings className="h-3.5 w-3.5" />{t('Settings')}
          </Link>
          <button
            type="button"
            onClick={handleSignOut}
            className="flex w-full items-center gap-2 px-3 py-2 text-left text-[0.8125rem] font-medium text-red-400 transition hover:bg-red-400/10"
          >
            <LogOut className="h-3.5 w-3.5" />{t('Sign out')}
          </button>
        </div>
      )}
    </div>
  )
}

function Frame({ children, modal }) {
  const pathname = usePathname()
  const router = useRouter()
  const toast = useToast()
  const { state, syncError, viewingAs, exitViewAs, space, spaces, setSpace, createSpace, createInvite } = useApp()
  const t = useT()
  const isAdmin = useIsAdmin()
  // "Updated <relTime>" header note (see lib/accounts.js's lastUpdatedAt) —
  // usePlaidItems() is a shared module-level store (lib/accounts.js), so a
  // refetchPlaidItems() called from Settings' "Sync now" or AccountDetail's
  // balance "Refresh" updates this instance too, no page reload needed.
  const { plaidItems } = usePlaidItems()
  const updatedAt = lastUpdatedAt(plaidItems)
  const nav = isAdmin ? [...NAV, ['/admin', ShieldCheck, 'Admin']] : NAV
  const [showNewSpace, setShowNewSpace] = useState(false)
  const [inviteUrl, setInviteUrl] = useState(null)

  // Recharts tooltips are driven by mouseenter/mousemove/mouseleave, which
  // touch devices only approximate — there's no touch equivalent of
  // "pointer left the element," so a tapped bar/slice's tooltip otherwise
  // stays glued to the screen indefinitely. Global, not per-chart: fires a
  // synthetic mouseleave at any .recharts-wrapper the touch didn't land in
  // (dismisses on an outside tap) and, after a short delay, at whichever
  // chart WAS touched (so a tap-and-hold doesn't get stuck open forever
  // either). No-op on pages without a chart.
  useEffect(() => {
    let hideTimer
    function onTouchEnd(e) {
      const wrappers = document.querySelectorAll('.recharts-wrapper')
      wrappers.forEach((el) => {
        if (!el.contains(e.target)) el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true }))
      })
      clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        wrappers.forEach((el) => el.dispatchEvent(new MouseEvent('mouseleave', { bubbles: true })))
      }, 1600)
    }
    document.addEventListener('touchend', onTouchEnd, { passive: true })
    return () => { document.removeEventListener('touchend', onTouchEnd); clearTimeout(hideTimer) }
  }, [])

  const switchSpace = async (v) => {
    if (v === 'personal') return setSpace(null)
    if (v === '__new') {
      setShowNewSpace(true)
      return
    }
    const s = spaces.find((x) => x.id === v)
    if (s) setSpace(s)
  }

  const saveNewSpace = async (name) => {
    const r = await createSpace(name)
    if (r.error) toast(t("Couldn't create the space: {error}", { error: r.error }), 'error')
    else toast(t('"{name}" created. Tap Invite to share it.', { name }))
  }

  const invite = async () => {
    const r = await createInvite()
    if (r.error) return toast(r.error, 'error')
    try {
      await navigator.clipboard.writeText(r.url)
      toast(t('Invite link copied. It works for 7 days.'))
    } catch {
      setInviteUrl(r.url)
    }
  }

  const spaceSelect = (className) => (
    <Select
      title={t('Switch between your personal finances and shared spaces')}
      className={className}
      value={space?.id || 'personal'}
      onChange={(e) => switchSpace(e.target.value)}
    >
      <option value="personal">{t('Personal')}</option>
      {spaces.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
      <option value="__new">{t('+ New shared space…')}</option>
    </Select>
  )

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar */}
      <aside className="sticky top-0 z-40 hidden h-screen w-60 shrink-0 flex-col gap-1 border-r border-border/60 bg-[hsl(225_60%_3%)] p-3 md:flex">
        <div className="mb-2 flex items-center gap-2.5 px-2 py-4">
          <Logo className="h-8 w-8" />
          <div className="leading-tight">
            <Wordmark className="text-[0.8125rem]" />
            <div className="text-[0.65625rem] font-semibold text-muted-foreground">your money, steered</div>
          </div>
        </div>
        {nav.map(([href, Icon, label]) => (
          <Link
            key={href}
            href={href}
            title={t(label)}
            className={cn(
              'flex h-10 items-center gap-3 rounded-xl px-3 text-[0.84375rem] font-bold transition',
              pathname === href
                ? 'bg-primary/[0.13] text-foreground'
                : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
            )}
          >
            <Icon className={cn('h-4 w-4 shrink-0', pathname === href && 'text-primary')} />
            {t(label)}
          </Link>
        ))}
        <Link
          href="/settings"
          title={t('Settings')}
          className={cn(
            'mt-auto flex h-10 items-center gap-3 rounded-xl px-3 text-[0.84375rem] font-bold transition',
            pathname === '/settings'
              ? 'bg-primary/[0.13] text-foreground'
              : 'text-muted-foreground hover:bg-secondary/50 hover:text-foreground'
          )}
        >
          <Settings className={cn('h-4 w-4 shrink-0', pathname === '/settings' && 'text-primary')} />
          {t('Settings')}
        </Link>
      </aside>

      <div className="min-w-0 flex-1">
        {viewingAs && (
          <div className="sticky top-0 z-50 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 border-b border-amber-400/30 bg-amber-400/10 px-4 py-1.5 text-[0.75rem] font-medium text-amber-300 backdrop-blur-md">
            <Eye className="h-3.5 w-3.5" />
            {t('Viewing as')} <b>{viewingAs.name}</b> {t("(read-only, changes won't save)")}
            <button
              className="rounded-md border border-amber-400/40 px-2 py-0.5 text-[0.6875rem] font-semibold transition hover:bg-amber-400/20"
              onClick={() => { exitViewAs(); router.push('/admin') }}
            >
              {t('Exit')}
            </button>
          </div>
        )}

        {/* Mobile header: wordmark left, space switcher centered */}
        <div className="sticky top-0 z-30 border-b border-border/60 bg-background/90 backdrop-blur-md md:hidden">
          <div className="grid h-14 grid-cols-[1fr_auto_1fr] items-center gap-2 px-4">
            <div className="flex min-w-0 items-center gap-1.5">
              <Logo className="h-5 w-5 shrink-0" />
              <Wordmark className="truncate text-[0.9375rem]" />
            </div>
            <div className="flex justify-center">
              {!viewingAs ? spaceSelect('!h-8 max-w-[7.5rem] rounded-full border-none bg-secondary/60 px-2.5 text-xs font-bold') : <span />}
            </div>
            <div className="flex items-center justify-end gap-2">
              {!syncError && updatedAt ? (
                <span className="max-w-[5.5rem] truncate text-[0.625rem] font-medium text-muted-foreground">{t('Updated {time}', { time: relTime(updatedAt) })}</span>
              ) : null}
              {syncError ? <button type="button" onClick={() => window.alert(syncError)} title={syncError}><CloudOff className="h-4 w-4 text-red-400" /></button> : null}
              {state ? <RemindersBell /> : null}
            </div>
          </div>
        </div>

        {/* Desktop header */}
        <header className="sticky top-0 z-30 hidden h-14 items-center border-b border-border/60 bg-background/85 px-4 backdrop-blur-md sm:px-8 md:flex">
          <div className="mx-auto flex w-full max-w-6xl items-center gap-3">
            <h1 className="mr-auto text-[0.9375rem] font-extrabold tracking-tight">{t(TITLES[pathname] || 'Finances')}</h1>
            {!syncError && updatedAt ? (
              <span className="whitespace-nowrap text-[0.6875rem] font-medium text-muted-foreground">{t('Updated {time}', { time: relTime(updatedAt) })}</span>
            ) : null}
            {syncError ? (
              <button type="button" onClick={() => window.alert(syncError)} className="flex cursor-pointer items-center gap-1.5 rounded-md border border-red-400/25 bg-red-400/10 px-2 py-1 text-[0.6875rem] font-medium text-red-400 transition hover:bg-red-400/20" title={syncError}>
                <CloudOff className="h-3.5 w-3.5" /> {t('Sync failed')}
              </button>
            ) : null}
            {!viewingAs && spaceSelect('!h-8 max-w-32 text-xs sm:max-w-44')}
            {space && !viewingAs ? (
              <Button variant="outline" size="xs" onClick={invite} title={t('Copy an invite link for this shared space')}>
                <Link2 /><span className="hidden sm:inline">{t('Invite')}</span>
              </Button>
            ) : null}
            {state ? <RemindersBell /> : null}
            <AvatarMenu />
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-5 pb-32 sm:px-8 sm:py-6 md:pb-12">
          {state ? children : (
            <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t('Loading your finances…')}
            </div>
          )}
        </main>
        <BottomNav isAdmin={isAdmin} />
        <Onboarding />
      </div>
      {showNewSpace && (
        <SpaceNameDialog
          title={t('New shared space')}
          placeholder={t('Our finances')}
          onSave={saveNewSpace}
          onClose={() => setShowNewSpace(false)}
        />
      )}
      {inviteUrl && <InviteLinkDialog url={inviteUrl} onClose={() => setInviteUrl(null)} />}
      {state ? <FeedbackWidget /> : null}
      {modal}
    </div>
  )
}

export default function AppLayout({ children, modal }) {
  return (
    <AppProvider>
      <ToastProvider>
        <Frame modal={modal}>{children}</Frame>
      </ToastProvider>
    </AppProvider>
  )
}
