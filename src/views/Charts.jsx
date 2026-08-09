'use client'
import { useEffect, useMemo, useState } from 'react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, ReferenceLine } from 'recharts'
import { Card } from '@/components/ui/card'
import { SectionHead } from '@/components/shared'
import { useApp } from '@/store'
import { fmt0, ymLabel, monthLabel, prettyDate, catColor, srcLabel } from '@/lib/utils'
import { simulatePlan } from '@/lib/finance'
import { useIsMobile } from '@/lib/useMediaQuery'
import { useT } from '@/lib/i18n'

const TIP = {
  contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 },
  labelStyle: { color: '#dbe4f5', fontWeight: 700, marginBottom: 2 },
  itemStyle: { color: '#dbe4f5' },
}
const kfmt = (v) => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k' : v)

export default function Charts({ focus } = {}) {
  const { state, catInfo } = useApp()
  const isMobile = useIsMobile()
  const t = useT()
  const noTr = useMemo(() => state.transactions.filter((t) => t.cat !== 'transfer'), [state.transactions])

  // Deep-link support for /charts?focus=income|spending (Dashboard's "Avg
  // Monthly Income"/"Avg Monthly Spending" KPIs link here) — scrolls the
  // matching card into view and gives it a brief highlight ring, same
  // Suspense+useSearchParams pattern app/(app)/transactions/page.jsx already
  // uses for its own deep links.
  const [highlight, setHighlight] = useState(focus || null)
  useEffect(() => {
    if (!focus) return
    setHighlight(focus)
    const el = document.getElementById(`chart-${focus}`)
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' })
    const t = setTimeout(() => setHighlight(null), 2200)
    return () => clearTimeout(t)
  }, [focus])

  // 1. cumulative net
  const cum = useMemo(() => {
    const byDay = {}
    noTr.forEach((t) => { byDay[t.date] = (byDay[t.date] || 0) + (t.type === 'income' ? t.amount : -t.amount) })
    let run = 0
    return Object.keys(byDay).sort().map((d) => { run += byDay[d]; return { name: prettyDate(d), total: +run.toFixed(2) } })
  }, [noTr])

  // 2. stacked categories by month
  const months = useMemo(() => [...new Set(noTr.map((t) => t.date.slice(0, 7)))].sort(), [noTr])

  // 1b/1c. income by month & spending by month, last 12 months (transfers
  // excluded, same "expense/income" definition store.jsx's incomeIn/
  // expensesIn use — Dashboard's Avg Monthly Income/Spending KPIs are
  // computed from those same two functions, so the totals shown here line
  // up with what the KPI links promise).
  const last12 = months.slice(-12)
  const incomeByMonth = useMemo(() => last12.map((m) => ({
    name: ymLabel(m),
    total: Math.round(noTr.filter((t) => t.type === 'income' && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0)),
  })), [noTr, months.join(',')])
  const spendByMonth = useMemo(() => last12.map((m) => ({
    name: ymLabel(m),
    total: Math.round(noTr.filter((t) => t.type === 'expense' && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0)),
  })), [noTr, months.join(',')])
  const catTotals = {}
  noTr.forEach((t) => { if (t.type === 'expense' && t.cat !== 'debt') catTotals[t.cat] = (catTotals[t.cat] || 0) + t.amount })
  const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0])
  const everythingElseLabel = t('Everything else')
  const stack = months.map((m) => {
    const row = { name: ymLabel(m) }
    topCats.forEach((c) => { row[catInfo(c).name] = Math.round(noTr.filter((t) => t.type === 'expense' && t.cat === c && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0)) })
    row[everythingElseLabel] = Math.round(noTr.filter((t) => t.type === 'expense' && t.cat !== 'debt' && !topCats.includes(t.cat) && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0))
    return row
  })

  // 3. top merchants
  const merch = {}
  noTr.forEach((t) => { if (t.type === 'expense' && t.cat !== 'debt') { const k = srcLabel(t.desc); merch[k] = (merch[k] || 0) + t.amount } })
  const topM = Object.entries(merch).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => ({ name: k.length > 22 ? k.slice(0, 22) + '…' : k, total: Math.round(v) }))
  const MCOLORS = ['#f472b6', '#fb923c', '#fbbf24', '#4ade80', '#22d3ee', '#818cf8', '#a78bfa', '#fb7185']

  // 4. debt breakdown
  const dd = state.debts.filter((d) => d.balance > 0).sort((a, b) => b.balance - a.balance).map((d) => ({ name: d.name, value: Math.round(d.balance) }))
  const DCOLORS = ['#f87171', '#fb923c', '#fbbf24', '#facc15', '#4ade80', '#2dd4bf', '#22d3ee', '#818cf8', '#a78bfa', '#e879f9', '#f472b6']

  // 5. payoff projection
  const plan = useMemo(() => simulatePlan(state.debts, state.sim.budget, state.sim.strategy), [state.debts, state.sim])
  const proj = plan.hist.map((v, i) => { const d = new Date(); d.setMonth(d.getMonth() + i); return { name: monthLabel(d), balance: Math.round(v) } })

  return (
    <div className="fade-in grid gap-3 lg:grid-cols-2">
      <Card className="p-5">
        <SectionHead title={t('Running Total')} desc={t('Every dollar in minus every dollar out, day by day (all data, transfers excluded)')} />
        <div className="mt-4 h-56">
          <ResponsiveContainer>
            <LineChart data={cum}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} formatter={(v) => fmt0(v)} />
              <ReferenceLine y={0} stroke="#3f3f46" />
              <Line type="monotone" dataKey="total" stroke="#10b981" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card id="chart-income" className={`p-5 transition ${highlight === 'income' ? 'ring-2 ring-emerald-400/60' : ''}`}>
        <SectionHead title={t('Income by Month')} desc={t('Last 12 months, from transactions (transfers excluded)')} />
        <div className="mt-4 h-56">
          <ResponsiveContainer>
            <BarChart data={incomeByMonth} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} interval={isMobile ? 'preserveStartEnd' : 0} minTickGap={isMobile ? 24 : 5} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} width={isMobile ? 34 : 44} />
              <Tooltip {...TIP} cursor={{ fill: '#ffffff08' }} formatter={(v) => fmt0(v)} />
              <Bar dataKey="total" fill="#34d399" radius={[5, 5, 0, 0]} maxBarSize={36} style={{ filter: 'drop-shadow(0 0 4px rgba(52,211,153,0.35))' }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card id="chart-spending" className={`p-5 transition ${highlight === 'spending' ? 'ring-2 ring-red-400/60' : ''}`}>
        <SectionHead title={t('Spending by Month')} desc={t('Last 12 months, from transactions (transfers excluded)')} />
        <div className="mt-4 h-56">
          <ResponsiveContainer>
            <BarChart data={spendByMonth} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} interval={isMobile ? 'preserveStartEnd' : 0} minTickGap={isMobile ? 24 : 5} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} width={isMobile ? 34 : 44} />
              <Tooltip {...TIP} cursor={{ fill: '#ffffff08' }} formatter={(v) => fmt0(v)} />
              <Bar dataKey="total" fill="#e0655f" radius={[5, 5, 0, 0]} maxBarSize={36} style={{ filter: 'drop-shadow(0 0 4px rgba(224,101,95,0.35))' }} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="p-5">
        <SectionHead title={t('Spending by Category per Month')} desc={t('Your biggest categories, stacked (debt payments excluded)')} />
        <div className="mt-4 h-56">
          <ResponsiveContainer>
            <BarChart data={stack}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} cursor={{ fill: '#ffffff08' }} formatter={(v) => fmt0(v)} />
              <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => <span style={{ color: '#a1a1aa' }}>{v}</span>} />
              {topCats.map((c) => <Bar key={c} dataKey={catInfo(c).name} stackId="a" fill={catColor(c)} maxBarSize={40} />)}
              <Bar dataKey={everythingElseLabel} stackId="a" fill="#3f3f46" maxBarSize={40} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="p-5">
        <SectionHead title={t('Top Places Your Money Goes')} desc={t('Biggest merchants across all data (debt payments excluded)')} />
        <div className="mt-4 h-64">
          <ResponsiveContainer>
            <BarChart data={topM} layout="vertical">
              <XAxis type="number" tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="name" width={isMobile ? 105 : 150} tick={{ fill: '#a1a1aa', fontSize: 10.5 }} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} cursor={{ fill: '#ffffff08' }} formatter={(v) => fmt0(v)} />
              <Bar dataKey="total" maxBarSize={20} radius={[0, 4, 4, 0]}>
                {topM.map((_, i) => <Cell key={i} fill={MCOLORS[i % MCOLORS.length]} />)}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="p-5">
        <SectionHead title={t('Debt Breakdown')} desc={t('Who you owe, by balance')} />
        <div className="mt-4 h-48 sm:h-64">
          <ResponsiveContainer>
            <PieChart>
              <Pie data={dd} dataKey="value" nameKey="name" innerRadius="58%" outerRadius="88%" paddingAngle={2} stroke="hsl(221 55% 8%)">
                {dd.map((_, i) => <Cell key={i} fill={DCOLORS[i % DCOLORS.length]} />)}
              </Pie>
              <Tooltip {...TIP} formatter={(v) => fmt0(v)} />
              {!isMobile && <Legend layout="vertical" align="right" verticalAlign="middle" wrapperStyle={{ fontSize: 10 }} formatter={(v) => <span style={{ color: '#a1a1aa' }}>{v}</span>} />}
            </PieChart>
          </ResponsiveContainer>
        </div>
        {isMobile && (
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[0.6875rem]">
            {dd.map((d, i) => (
              <span key={d.name} className="flex min-w-0 items-center gap-1.5">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: DCOLORS[i % DCOLORS.length] }} />
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{d.name}</span>
              </span>
            ))}
          </div>
        )}
      </Card>
      <Card className="p-5 lg:col-span-2">
        <SectionHead title={t('Debt Payoff Projection')} desc={t('Total debt over time at your current plan ({budget}/mo, {strategy})', { budget: fmt0(state.sim.budget), strategy: state.sim.strategy })} />
        <div className="mt-4 h-64">
          <ResponsiveContainer>
            <LineChart data={proj}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} formatter={(v) => t('{amount} left', { amount: fmt0(v) })} />
              <Line type="monotone" dataKey="balance" stroke="#38bdf8" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  )
}
