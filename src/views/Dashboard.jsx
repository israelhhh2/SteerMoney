'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useUser } from '@clerk/nextjs'
import { TrendingUp, TrendingDown, CreditCard, CalendarDays, X, Lightbulb, Target } from 'lucide-react'
import { BarChart, Bar as RBar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { SectionHead, SectionLabel, Kpi, MoneyTile, CatIcon, Bar, Ring, budgetTone, Money } from '@/components/shared'
import { useApp, monthTx, rangeTx, incomeIn, expensesIn, spentIn, dataMonths } from '@/store'
import { fmt, fmt0, today, isoDate, ymLabel, monthLabel, prettyDate, catColor, srcLabel, ordinal } from '@/lib/utils'
import { simulatePlan, recMonthly, nextDueDate } from '@/lib/finance'
import { useIsMobile } from '@/lib/useMediaQuery'
import { ICONS } from '@/views/Goals'

function GoalIcon({ icon, className = 'h-4 w-4' }) {
  const I = ICONS[icon] || Target
  return <I className={className} />
}

const TIP = {
  contentStyle: { background: 'hsl(240 6% 9%)', border: '1px solid hsl(240 6% 16%)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#d4d4d8', fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: '#e4e4e7' },
}

// Deterministic hue from a card's name so each one gets a stable, distinct gradient
// (no real issuer branding data available, so this stands in for "issuer color").
function cardHue(name) {
  let h = 0
  for (let i = 0; i < (name || '').length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

// Copilot-style mini "credit card" chip used in the Dashboard's Credit Cards list.
function CardChip({ name }) {
  const hue = cardHue(name)
  return (
    <div
      className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl px-1.5 shadow-sm"
      style={{ background: `linear-gradient(135deg, hsl(${hue} 65% 40%), hsl(${(hue + 40) % 360} 55% 24%))` }}
    >
      <span className="truncate text-center text-[0.5625rem] font-bold leading-tight text-white/90">{name}</span>
    </div>
  )
}

function cfBounds(range) {
  const t = today()
  const now = new Date(t + 'T00:00:00')
  if (range.mode === 'month') return { from: t.slice(0, 7) + '-01', to: t, label: ymLabel(t.slice(0, 7)) + ' so far' }
  if (range.mode === 'lastMonth') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const e = new Date(now.getFullYear(), now.getMonth(), 0)
    return { from: isoDate(d), to: isoDate(e), label: ymLabel(isoDate(d).slice(0, 7)) }
  }
  if (range.mode === '7d') { const d = new Date(now); d.setDate(d.getDate() - 6); return { from: isoDate(d), to: t, label: 'Last 7 days' } }
  if (range.mode === '30d') { const d = new Date(now); d.setDate(d.getDate() - 29); return { from: isoDate(d), to: t, label: 'Last 30 days' } }
  if (range.mode === 'all') return { from: '0000-01-01', to: '9999-12-31', label: 'Everything imported' }
  if (range.mode === 'ym') {
    const ym = range.ym
    const e = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0)
    return { from: ym + '-01', to: isoDate(e), label: ymLabel(ym) }
  }
  const f = range.from || t.slice(0, 7) + '-01', e = range.to || t
  return { from: f <= e ? f : e, to: e >= f ? e : f, label: prettyDate(f <= e ? f : e) + ' – ' + prettyDate(e >= f ? e : f) }
}

export default function Dashboard() {
  const { state, catInfo, viewingAs } = useApp()
  const { user } = useUser()
  const isMobile = useIsMobile()
  const es = user?.unsafeMetadata?.lang === 'es' && !viewingAs
  const firstName = viewingAs ? viewingAs.name.split(' ')[0] : user?.firstName
  const [range, setRange] = useState({ mode: 'month', from: null, to: null })
  const [cfView, setCfView] = useState(null)

  const nowYm = today().slice(0, 7)
  const months = dataMonths(state)
  const fullM = months.filter((m) => m !== nowYm)
  const avgIncome = fullM.length ? fullM.reduce((s, m) => s + incomeIn(state, m), 0) / fullM.length : incomeIn(state, nowYm)
  const avgExp = fullM.length ? fullM.reduce((s, m) => s + expensesIn(state, m), 0) / fullM.length : expensesIn(state, nowYm)
  const totalDebt = state.debts.reduce((s, d) => s + d.balance, 0)
  const mins = state.debts.reduce((s, d) => s + d.min, 0)
  const recTotal = state.recurring.filter((r) => r.active !== false).reduce((s, r) => s + recMonthly(r), 0)
  const plan = useMemo(() => simulatePlan(state.debts, state.sim.budget, state.sim.strategy), [state.debts, state.sim])

  const B = cfBounds(range)
  const rT = rangeTx(state, B.from, B.to)
  const rIn = rT.filter((t) => t.type === 'income' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
  const rOut = rT.filter((t) => t.type === 'expense' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
  const rNet = rIn - rOut

  const breakdown = useMemo(() => {
    if (!cfView) return []
    const groups = {}
    rT.filter((t) => (cfView === 'in' ? t.type === 'income' : t.type === 'expense') && t.cat !== 'transfer').forEach((t) => {
      const k = cfView === 'in' ? srcLabel(t.desc) : t.cat
      groups[k] = groups[k] || { sum: 0, n: 0 }
      groups[k].sum += t.amount; groups[k].n++
    })
    return Object.entries(groups)
      .map(([k, v]) => (cfView === 'in'
        ? { label: k, sum: v.sum, n: v.n, color: '#34d399' }
        : { label: catInfo(k).name, cat: k, sum: v.sum, n: v.n, color: catColor(k) }))
      .sort((a, b) => b.sum - a.sum)
  }, [cfView, B.from, B.to, state.transactions])
  const bTot = breakdown.reduce((s, r) => s + r.sum, 0) || 1

  // charts
  const flowData = months.slice().reverse().map((m) => ({ name: ymLabel(m), Income: Math.round(incomeIn(state, m)), Spending: Math.round(expensesIn(state, m)) }))
  const catSums = {}
  monthTx(state, nowYm).forEach((t) => { if (t.type === 'expense' && t.cat !== 'transfer') catSums[t.cat] = (catSums[t.cat] || 0) + t.amount })
  const donut = Object.entries(catSums).sort((a, b) => b[1] - a[1]).slice(0, 9).map(([c, v]) => ({ name: catInfo(c).name, value: Math.round(v), color: catColor(c) }))

  // due in 14 days
  const up = []
  const now0 = new Date(); now0.setHours(0, 0, 0, 0)
  state.debts.forEach((d) => { if (d.balance > 0 && d.dueDay) { const dt = nextDueDate(d.dueDay); const diff = Math.round((dt - now0) / 864e5); if (diff <= 14) up.push({ name: d.name, amt: d.min, diff, tag: 'debt', cat: 'debt' }) } })
  state.recurring.forEach((r) => {
    if (r.active === false) return
    let dt = null
    if ((r.every || 1) > 1) { if (r.nextDate) dt = new Date(r.nextDate + 'T00:00:00') } else if (r.dueDay) dt = nextDueDate(r.dueDay)
    if (!dt) return
    const diff = Math.round((dt - now0) / 864e5)
    if (diff >= 0 && diff <= 14) up.push({ name: r.desc, amt: r.amount, diff, tag: 'bill', cat: r.cat })
  })
  up.sort((a, b) => a.diff - b.diff)

  // group upcoming items by due date for the horizontal scroller
  const upGroups = useMemo(() => {
    const groups = {}
    const order = []
    up.forEach((u) => {
      if (!(u.diff in groups)) { groups[u.diff] = []; order.push(u.diff) }
      groups[u.diff].push(u)
    })
    return order.map((diff) => {
      const label = diff === 0 ? 'Today' : (() => {
        const d = new Date(); d.setDate(d.getDate() + diff)
        return d.toLocaleDateString('en-US', { month: 'short' }) + ' ' + ordinal(d.getDate())
      })()
      return { diff, label, items: groups[diff] }
    })
  }, [up])

  const cards = state.debts.filter((d) => d.limit)
  const ccLimit = cards.reduce((s, d) => s + d.limit, 0), ccBal = cards.reduce((s, d) => s + d.balance, 0)
  const ccUtil = ccLimit ? Math.round((ccBal / ccLimit) * 100) : 0

  const maxSpent = Math.max(1, ...state.budgets.map((b) => spentIn(state, nowYm, b.id)))

  const ringBudgets = state.budgets
    .filter((b) => b.limit > 0)
    .map((b) => ({ ...b, spent: spentIn(state, nowYm, b.id) }))
    .sort((a, b) => (b.spent / b.limit) - (a.spent / a.limit))

  const activeGoals = (state.goals || [])
    .filter((g) => g.status === 'active')
    .map((g) => ({ ...g, saved: (g.txs || []).reduce((s, t) => s + t.amount, 0) }))
    .sort((a, b) => (b.target ? b.saved / b.target : 0) - (a.target ? a.saved / a.target : 0))
    .slice(0, 4)

  return (
    <div className="fade-in space-y-6">
      {firstName && (
        <div>
          <h2 className="text-xl font-bold tracking-tight">{es ? 'Bienvenido' : 'Welcome'}, {firstName} 👋</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{es ? 'Así va tu dinero hoy.' : 'Here is where your money stands today.'}</p>
        </div>
      )}
      {/* Cash flow — only the header area navigates; the card itself is full of its
          own controls (range pills, breakdown toggle, month rows) so it stays inert. */}
      <Card className="p-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <SectionHead title={`Cash Flow · ${B.label}`} desc="Money in minus money out · transfers between your own accounts don't count" href="/transactions" />
          <Segmented
            className="sm:ml-auto"
            scroll
            value={range.mode === 'ym' ? '' : range.mode}
            onChange={(m) => setRange({ mode: m, from: null, to: null })}
            options={[['month', 'This month'], ['lastMonth', 'Last month'], ['7d', '7 days'], ['30d', '30 days'], ['all', 'All'], ['custom', 'Custom']]}
          />
        </div>
        {range.mode === 'custom' && (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Label className="mb-0">From</Label>
            <Input type="date" className="w-40" value={B.from} onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))} />
            <Label className="mb-0">to</Label>
            <Input type="date" className="w-40" value={B.to} onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))} />
          </div>
        )}
        <div className="mb-4 mt-4 grid grid-cols-3 gap-2 sm:gap-3">
          <MoneyTile label="Money In" value={<Money value={fmt0(rIn)} />} tone="green" active={cfView === 'in'} hint={cfView === 'in' ? 'hide breakdown ▴' : 'where from? ▾'} onClick={() => setCfView(cfView === 'in' ? null : 'in')} />
          <MoneyTile label="Money Out" value={<Money value={fmt0(rOut)} />} tone="red" active={cfView === 'out'} hint={cfView === 'out' ? 'hide breakdown ▴' : 'where to? ▾'} onClick={() => setCfView(cfView === 'out' ? null : 'out')} />
          <MoneyTile label={rNet >= 0 ? 'Left Over' : 'In The Negative'} value={<Money value={(rNet >= 0 ? '' : '−') + fmt0(Math.abs(rNet))} />} tone={rNet >= 0 ? 'green' : 'red'} />
        </div>

        {cfView && (
          <div className="mb-4 rounded-xl border bg-secondary/40 p-4 fade-in">
            <div className="mb-3 flex items-center justify-between">
              <span className={`text-xs font-semibold ${cfView === 'in' ? 'text-emerald-300' : 'text-red-300'}`}>
                {cfView === 'in' ? 'Where the money came from' : 'Where the money went'} · {B.label}
              </span>
              <button onClick={() => setCfView(null)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
            </div>
            <div className="divide-y divide-border/60">
              {breakdown.length ? breakdown.map((r) => (
                <div key={r.label} className="flex items-center gap-3 py-2 text-[0.8125rem]">
                  {r.cat && <CatIcon cat={r.cat} className="h-3.5 w-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate text-foreground/90 sm:w-56 sm:flex-none">{r.label}</span>
                  <div className="track hidden flex-1 sm:block"><div style={{ width: `${Math.round((r.sum / bTot) * 100)}%`, background: r.color }} /></div>
                  <span className="hidden w-16 shrink-0 text-right text-[0.6875rem] text-muted-foreground sm:inline">{r.n}× · {Math.round((r.sum / bTot) * 100)}%</span>
                  <span className={`w-20 shrink-0 text-right font-semibold ${cfView === 'in' ? 'text-emerald-400' : ''}`}>{fmt0(r.sum)}</span>
                </div>
              )) : <div className="py-4 text-center text-xs text-muted-foreground">Nothing recorded in this period.</div>}
            </div>
          </div>
        )}

        <div className="divide-y divide-border/60">
          {months.map((m) => {
            const inc = incomeIn(state, m), ex = expensesIn(state, m), net = inc - ex
            const on = range.mode === 'ym' && range.ym === m
            return (
              <button
                key={m}
                onClick={() => setRange(on ? { mode: 'month', from: null, to: null } : { mode: 'ym', ym: m })}
                title={on ? 'Back to this month' : `Show ${ymLabel(m)} in the cards above`}
                className={`-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-2 text-[0.71875rem] transition sm:gap-3 sm:text-[0.8125rem] ${on ? 'bg-emerald-400/[0.07] ring-1 ring-emerald-400/25' : 'hover:bg-secondary/50'}`}
              >
                <span className={`w-14 shrink-0 whitespace-nowrap text-left font-medium sm:w-24 ${on ? 'text-emerald-300' : ''}`}>
                  {ymLabel(m)}{m === nowYm && <span className="hidden text-[0.625rem] text-muted-foreground sm:inline"> · so far</span>}
                </span>
                <span className="min-w-0 flex-1 whitespace-nowrap text-right text-emerald-400">+{fmt0(inc)}</span>
                <span className="min-w-0 flex-1 whitespace-nowrap text-right text-red-400">−{fmt0(ex)}</span>
                <span className={`w-16 shrink-0 whitespace-nowrap text-right font-bold sm:w-28 ${net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{net >= 0 ? '+' : '−'}{fmt0(Math.abs(net))}</span>
              </button>
            )
          })}
          <div className="flex items-center gap-2 pt-2 text-[0.625rem] text-muted-foreground sm:gap-3 sm:text-[0.6875rem]">
            <span className="w-14 shrink-0 sm:w-24">tap a month ↑</span><span className="min-w-0 flex-1 whitespace-nowrap text-right">money in</span><span className="min-w-0 flex-1 whitespace-nowrap text-right">money out</span><span className="w-16 shrink-0 text-right sm:w-28">left over</span>
          </div>
        </div>
      </Card>

      {/* KPIs — each tile is its own card, so each links straight to its detail page */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Avg Monthly Income" value={<Money value={fmt0(avgIncome)} />} icon={TrendingUp} tone="text-emerald-400" sub={`${ymLabel(nowYm)} so far: ${fmt0(incomeIn(state, nowYm))}`} href="/charts" />
        <Kpi label="Avg Monthly Spending" value={<Money value={fmt0(avgExp)} />} icon={TrendingDown} sub={`${ymLabel(nowYm)} so far: ${fmt0(expensesIn(state, nowYm))}`} href="/charts" />
        <Kpi label="Total Debt" value={<Money value={fmt0(totalDebt)} />} icon={CreditCard} tone="text-red-400" sub={plan.done ? `debt-free ${monthLabel(plan.end)} on your plan` : ''} href="/debts" />
        <Kpi label="Fixed Monthly Payments" value={<Money value={fmt0(mins + recTotal)} />} icon={CalendarDays} sub={`${fmt0(mins)} debt + ${fmt0(recTotal)} bills`} href="/recurring" />
      </div>

      {/* Upcoming — bills/debts grouped by due date, Copilot-style horizontal scroller */}
      {up.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Upcoming" link="Recurrings" href="/recurring" />
          <div className="no-scrollbar -mx-4 flex gap-5 overflow-x-auto px-4 sm:mx-0 sm:px-0">
            {upGroups.map((g) => (
              <div key={g.diff}>
                <div className="mb-1.5 whitespace-nowrap text-[0.6875rem] font-bold text-primary/90">{g.label}</div>
                <div className="flex gap-2">
                  {g.items.map((u, i) => (
                    <div key={i} className="flex shrink-0 items-center gap-2 rounded-2xl bg-card border px-3.5 py-2.5">
                      <CatIcon cat={u.cat} className="h-4 w-4 shrink-0" />
                      <span className="max-w-32 truncate text-[0.8125rem] font-semibold">{u.name}</span>
                      <span className="text-[0.8125rem] font-bold text-muted-foreground">{fmt(u.amt || 0)}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Budgets — circular progress ring row */}
      {ringBudgets.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Budgets" link="Categories" href="/budgets" />
          <div className="no-scrollbar -mx-4 flex gap-5 overflow-x-auto px-4 pb-1 sm:mx-0 sm:px-1">
            {ringBudgets.map((b) => {
              const over = b.spent > b.limit
              return (
                <div key={b.id} className="flex w-[4.5rem] shrink-0 flex-col items-center gap-1.5">
                  <Ring pct={over ? 100 : (b.spent / b.limit) * 100} color={budgetTone(b.spent, b.limit)} size={68} stroke={5.5}>
                    <CatIcon cat={b.id} className="h-6 w-6" />
                  </Ring>
                  <div className="text-center leading-tight">
                    <div className="text-[0.84375rem] font-bold">{fmt(Math.abs(b.limit - b.spent))}</div>
                    <div className={`text-[0.6875rem] ${over ? 'text-red-400' : 'text-muted-foreground'}`}>{over ? 'over' : 'left'}</div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Goals — tight progress rows */}
      {activeGoals.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Goals" link="All goals" href="/goals" />
          <Card className="p-4">
            <div className="divide-y divide-border/60">
              {activeGoals.map((g) => {
                const reached = g.target > 0 && g.saved >= g.target
                const pct = g.target ? Math.min(100, (g.saved / g.target) * 100) : 0
                return (
                  <div key={g.id} className="flex items-center gap-3 py-2">
                    <span className="flex w-6 shrink-0 justify-center text-primary"><GoalIcon icon={g.icon} /></span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-2 text-[0.8125rem]">
                        <span className="truncate font-bold">{g.name}</span>
                        <span className="shrink-0 text-right">
                          <span className="font-bold">{fmt0(g.saved)}</span>
                          <span className="text-muted-foreground"> / {fmt0(g.target)}</span>
                        </span>
                      </div>
                      <div className="mt-1.5"><Bar pct={reached ? 100 : pct} color="#2fbf71" /></div>
                    </div>
                  </div>
                )
              })}
            </div>
          </Card>
        </div>
      )}

      {/* charts */}
      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-5">
          <SectionHead title="Income vs Spending" desc={`From transactions · transfers excluded · ${ymLabel(nowYm)} is partial`} />
          <div className="mt-4 h-56">
            <ResponsiveContainer>
              <BarChart data={flowData}>
                <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={(v) => '$' + (v >= 1000 ? v / 1000 + 'k' : v)} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} cursor={{ fill: '#ffffff08' }} formatter={(v) => fmt0(v)} />
                <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => <span style={{ color: '#a1a1aa' }}>{v}</span>} />
                <RBar dataKey="Income" fill="#34d399" radius={[5, 5, 0, 0]} maxBarSize={36} style={{ filter: 'drop-shadow(0 0 4px rgba(52,211,153,0.35))' }} />
                <RBar dataKey="Spending" fill="#e0655f" radius={[5, 5, 0, 0]} maxBarSize={36} style={{ filter: 'drop-shadow(0 0 4px rgba(224,101,95,0.35))' }} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Link href="/charts" className="group block min-w-0">
        <Card className="min-w-0 cursor-pointer p-5 transition hover:border-primary/40 hover:bg-secondary/[0.12]">
          <SectionHead title="This Month by Category" desc={ymLabel(nowYm)} chevron />
          {donut.length ? (
            <div className="mt-4 h-48 sm:h-56">
              <ResponsiveContainer>
                <PieChart>
                  <Pie data={donut} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="90%" paddingAngle={2} stroke="hsl(240 6% 7%)">
                    {donut.map((d) => <Cell key={d.name} fill={d.color} />)}
                  </Pie>
                  <Tooltip {...TIP} formatter={(v) => fmt0(v)} />
                  {!isMobile && <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 10 }} formatter={(v) => <span style={{ color: '#a1a1aa' }}>{v}</span>} />}
                </PieChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="mt-4 flex h-48 items-center justify-center text-center text-xs text-muted-foreground sm:h-56">Nothing recorded in this period.</div>
          )}
          {isMobile && donut.length > 0 && (
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.6875rem]">
              {donut.map((d) => (
                <span key={d.name} className="flex min-w-0 items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
                  <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.name}</span>
                </span>
              ))}
            </div>
          )}
        </Card>
        </Link>
      </div>

      {/* bottom widgets */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Link href="/recurring" className="group block min-w-0">
        <Card className="min-w-0 cursor-pointer p-5 transition hover:border-primary/40 hover:bg-secondary/[0.12]">
          <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
            <SectionHead title="Due in 14 days" chevron />
            <Badge className="shrink-0">{fmt0(up.reduce((s, u) => s + (u.amt || 0), 0))}</Badge>
          </div>
          <div className="max-h-64 divide-y divide-border/60 overflow-y-auto">
            {up.length ? up.map((u, i) => (
              <div key={i} className="flex min-w-0 items-center gap-2.5 py-2 text-[0.8125rem]">
                <span className={`w-11 shrink-0 rounded-md px-1 py-1 text-center text-[0.625rem] font-bold ${u.diff <= 3 ? 'bg-red-400/10 text-red-400' : 'bg-secondary text-muted-foreground'}`}>
                  {u.diff === 0 ? 'today' : `in ${u.diff}d`}
                </span>
                <span className="min-w-0 flex-1 truncate text-foreground/90">{u.name}</span>
                <Badge className="shrink-0" variant={u.tag === 'debt' ? 'destructive' : 'info'}>{u.tag}</Badge>
                <span className="shrink-0 whitespace-nowrap text-xs font-semibold">{u.amt ? fmt(u.amt) : ''}</span>
              </div>
            )) : <p className="py-2 text-[0.8125rem] text-muted-foreground">Nothing due in the next two weeks.</p>}
          </div>
        </Card>
        </Link>
        <Link href="/debts" className="group block min-w-0">
        <Card className="min-w-0 cursor-pointer p-5 transition hover:border-primary/40 hover:bg-secondary/[0.12]">
          <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
            <SectionHead title="Credit Cards" total={fmt0(ccBal)} chevron />
            <Badge className="shrink-0" variant={ccUtil > 80 ? 'destructive' : ccUtil > 30 ? 'warning' : 'success'}>{ccUtil}% used</Badge>
          </div>
          <div className="max-h-64 divide-y divide-border/60 overflow-y-auto">
            {cards.map((d) => {
              const u = Math.min(100, Math.round((d.balance / d.limit) * 100))
              return (
                <div key={d.name} className="flex items-center gap-3 py-2.5">
                  <CardChip name={d.name} />
                  <div className="min-w-0 flex-1">
                    <div className="mb-0.5 flex min-w-0 items-baseline justify-between gap-2">
                      <span className="min-w-0 flex-1 truncate text-[0.625rem] font-bold uppercase tracking-wider text-muted-foreground">{d.name}</span>
                      <span className="shrink-0 whitespace-nowrap text-[0.6875rem] text-muted-foreground/80">/ {fmt0(d.limit)}</span>
                    </div>
                    <Money value={fmt0(d.balance)} className="text-base font-extrabold" />
                    <div className="mt-1.5"><Bar pct={u} thin color={u > 80 ? '#f87171' : u > 30 ? '#fbbf24' : '#34d399'} /></div>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
        </Link>
        <Link href="/budgets" className="group block min-w-0">
        <Card className="min-w-0 cursor-pointer p-5 transition hover:border-primary/40 hover:bg-secondary/[0.12]">
          <SectionHead title="Budgets" desc={`${ymLabel(nowYm)} spending by category`} chevron />
          <div className="mt-2 max-h-64 divide-y divide-border/60 overflow-y-auto">
            {state.budgets.slice().sort((a, b) => spentIn(state, nowYm, b.id) - spentIn(state, nowYm, a.id)).slice(0, 7).map((b) => {
              const sp = spentIn(state, nowYm, b.id)
              const pct = b.limit ? Math.min(100, Math.round((sp / b.limit) * 100)) : Math.round((sp / maxSpent) * 100)
              const over = b.limit > 0 && sp > b.limit
              return (
                <div key={b.id} className="py-2">
                  <div className="mb-1.5 flex min-w-0 justify-between gap-2 text-xs">
                    <span className="flex min-w-0 flex-1 items-center gap-1.5 truncate text-foreground/90"><CatIcon cat={b.id} className="h-3.5 w-3.5 shrink-0" />{b.name}</span>
                    <span className={`shrink-0 whitespace-nowrap ${over ? 'font-semibold text-red-400' : 'text-muted-foreground'}`}>{fmt0(sp)} <span className="opacity-60">/ {b.limit ? fmt0(b.limit) : '—'}</span></span>
                  </div>
                  <Bar pct={pct} color={over ? '#f87171' : catColor(b.id)} />
                </div>
              )
            })}
          </div>
        </Card>
        </Link>
      </div>
    </div>
  )
}
