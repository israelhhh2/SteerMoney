'use client'
import { useMemo } from 'react'
import { LineChart, Line, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, ReferenceLine } from 'recharts'
import { Card } from '@/components/ui/card'
import { SectionHead } from '@/components/shared'
import { useApp } from '@/store'
import { fmt0, ymLabel, monthLabel, prettyDate, catColor, srcLabel } from '@/lib/utils'
import { simulatePlan } from '@/lib/finance'
import { useIsMobile } from '@/lib/useMediaQuery'

const TIP = {
  contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 },
  labelStyle: { color: '#dbe4f5', fontWeight: 700, marginBottom: 2 },
  itemStyle: { color: '#dbe4f5' },
}
const kfmt = (v) => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k' : v)

export default function Charts() {
  const { state, catInfo } = useApp()
  const isMobile = useIsMobile()
  const noTr = useMemo(() => state.transactions.filter((t) => t.cat !== 'transfer'), [state.transactions])

  // 1. cumulative net
  const cum = useMemo(() => {
    const byDay = {}
    noTr.forEach((t) => { byDay[t.date] = (byDay[t.date] || 0) + (t.type === 'income' ? t.amount : -t.amount) })
    let run = 0
    return Object.keys(byDay).sort().map((d) => { run += byDay[d]; return { name: prettyDate(d), total: +run.toFixed(2) } })
  }, [noTr])

  // 2. stacked categories by month
  const months = useMemo(() => [...new Set(noTr.map((t) => t.date.slice(0, 7)))].sort(), [noTr])
  const catTotals = {}
  noTr.forEach((t) => { if (t.type === 'expense' && t.cat !== 'debt') catTotals[t.cat] = (catTotals[t.cat] || 0) + t.amount })
  const topCats = Object.entries(catTotals).sort((a, b) => b[1] - a[1]).slice(0, 6).map((e) => e[0])
  const stack = months.map((m) => {
    const row = { name: ymLabel(m) }
    topCats.forEach((c) => { row[catInfo(c).name] = Math.round(noTr.filter((t) => t.type === 'expense' && t.cat === c && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0)) })
    row['Everything else'] = Math.round(noTr.filter((t) => t.type === 'expense' && t.cat !== 'debt' && !topCats.includes(t.cat) && t.date.startsWith(m)).reduce((s, t) => s + t.amount, 0))
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
        <SectionHead title="Running Total" desc="Every dollar in minus every dollar out, day by day (all data, transfers excluded)" />
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
      <Card className="p-5">
        <SectionHead title="Spending by Category per Month" desc="Your biggest categories, stacked (debt payments excluded)" />
        <div className="mt-4 h-56">
          <ResponsiveContainer>
            <BarChart data={stack}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 11 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} cursor={{ fill: '#ffffff08' }} formatter={(v) => fmt0(v)} />
              <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => <span style={{ color: '#a1a1aa' }}>{v}</span>} />
              {topCats.map((c) => <Bar key={c} dataKey={catInfo(c).name} stackId="a" fill={catColor(c)} maxBarSize={40} />)}
              <Bar dataKey="Everything else" stackId="a" fill="#3f3f46" maxBarSize={40} radius={[3, 3, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="p-5">
        <SectionHead title="Top Places Your Money Goes" desc="Biggest merchants across all data (debt payments excluded)" />
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
        <SectionHead title="Debt Breakdown" desc="Who you owe, by balance" />
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
                <span className="truncate text-muted-foreground">{d.name}</span>
              </span>
            ))}
          </div>
        )}
      </Card>
      <Card className="p-5 lg:col-span-2">
        <SectionHead title="Debt Payoff Projection" desc={`Total debt over time at your current plan (${fmt0(state.sim.budget)}/mo, ${state.sim.strategy})`} />
        <div className="mt-4 h-64">
          <ResponsiveContainer>
            <LineChart data={proj}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} />
              <Tooltip {...TIP} formatter={(v) => fmt0(v) + ' left'} />
              <Line type="monotone" dataKey="balance" stroke="#38bdf8" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </Card>
    </div>
  )
}
