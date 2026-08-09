'use client'
import { useEffect, useRef, useState } from 'react'
import { Bell, BellRing, CreditCard, Repeat, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useApp } from '@/store'
import { upcomingPayments } from '@/lib/reminders'
import { fmt, prettyDate, today } from '@/lib/utils'
import { useT } from '@/lib/i18n'

const DISMISSED_KEY = 'fin-reminders-dismissed' // { [itemKey]: dueDate } — hidden until that due date passes
const NOTIFIED_KEY = 'fin-reminders-notified'   // { [itemKey]: date } — one browser notification per item per day

const readLS = (k) => { try { return JSON.parse(localStorage.getItem(k)) || {} } catch { return {} } }

export function RemindersBell() {
  const t = useT()
  const { state, viewingAs } = useApp()
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState({})
  const [canNotify, setCanNotify] = useState(null) // null unsupported · 'granted' · 'default' · 'denied'
  const panelRef = useRef(null)

  useEffect(() => {
    setDismissed(readLS(DISMISSED_KEY))
    if (typeof Notification !== 'undefined') setCanNotify(Notification.permission)
  }, [])

  const all = upcomingPayments(state, 7)
  const items = all.filter((i) => !(dismissed[i.key] && dismissed[i.key] >= i.due))

  const dismiss = (i) => {
    const next = { ...dismissed, [i.key]: i.due }
    setDismissed(next)
    localStorage.setItem(DISMISSED_KEY, JSON.stringify(next))
  }

  // fire a browser notification for anything due today/tomorrow (once per day)
  useEffect(() => {
    if (viewingAs || canNotify !== 'granted' || !items.length) return
    const notified = readLS(NOTIFIED_KEY)
    const todayStr = today()
    items.filter((i) => i.diff <= 1 && notified[i.key] !== todayStr).forEach((i) => {
      try { new Notification(i.diff === 0 ? t('Payment due today') : t('Payment due tomorrow'), { body: `${i.name} — ${fmt(i.amount)} (${prettyDate(i.due)})`, tag: i.key }) } catch {}
      notified[i.key] = todayStr
    })
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notified))
  }, [canNotify, state])

  // close when clicking outside
  useEffect(() => {
    if (!open) return
    const onDown = (e) => { if (panelRef.current && !panelRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const urgent = items.some((i) => i.diff <= 1)

  return (
    <div className="relative" ref={panelRef}>
      <button
        onClick={() => setOpen(!open)}
        title={t('Payment reminders')}
        className={`relative flex h-8 w-8 items-center justify-center rounded-lg transition hover:bg-secondary ${items.length ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        {urgent ? <BellRing className="h-4 w-4 text-amber-400" /> : <Bell className="h-4 w-4" />}
        {items.length > 0 && (
          <span className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[0.59375rem] font-bold text-white ${urgent ? 'bg-red-500' : 'bg-emerald-500'}`}>
            {items.length}
          </span>
        )}
      </button>

      {open && (
        <div className="fade-in absolute right-0 top-10 z-50 w-[19rem] rounded-xl border bg-card p-3 shadow-2xl sm:w-80">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold">{t('Due in the next 7 days')}</span>
            <span className="text-[0.6875rem] text-muted-foreground">{fmt(items.reduce((s, i) => s + (i.amount || 0), 0))}</span>
          </div>
          <div className="max-h-72 divide-y divide-border/60 overflow-y-auto">
            {items.length ? items.map((i) => (
              <div key={i.key} className="flex items-center gap-2.5 py-2 text-[0.78125rem]">
                <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${i.kind === 'debt' ? 'bg-red-400/10 text-red-400' : 'bg-sky-400/10 text-sky-400'}`}>
                  {i.kind === 'debt' ? <CreditCard className="h-3.5 w-3.5" /> : <Repeat className="h-3.5 w-3.5" />}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{i.name}</div>
                  <div className={`text-[0.65625rem] ${i.diff <= 1 ? 'font-semibold text-amber-400' : 'text-muted-foreground'}`}>
                    {i.diff === 0 ? t('due today') : i.diff === 1 ? t('due tomorrow') : t('in {n} days', { n: i.diff })} · {prettyDate(i.due)}
                  </div>
                </div>
                <span className="shrink-0 text-[0.78125rem] font-semibold">{i.amount ? fmt(i.amount) : ''}</span>
                <button className="shrink-0 text-muted-foreground transition hover:text-foreground" title={t('Dismiss until next due date')} onClick={() => dismiss(i)}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
            )) : (
              <p className="py-4 text-center text-xs text-muted-foreground">
                {all.length ? t('All caught up — everything due soon was dismissed or paid.') : t('Nothing due in the next 7 days. 🎉')}
              </p>
            )}
          </div>
          {canNotify === 'default' && (
            <Button variant="outline" size="xs" className="mt-2 w-full" onClick={() => Notification.requestPermission().then(setCanNotify)}>
              <BellRing />{t('Enable browser notifications')}
            </Button>
          )}
          {canNotify === 'granted' && <p className="mt-2 text-center text-[0.625rem] text-muted-foreground">{t("Browser notifications are on. You'll get pinged the day before anything is due.")}</p>}
        </div>
      )}
    </div>
  )
}
