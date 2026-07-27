'use client'
import { useMemo, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import { TrendingUp, TrendingDown, CreditCard, CalendarDays, X, Lightbulb } from 'lucide-react'
import { BarChart, Bar as RBar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend } from 'recharts'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { SectionHead, Kpi, MoneyTile, CatIcon, Bar } from '@/components/shared'
import { useApp, monthTx, rangeTx, incomeIn, expensesIn, spentIn, dataMonths } from '@/store'
import { fmt, fmt0, today, isoDate, ymLabel, monthLabel, prettyDate, catColor, srcLabel } from '@/lib/utils'
import { simulatePlan, recMonthly, nextDueDate } from '@/lib/finance'
import { useIsMobile } from '@/lib/useMediaQuery'

const TIP = {
  contentStyle: { background: 'hsl(240 6% 9%)', border: '1px solid hsl(240 6% 16%)', borderRadius: 8, fontSize: 12 },
  labelStyle: { color: '#d4d4d8', fontWeight: 600, marginBottom: 2 },
  itemStyle: { color: '#e4e4e7' },
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
  state.debts.forEach((d) => { if (d.balance > 0 && d.dueDay) { const dt = nextDueDate(d.dueDay); const diff = Math.round((dt - now0) / 864e5); if (diff <= 14) up.push({ name: d.name, amt: d.min, diff, tag: 'debt' }) } })
  state.recurring.forEach((r) => {
    if (r.active === false) return
    let dt = null
    if ((r.every || 1) > 1) { if (r.nextDate) dt = new Date(r.nextDate + 'T00:00:00') } else if (r.dueDay) dt = nextDueDate(r.dueDay)
    if (!dt) return
    const diff = Math.round((dt - now0) / 864e5)
    if (diff >= 0 && diff <= 14) up.push({ name: r.desc, amt: r.amount, diff, tag: 'bill' })
  })
  up.sort((a, b) => a.diff - b.diff)

  const cards = state.debts.filter((d) => d.limit)
  const ccLimit = cards.reduce((s, d) => s + d.limit, 0), ccBal = cards.reduce((s, d) => s + d.balance, 0)
  const ccUtil = ccLimit ? Math.round((ccBal / ccLimit) * 100) : 0

  const maxSpent = Math.max(1, ...state.budgets.map((b) => spentIn(state, nowYm, b.id)))

  return (
    <div className="fade-in space-y-4">
      {firstName && (
        <div>
          <h2 className="text-xl font-bold tracking-tight">{es ? 'Bienvenido' : 'Welcome'}, {firstName} 👋</h2>
          <p className="mt-0.5 text-xs text-muted-foreground">{es ? 'Así va tu dinero hoy.' : 'Here is where your money stands today.'}</p>
        </div>
      )}
      {/* Cash flow */}
      <Card className="p-5">
        <div className="flex flex-wrap items-center gap-3">
          <div className="mr-auto"><SectionHead title={`Cash Flow · ${B.label}`} desc="Money in minus money out · transfers between your own accounts don't count" /></div>
          <Segmented
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
          <MoneyTile label="Money In" value={fmt0(rIn)} tone="green" active={cfView === 'in'} hint={cfView === 'in' ? 'hide breakdown ▴' : 'where from? ▾'} onClick={() => setCfView(cfView === 'in' ? null : 'in')} />
          <MoneyTile label="Money Out" value={fmt0(rOut)} tone="red" active={cfView === 'out'} hint={cfView === 'out' ? 'hide breakdown ▴' : 'where to? ▾'} onClick={() => setCfView(cfView === 'out' ? null : 'out')} />
          <MoneyTile label={rNet >= 0 ? 'Left Over' : 'In The Negative'} value={(rNet >= 0 ? '' : '−') + fmt0(Math.abs(rNet))} tone={rNet >= 0 ? 'green' : 'red'} />
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
                <div key={r.label} className="flex items-center gap-3 py-2 text-[13px]">
                  {r.cat && <CatIcon cat={r.cat} className="h-3.5 w-3.5 shrink-0" />}
                  <span className="min-w-0 flex-1 truncate text-foreground/90 sm:w-56 sm:flex-none">{r.label}</span>
                  <div className="track hidden flex-1 sm:block"><div style={{ width: `${Math.round((r.sum / bTot) * 100)}%`, background: r.color }} /></div>
                  <span className="hidden w-16 shrink-0 text-right text-[11px] text-muted-foreground sm:inline">{r.n}× · {Math.round((r.sum / bTot) * 100)}%</span>
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
                className={`-mx-2 flex w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-2 text-[11.5px] transition sm:gap-3 sm:text-[13px] ${on ? 'bg-emerald-400/[0.07] ring-1 ring-emerald-400/25' : 'hover:bg-secondary/50'}`}
              >
                <span className={`w-14 shrink-0 whitespace-nowrap text-left font-medium sm:w-24 ${on ? 'text-emerald-300' : ''}`}>
                  {ymLabel(m)}{m === nowYm && <span className="hidden text-[10px] text-muted-foreground sm:inline"> · so far</span>}
                </span>
                <span className="flex-1 whitespace-nowrap text-right text-emerald-400">+{fmt0(inc)}</span>
                <span className="flex-1 whitespace-nowrap text-right text-red-400">−{fmt0(ex)}</span>
                <span className={`w-16 shrink-0 whitespace-nowrap text-right font-bold sm:w-28 ${net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{net >= 0 ? '+' : '−'}{fmt0(Math.abs(net))}</span>
              </button>
            )
          })}
          <div className="flex items-center gap-2 pt-2 text-[10px] text-muted-foreground sm:gap-3 sm:text-[11px]">
            <span className="w-14 shrink-0 sm:w-24">tap a month ↑</span><span className="flex-1 whitespace-nowrap text-right">money in</span><span className="flex-1 whitespace-nowrap text-right">money out</span><span className="w-16 shrink-0 text-right sm:w-28">left over</span>
          </div>
        </div>
      </Card>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Avg Monthly Income" value={fmt0(avgIncome)} icon={TrendingUp} tone="text-emerald-400" sub={`${ymLabel(nowYm)} so far: ${fmt0(incomeIn(state, nowYm))}`} />
        <Kpi label="Avg Monthly Spending" value={fmt0(avgExp)} icon={TrendingDown} sub={`${ymLabel(nowYm)} so far: ${fmt0(expensesIn(state, nowYm))}`} />
        <Kpi label="Total Debt" value={fmt0(totalDebt)} icon={CreditCard} tone="text-red-400" sub={plan.done ? `debt-free ${monthLabel(plan.end)} on your plan` : ''} />
        <Kpi label="Fixed Monthly Payments" value={fmt0(mins + recTotal)} icon={CalendarDays} sub={`${fmt0(mins)} debt + ${fmt0(recTotal)} bills`} />
      </div>

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
                <RBar dataKey="Income" fill="#10b981" radius={[5, 5, 0, 0]} maxBarSize={36} />
                <RBar dataKey="Spending" fill="#3f3f46" radius={[5, 5, 0, 0]} maxBarSize={36} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Card>
        <Card className="p-5">
          <SectionHead title="This Month by Category" desc={ymLabel(nowYm)} />
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
          {isMobile && (
            <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11px]">
              {donut.map((d) => (
                <span key={d.name} className="flex min-w-0 items-center gap-1.5">
                  <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: d.color }} />
                  <span className="truncate text-muted-foreground">{d.name}</span>
                </span>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* bottom widgets */}
      <div className="grid gap-3 lg:grid-cols-3">
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <SectionHead title="Due in 14 days" />
            <Badge>{fmt0(up.reduce((s, u) => s + (u.amt || 0), 0))}</Badge>
          </div>
          <div className="max-h-64 divide-y divide-border/60 overflow-y-auto">
            {up.length ? up.map((u, i) => (
              <div key={i} className="flex items-center gap-2.5 py-2 text-[13px]">
                <span className={`w-11 shrink-0 rounded-md px-1 py-1 text-center text-[10px] font-bold ${u.diff <= 3 ? 'bg-red-400/10 text-red-400' : 'bg-secondary text-muted-foreground'}`}>
                  {u.diff === 0 ? 'today' : `in ${u.diff}d`}
                </span>
                <span className="flex-1 truncate text-foreground/90">{u.name}</span>
                <Badge variant={u.tag === 'debt' ? 'destructive' : 'info'}>{u.tag}</Badge>
                <span className="shrink-0 text-xs font-semibold">{u.amt ? fmt(u.amt) : ''}</span>
              </div>
            )) : <p className="py-2 text-[13px] text-muted-foreground">Nothing due in the next two weeks.</p>}
          </div>
        </Card>
        <Card className="p-5">
          <div className="mb-3 flex items-center justify-between">
            <SectionHead title="Credit Cards" />
            <Badge variant={ccUtil > 80 ? 'destructive' : ccUtil > 30 ? 'warning' : 'success'}>{ccUtil}% used</Badge>
          </div>
          <div className="max-h-64 divide-y divide-border/60 overflow-y-auto">
            {cards.map((d) => {
              const u = Math.min(100, Math.round((d.balance / d.limit) * 100))
              return (
                <div key={d.name} className="py-2">
                  <div className="mb-1.5 flex justify-between text-xs">
                    <span className="truncate text-foreground/90">{d.name}</span>
                    <span className="shrink-0 text-muted-foreground">{fmt0(d.balance)} <span className="opacity-60">/ {fmt0(d.limit)}</span></span>
                  </div>
                  <Bar pct={u} color={u > 80 ? '#f87171' : u > 30 ? '#fbbf24' : '#34d399'} />
                </div>
              )
            })}
          </div>
        </Card>
        <Card className="p-5">
          <SectionHead title="Budgets" desc={`${ymLabel(nowYm)} spending by category`} />
          <div className="mt-2 max-h-64 divide-y divide-border/60 overflow-y-auto">
            {state.budgets.slice().sort((a, b) => spentIn(state, nowYm, b.id) - spentIn(state, nowYm, a.id)).slice(0, 7).map((b) => {
              const sp = spentIn(state, nowYm, b.id)
              const pct = b.limit ? Math.min(100, Math.round((sp / b.limit) * 100)) : Math.round((sp / maxSpent) * 100)
              const over = b.limit > 0 && sp > b.limit
              return (
                <div key={b.id} className="py-2">
                  <div className="mb-1.5 flex justify-between text-xs">
                    <span className="flex items-center gap-1.5 truncate text-foreground/90"><CatIcon cat={b.id} className="h-3.5 w-3.5 shrink-0" />{b.name}</span>
                    <span className={`shrink-0 ${over ? 'font-semibold text-red-400' : 'text-muted-foreground'}`}>{fmt0(sp)} <span className="opacity-60">/ {b.limit ? fmt0(b.limit) : '—'}</span></span>
                  </div>
                  <Bar pct={pct} color={over ? '#f87171' : catColor(b.id)} />
                </div>
              )
            })}
          </div>
        </Card>
      </div>
    </div>
  )
}
