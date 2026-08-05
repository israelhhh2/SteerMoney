'use client'
import { useEffect, useMemo, useState } from 'react'
import { CreditCard, CalendarDays, CheckCircle2, Target, ChevronRight, Pencil, X, Flame, Snowflake, Plus, DollarSign, Search, Lightbulb, Landmark } from 'lucide-react'
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Segmented } from '@/components/ui/segmented'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { SectionHead, Kpi, StatTile, Bar } from '@/components/shared'
import { useApp } from '@/store'
import { useToast } from '@/components/toast'
import { fmt, fmt0, today, monthLabel, prettyDate, uid } from '@/lib/utils'
import { simulatePlan, simCardPlan, parseAPR, payoffMonths, fmtMonths, matchesBankAccount } from '@/lib/finance'

const TIP = {
  contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 },
  labelStyle: { color: '#dbe4f5', fontWeight: 700, marginBottom: 2 },
  itemStyle: { color: '#dbe4f5' },
}

export default function Debts() {
  const { state, update } = useApp()
  const toast = useToast()
  const [minsOpen, setMinsOpen] = useState(false)
  const [snowOpen, setSnowOpen] = useState(false)
  const [openDebt, setOpenDebt] = useState(null)
  const [editIdx, setEditIdx] = useState(undefined) // undefined closed · -1 new · i edit
  const [view, setView] = useState({ sort: 'balance', dir: 'desc', filter: 'all', q: '' })
  const [plaidAccounts, setPlaidAccounts] = useState([])

  // Silently probe connected banks so debt cards can badge "Bank connected"
  // vs "Manual entry" — no accounts just means nothing badges.
  useEffect(() => {
    let on = true
    fetch('/api/plaid/items')
      .then((r) => r.json())
      .then((d) => {
        if (!on) return
        setPlaidAccounts((d.items || []).flatMap((it) => (it.accounts || []).map((a) => ({ ...a, institution: it.institution }))))
      })
      .catch(() => {})
    return () => { on = false }
  }, [])

  const total = state.debts.reduce((s, d) => s + d.balance, 0)
  const mins = state.debts.reduce((s, d) => s + d.min, 0)
  const sim = state.sim
  const plan = useMemo(() => simulatePlan(state.debts, sim.budget, sim.strategy), [state.debts, sim.budget, sim.strategy])
  const baseline = useMemo(() => simulatePlan(state.debts, mins, sim.strategy), [state.debts, mins, sim.strategy])
  const saved = baseline.done && plan.done ? baseline.totalInterest - plan.totalInterest : null
  const belowMin = sim.budget < Math.round(mins)
  const payoffList = Object.entries(plan.payoffs).sort((a, b) => a[1] - b[1])
  const paidThisMonth = state.debts.reduce((s, d) => s + (d.payments || []).filter((p) => p.date.startsWith(today().slice(0, 7))).reduce((x, p) => x + p.amount, 0), 0)

  // snowball
  const extra = sim.snowExtra || 0
  const snow = useMemo(() => simulatePlan(state.debts, mins + extra, 'snowball'), [state.debts, mins, extra])
  const snowBase = useMemo(() => simulatePlan(state.debts, mins, 'snowball'), [state.debts, mins])
  const snowSaved = snow.done && snowBase.done ? snowBase.totalInterest - snow.totalInterest : null
  const active = state.debts.filter((d) => d.balance > 0).sort((a, b) => a.balance - b.balance)
  let rolled = extra
  const steps = active.map((d) => { const pay = d.min + rolled; rolled += d.min; return { d, pay, when: snow.payoffs[d.name] } })

  // list filters
  let list = state.debts.map((d, i) => ({ d, i }))
  if (view.filter === 'cards') list = list.filter((x) => x.d.limit)
  else if (view.filter === 'loans') list = list.filter((x) => !x.d.limit)
  else if (view.filter === 'promo') list = list.filter((x) => parseAPR(x.d.apr) === 0 || /promo/i.test(x.d.apr || ''))
  else if (view.filter === 'highapr') list = list.filter((x) => parseAPR(x.d.apr) >= 0.2)
  if (view.q) list = list.filter((x) => x.d.name.toLowerCase().includes(view.q.toLowerCase()))
  const key = (x) => ({ apr: parseAPR(x.d.apr), min: x.d.min, util: x.d.limit ? x.d.balance / x.d.limit : -1, due: x.d.dueDay || 99 }[view.sort] ?? x.d.balance)
  list.sort((a, b) => (view.dir === 'asc' ? key(a) - key(b) : key(b) - key(a)))

  const setSim = (patch) => update((s) => Object.assign(s.sim, patch))

  const submitPayment = (i, amt, date, note) => {
    if (!amt || amt <= 0) return toast('Enter a payment amount', 'error')
    update((s) => {
      const d = s.debts[i]
      d.balance = Math.max(0, +(d.balance - amt).toFixed(2))
      d.payments = d.payments || []
      d.payments.unshift({ date, amount: amt, note: note || '' })
      s.transactions.unshift({ id: uid('tx'), date, desc: d.name + ' payment', amount: amt, type: 'expense', cat: 'debt' })
      s.transactions.sort((a, b) => b.date.localeCompare(a.date))
    })
    toast('Payment logged')
  }

  const hist = plan.hist.filter((_, i) => i % Math.max(1, Math.floor(plan.hist.length / 60)) === 0).map((v, i, arr) => {
    const d = new Date(); d.setMonth(d.getMonth() + Math.round((i * plan.hist.length) / arr.length))
    return { name: monthLabel(d), balance: Math.round(v) }
  })

  return (
    <div className="fade-in space-y-6">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Total Debt" value={fmt(total)} tone="text-red-400" icon={CreditCard} />
        <button onClick={() => setMinsOpen(!minsOpen)} className="text-left" title="See how this adds up">
          <Kpi label="Minimums Due / mo" value={fmt(mins)} tone="text-amber-400" icon={CalendarDays} sub={<span className="text-primary">{minsOpen ? 'hide the math ▴' : 'how? ▾'}</span>} />
        </button>
        <Kpi label="Paid This Month" value={fmt(paidThisMonth)} tone="text-emerald-400" icon={CheckCircle2} />
        <Kpi label="Debt-free By" value={plan.done ? monthLabel(plan.end) : 'Never at this rate'} tone={plan.done ? 'text-foreground' : 'text-red-400'} icon={Target} />
      </div>

      {minsOpen && (
        <Card className="p-4 fade-in">
          <div className="mb-2.5 flex items-center justify-between">
            <span className="text-xs font-semibold text-amber-300">How your {fmt(mins)}/mo minimum adds up · {state.debts.length} debts</span>
            <button onClick={() => setMinsOpen(false)} className="text-muted-foreground hover:text-foreground"><X className="h-3.5 w-3.5" /></button>
          </div>
          <div className="divide-y divide-border/60">
            {state.debts.slice().sort((a, b) => b.min - a.min).map((d) => (
              <div key={d.name} className="flex items-center gap-3 py-1.5 text-[0.8125rem]">
                <span className="flex-1 truncate text-foreground/90">{d.name}</span>
                {d.balance <= 0 && <Badge variant="success">paid off</Badge>}
                <span className="hidden shrink-0 text-[0.6875rem] text-muted-foreground sm:inline">bal {fmt0(d.balance)}</span>
                <span className="w-20 shrink-0 text-right font-semibold">{fmt(d.min)}</span>
              </div>
            ))}
            <div className="flex items-center gap-3 pt-2 text-[0.8125rem]">
              <span className="flex-1 font-semibold">Total</span>
              <span className="w-20 shrink-0 text-right font-bold text-amber-400">{fmt(mins)}</span>
            </div>
          </div>
        </Card>
      )}

      {/* Payoff simulator */}
      <Card className="p-5">
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="mr-auto"><SectionHead title="Payoff Simulator" desc="This is a sandbox — it never changes your real debts." /></div>
          <div>
            <Label>I'll pay toward debt / month</Label>
            <Input type="number" min="0" step="25" className="w-36 font-bold text-emerald-400" value={sim.budget} onChange={(e) => setSim({ budget: Math.max(0, parseFloat(e.target.value) || 0) })} />
          </div>
          <Segmented value={sim.strategy} onChange={(v) => setSim({ strategy: v })} options={[['avalanche', 'Avalanche'], ['snowball', 'Snowball']]} />
          <div className="flex flex-wrap gap-1.5">
            <Button variant="outline" size="sm" onClick={() => setSim({ budget: Math.round(mins) })}>Minimums ({fmt0(mins)})</Button>
            {[100, 250, 500].map((x) => (
              <Button key={x} variant="outline" size="sm" onClick={() => setSim({ budget: Math.round(mins) + x })}>Mins +${x}</Button>
            ))}
          </div>
        </div>
        <div className="mb-4 rounded-lg border bg-secondary/40 px-3.5 py-3 text-[0.78125rem] leading-relaxed text-foreground/85">
          <Lightbulb className="mr-1 inline h-4 w-4 text-amber-300" /> <b>How to read this:</b> your {state.debts.length} debts require <b className="text-amber-400">{fmt(mins)}/mo</b> in minimum payments combined. The simulator asks: <i>"what if I put <b className="text-emerald-400">{fmt(sim.budget)}</b> toward debt every month instead?"</i> Anything above the minimums gets thrown at one debt at a time until everything is gone.
        </div>
        {belowMin && (
          <div className="mb-4 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-2.5 text-xs text-red-300">
            You're simulating {fmt(sim.budget)}/mo, but that's LESS than your {fmt(mins)} combined minimums — balances would grow. Tap "Minimums" to start from reality.
          </div>
        )}
        <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
          <StatTile label="Debt-free by" value={plan.done ? monthLabel(plan.end) : 'Never at this rate'} tone={plan.done ? 'text-emerald-400' : 'text-red-400'} />
          <StatTile label="Time to payoff" value={plan.done ? fmtMonths(plan.months) : '50+ yrs'} />
          <StatTile label="Total interest" value={fmt(plan.totalInterest)} tone="text-amber-400" />
          <StatTile label="vs. minimums only" value={saved != null && saved > 0 ? 'save ' + fmt0(saved) : '—'} tone={saved > 0 ? 'text-emerald-400' : 'text-muted-foreground'} sub={baseline.done && plan.done && baseline.months > plan.months ? fmtMonths(baseline.months - plan.months) + ' sooner' : ''} highlight={saved > 0} />
        </div>
        <div className="grid gap-5 lg:grid-cols-5">
          <div className="h-56 lg:col-span-3">
            <ResponsiveContainer>
              <LineChart data={hist}>
                <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} interval="preserveStartEnd" />
                <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={(v) => '$' + (v >= 1000 ? v / 1000 + 'k' : v)} axisLine={false} tickLine={false} />
                <Tooltip {...TIP} formatter={(v) => fmt0(v)} />
                <Line type="monotone" dataKey="balance" stroke="#38bdf8" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="lg:col-span-2">
            <div className="mb-2 text-[0.65625rem] font-medium uppercase tracking-wider text-muted-foreground">Payoff order ({sim.strategy})</div>
            <div className="max-h-52 divide-y divide-border/60 overflow-y-auto pr-1">
              {payoffList.length ? payoffList.map(([n, d], idx) => (
                <div key={n} className="flex items-center gap-2.5 py-1.5 text-[0.8125rem]">
                  <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-md bg-secondary text-[0.65625rem] font-bold text-muted-foreground">{idx + 1}</span>
                  <span className="flex-1 truncate text-foreground/90">{n}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{monthLabel(d)}</span>
                </div>
              )) : <p className="text-[0.8125rem] text-muted-foreground">Nothing pays off within 50 years at this payment.</p>}
            </div>
          </div>
        </div>
      </Card>

      {/* Snowball — collapsible */}
      <Card className={snowOpen ? 'p-5' : 'px-5 py-3.5'}>
        <button onClick={() => setSnowOpen(!snowOpen)} className="flex w-full items-center gap-2.5 text-left">
          <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${snowOpen ? 'rotate-90' : ''}`} />
          <span className="text-[0.8125rem] font-semibold">Snowball Simulator</span>
          {!snowOpen && (
            <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">
              smallest first, payments roll over{extra ? ` · +${fmt0(extra)}/mo extra` : ''} · debt-free {snow.done ? monthLabel(snow.end) : '—'}
            </span>
          )}
          <span className="ml-auto shrink-0 text-[0.6875rem] font-medium text-primary">{snowOpen ? 'Collapse' : 'Open'}</span>
        </button>
        {snowOpen && (
          <div className="mt-4 fade-in">
            <div className="mb-4 flex flex-wrap items-end gap-3">
              <div className="mr-auto"><SectionHead desc="Smallest debt first. Knock one out, roll its payment into the next — watch the payment grow." /></div>
              <div>
                <Label>Extra $ / month on top of minimums</Label>
                <Input type="number" min="0" step="25" className="w-36 font-bold text-emerald-400" value={extra} onChange={(e) => setSim({ snowExtra: Math.max(0, parseFloat(e.target.value) || 0) })} />
              </div>
              <div className="flex gap-1.5">
                {[0, 100, 250, 500].map((x) => (
                  <Button key={x} variant={extra === x ? 'secondary' : 'outline'} size="sm" onClick={() => setSim({ snowExtra: x })}>{x ? `+$${x}` : 'None'}</Button>
                ))}
              </div>
            </div>
            <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
              <StatTile label="Debt-free by" value={snow.done ? monthLabel(snow.end) : 'Never at this rate'} tone={snow.done ? 'text-emerald-400' : 'text-red-400'} />
              <StatTile label="Total time" value={snow.done ? fmtMonths(snow.months) : '50+ yrs'} />
              <StatTile label="Total interest" value={fmt0(snow.totalInterest)} tone="text-amber-400" />
              <StatTile label="Extra $ saves you" value={snowSaved > 0 ? fmt0(snowSaved) + ' interest' : '—'} tone={snowSaved > 0 ? 'text-emerald-400' : 'text-muted-foreground'} sub={snowBase.done && snow.done && snowBase.months > snow.months ? fmtMonths(snowBase.months - snow.months) + ' sooner' : ''} highlight={snowSaved > 0} />
            </div>
            <div className="divide-y divide-border/60">
              {steps.map((s, ix) => (
                <div key={s.d.name} className="flex items-center gap-3 py-2.5 text-[0.8125rem]">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-emerald-400/10 text-[0.6875rem] font-bold text-emerald-300">{ix + 1}</span>
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-medium">{s.d.name}</div>
                    <div className="text-[0.6875rem] text-muted-foreground">{fmt0(s.d.balance)} balance · min {fmt0(s.d.min)}</div>
                  </div>
                  <div className="hidden shrink-0 text-right sm:block">
                    <div className="text-xs font-semibold text-emerald-400">{fmt0(s.pay)}/mo attack</div>
                    <div className="text-[0.65625rem] text-muted-foreground">min + {fmt0(s.pay - s.d.min)} rolled in</div>
                  </div>
                  <div className="w-24 shrink-0 text-right">
                    <div className={`text-xs font-semibold ${s.when ? '' : 'text-red-400'}`}>{s.when ? monthLabel(s.when) : '—'}</div>
                    <div className="text-[0.65625rem] text-muted-foreground">paid off</div>
                  </div>
                  <span className={`shrink-0 ${ix < steps.length - 1 ? 'text-muted-foreground' : 'text-emerald-400'}`}>{ix < steps.length - 1 ? '↓' : '✓'}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>

      <ConsolidationCard />

      {/* list header + filters */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <h3 className="text-sm font-semibold tracking-tight">
          Your Debts <span className="text-xs font-normal text-muted-foreground">· {list.length} of {state.debts.length} · {fmt0(list.reduce((s, x) => s + x.d.balance, 0))} · click a card to make a payment</span>
        </h3>
        <Button size="sm" onClick={() => setEditIdx(-1)}><Plus />Add debt</Button>
      </div>
      <Card className="flex flex-wrap items-center gap-2 p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-44 pl-8" placeholder="Search debts…" value={view.q} onChange={(e) => setView({ ...view, q: e.target.value })} />
        </div>
        <Select className="text-xs" value={view.sort} onChange={(e) => setView({ ...view, sort: e.target.value })}>
          {Object.entries({ balance: 'Balance', apr: 'APR', min: 'Monthly payment', util: 'Utilization', due: 'Due day' }).map(([k, l]) => <option key={k} value={k}>Sort: {l}</option>)}
        </Select>
        <Button variant="outline" size="sm" className="px-2.5" onClick={() => setView({ ...view, dir: view.dir === 'desc' ? 'asc' : 'desc' })}>{view.dir === 'desc' ? '↓' : '↑'}</Button>
        <Segmented className="ml-auto" value={view.filter} onChange={(v) => setView({ ...view, filter: v })} options={[['all', 'All'], ['cards', 'Credit cards'], ['loans', 'Loans'], ['promo', '0% promo'], ['highapr', 'APR ≥ 20%']]} />
      </Card>

      <div className="grid gap-3 md:grid-cols-2">
        {list.map(({ d, i }) => (
          <DebtCard key={d.name + i} d={d} i={i} open={openDebt === d.name} plan={plan} total={total} plaidAccounts={plaidAccounts}
            onToggle={() => setOpenDebt(openDebt === d.name ? null : d.name)}
            onEdit={() => setEditIdx(i)}
            onDelete={() => { if (confirm(`Delete "${d.name}"?`)) { update((s) => { s.debts.splice(i, 1) }); toast('Debt deleted') } }}
            onPay={submitPayment}
            onDeletePayment={(pi) => update((s) => { const p = s.debts[i].payments.splice(pi, 1)[0]; s.debts[i].balance = +(s.debts[i].balance + p.amount).toFixed(2) })}
          />
        ))}
      </div>

      {editIdx !== undefined && <DebtDialog idx={editIdx} onClose={() => setEditIdx(undefined)} />}
    </div>
  )
}

function DebtCard({ d, i, open, plan, total, plaidAccounts, onToggle, onEdit, onDelete, onPay, onDeletePayment }) {
  const [amt, setAmt] = useState(d.min || '')
  const [date, setDate] = useState(today())
  const [note, setNote] = useState('')
  const util = d.limit ? Math.min(100, Math.round((d.balance / d.limit) * 100)) : null
  const pm = payoffMonths(d.balance, d.apr, d.min)
  const bankMatch = useMemo(() => matchesBankAccount(d, plaidAccounts), [d, plaidAccounts])
  const planDate = plan.payoffs[d.name]
  const share = total ? ((d.balance / total) * 100).toFixed(1) : 0
  const pays = d.payments || []
  const paidTotal = pays.reduce((s, p) => s + p.amount, 0)

  return (
    <Card className={`${open ? 'md:col-span-2' : ''} transition-colors hover:border-accent`}>
      <div className="cursor-pointer p-5 pb-0" onClick={onToggle}>
        <div className="mb-2 flex items-start justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-[0.9375rem] font-semibold tracking-tight">
              <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
              <span className="truncate">{d.name}</span>
              {bankMatch ? (
                <Badge variant="success" className="shrink-0"><Landmark className="h-3 w-3" />Bank connected</Badge>
              ) : (
                <Badge className="shrink-0">Manual entry</Badge>
              )}
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <Badge>APR {d.apr || '—'}</Badge>
              <Badge>min {fmt(d.min)}/mo</Badge>
              {d.dueDay ? <Badge>due day {d.dueDay}</Badge> : null}
              <Badge>{share}% of total</Badge>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <div className="text-lg font-bold tracking-tight">{fmt(d.balance)}</div>
            <div className="text-xs font-semibold text-amber-400">min {fmt(d.min)}<span className="text-[0.625rem] font-normal text-muted-foreground">/mo</span></div>
          </div>
        </div>
        <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs">
          <span className="text-muted-foreground">At minimum: {pm != null ? <b className="text-foreground/80">{fmtMonths(pm)}</b> : <b className="text-red-400">never pays off</b>}</span>
          {planDate && <span className="text-muted-foreground">Your plan: <b className="text-emerald-400">{monthLabel(planDate)}</b></span>}
          {pays.length > 0 && <span className="text-muted-foreground">Paid: <b className="text-emerald-400">{fmt0(paidTotal)}</b> · {pays.length} pmt{pays.length > 1 ? 's' : ''} · last {prettyDate(pays[0].date)}</span>}
        </div>
        {util !== null && (
          <div className="mt-3.5">
            <div className="mb-1.5 flex justify-between text-[0.6875rem] text-muted-foreground">
              <span>Utilization <span className="opacity-60">(target &lt;30%)</span></span>
              <span className={`font-semibold ${util > 80 ? 'text-red-400' : util > 30 ? 'text-amber-400' : 'text-emerald-400'}`}>{util}% of {fmt0(d.limit)}</span>
            </div>
            <div className="track relative">
              <div style={{ width: `${util}%`, background: util > 80 ? '#f87171' : util > 30 ? '#fbbf24' : '#34d399' }} />
              <div className="absolute top-1/2 h-2.5 w-px -translate-y-1/2 bg-zinc-500" style={{ left: '30%' }} title="30% target" />
            </div>
            <div className={`mt-1.5 text-[0.6875rem] ${d.balance - 0.3 * d.limit > 0 ? 'text-amber-400/90' : 'text-emerald-400/90'}`}>
              {d.balance - 0.3 * d.limit > 0 ? `Pay down ${fmt0(d.balance - 0.3 * d.limit)} to reach 30% (${fmt0(0.3 * d.limit)})` : '✓ Under the 30% target'}
            </div>
          </div>
        )}
        {d.note && <div className="mt-3 rounded-lg border border-amber-400/15 bg-amber-400/[0.06] px-3 py-2 text-xs text-amber-200/80">{d.note}</div>}
      </div>
      <div className="flex gap-2 px-5 py-3.5">
        <Button size="sm" variant={open ? 'secondary' : 'default'} onClick={onToggle}>{open ? 'Close' : <><DollarSign />Make payment</>}</Button>
        <Button size="sm" variant="outline" onClick={onEdit}><Pencil />Edit</Button>
        <Button size="sm" variant="destructive" onClick={onDelete}>Delete</Button>
      </div>
      {open && (
        <div className="grid gap-6 border-t px-5 pb-5 pt-4 lg:grid-cols-2">
          <div>
            <div className="mb-2.5 text-[0.65625rem] font-medium uppercase tracking-wider text-muted-foreground">Make a payment</div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="w-32"><Label>Amount ($)</Label><Input type="number" step="0.01" min="0" value={amt} onChange={(e) => setAmt(e.target.value)} /></div>
              <div><Label>Date</Label><Input type="date" className="w-40" value={date} onChange={(e) => setDate(e.target.value)} /></div>
              <div className="min-w-[110px] flex-1"><Label>Note</Label><Input placeholder="optional" value={note} onChange={(e) => setNote(e.target.value)} /></div>
              <Button onClick={() => { onPay(i, parseFloat(amt), date, note); setNote('') }}>Submit</Button>
            </div>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {[d.min, 50, 100, 200].filter((v, ix, a) => v > 0 && a.indexOf(v) === ix).map((v) => (
                <Button key={v} variant="outline" size="xs" onClick={() => setAmt(v.toFixed ? v.toFixed(2) : v)}>{fmt0(v)}</Button>
              ))}
              <Button variant="outline" size="xs" className="text-emerald-400" onClick={() => setAmt(d.balance.toFixed(2))}>Full balance</Button>
            </div>
            <p className="mt-2.5 text-[0.6875rem] text-muted-foreground">Submitting reduces the balance and logs it to payment history + transactions.</p>
          </div>
          <div>
            <div className="mb-2.5 text-[0.65625rem] font-medium uppercase tracking-wider text-muted-foreground">
              Payment history {pays.length ? `· ${pays.length} · ${fmt(paidTotal)} total` : ''}
            </div>
            {pays.length ? (
              <div className="max-h-48 divide-y divide-border/60 overflow-y-auto pr-1">
                {pays.map((p, pi) => (
                  <div key={pi} className="flex items-center gap-3 py-2 text-[0.8125rem]">
                    <span className="w-14 shrink-0 text-xs text-muted-foreground">{prettyDate(p.date)}</span>
                    <span className="w-20 shrink-0 font-semibold text-emerald-400">{fmt(p.amount)}</span>
                    <span className="flex-1 truncate text-xs text-muted-foreground">{p.note || ''}</span>
                    <button onClick={() => onDeletePayment(pi)} className="shrink-0 text-muted-foreground hover:text-red-400" title="Delete payment & restore balance"><X className="h-3.5 w-3.5" /></button>
                  </div>
                ))}
              </div>
            ) : <p className="text-xs text-muted-foreground">No payments logged yet. Submit one on the left.</p>}
          </div>
        </div>
      )}
    </Card>
  )
}

function ConsolidationCard() {
  const { state } = useApp()
  const [open, setOpen] = useState(false)
  const [f, setF] = useState({ amount: 15000, apr: 9.99, term: 60 })
  const [goal, setGoal] = useState('cash') // what the suggestion optimizes for
  const [sel, setSel] = useState(null) // null = not touched yet → use suggestion

  const amount = Math.max(0, parseFloat(f.amount) || 0)
  const aprText = (parseFloat(f.apr) || 0) + '%'
  // standard amortization from amount + APR + term (like the bank's calculator)
  const termN = Math.max(1, parseInt(f.term) || 1)
  const mr = (parseFloat(f.apr) || 0) / 100 / 12
  const per1k = mr === 0 ? 1000 / termN : (1000 * mr) / (1 - Math.pow(1 + mr, -termN))
  const loanPay = +(amount / 1000 * per1k).toFixed(2)

  const eligible = state.debts.filter((d) => d.balance > 0)

  // per-$1k relief: what you pay now per $1k of balance vs what the loan costs per $1k.
  // Higher than the loan's rate → consolidating frees monthly cash.
  const relief = (d) => (d.balance > 0 ? d.min / d.balance * 1000 - per1k : 0)

  // Suggestion. 'cash' = free up the most monthly money (rank by per-$1k relief).
  // 'interest' = save the most interest (rank by APR above the loan's rate).
  const suggested = useMemo(() => {
    const loanR = parseAPR(aprText)
    const pick = new Set()
    let left = amount
    const ranked = eligible.slice().sort((a, b) => (goal === 'cash' ? relief(b) - relief(a) : parseAPR(b.apr) - parseAPR(a.apr)))
    for (const d of ranked) {
      const worth = goal === 'cash' ? relief(d) > 0 : parseAPR(d.apr) > loanR
      // never refinance a 0% promo — that's free money
      if (worth && parseAPR(d.apr) > 0 && d.balance <= left) { pick.add(d.name); left -= d.balance }
    }
    return pick
  }, [amount, aprText, per1k, goal, state.debts])

  const selected = sel ?? suggested
  const toggle = (name) => {
    const n = new Set(selected)
    n.has(name) ? n.delete(name) : n.add(name)
    setSel(n)
  }

  const selDebts = eligible.filter((d) => selected.has(d.name))
  const selBal = selDebts.reduce((s, d) => s + d.balance, 0)
  const selMins = selDebts.reduce((s, d) => s + d.min, 0)
  const leftover = amount - selBal

  // loan payoff
  const loan = amount > 0 && loanPay > 0 ? simCardPlan(amount, aprText, loanPay) : null

  // current path: each selected debt at its own minimum
  const currents = selDebts.map((d) => simCardPlan(d.balance, d.apr, d.min))
  const currBad = currents.some((c) => c === null)
  const currInterest = currBad ? null : currents.reduce((s, c) => s + c.interest, 0)
  const currMonths = currBad ? null : Math.max(0, ...currents.map((c) => c.months))

  // whole-picture: your debts with the sim budget, before vs after swapping selected debts for the loan
  const before = useMemo(() => simulatePlan(state.debts, state.sim.budget, state.sim.strategy), [state.debts, state.sim])
  const after = useMemo(() => {
    if (!selDebts.length || !loanPay) return null
    const rest = state.debts.filter((d) => !selected.has(d.name) || d.balance <= 0)
    const newDebts = [...rest, { name: 'Consolidation Loan', balance: amount, apr: aprText, min: loanPay }]
    // same money in: budget shifts by the difference between old mins and the loan payment
    const budget = Math.max(loanPay, state.sim.budget - selMins + loanPay)
    return simulatePlan(newDebts, budget, state.sim.strategy)
  }, [state.debts, state.sim, amount, aprText, loanPay, selBal, selMins, selected.size])

  const cash = selMins - loanPay // + = frees up money each month
  const intDiff = loan && currInterest != null ? currInterest - loan.interest : null

  // month-by-month: what you'd pay + cumulative interest on each path
  const chartData = useMemo(() => {
    if (!selDebts.length || loanPay <= 0) return []
    const cur = selDebts.map((d) => ({ bal: d.balance, r: parseAPR(d.apr) / 12, min: d.min }))
    let loanBal = amount
    const lr = parseAPR(aprText) / 12
    let cumCur = 0, cumLoan = 0
    const rows = []
    for (let m = 1; m <= 120; m++) {
      let payCur = 0
      cur.forEach((d) => {
        if (d.bal <= 0.005) return
        const int = d.bal * d.r
        cumCur += int
        d.bal += int
        const p = Math.min(d.min, d.bal)
        d.bal -= p
        payCur += p
      })
      let payLoan = 0
      if (loanBal > 0.005) {
        const int = loanBal * lr
        cumLoan += int
        loanBal += int
        payLoan = Math.min(loanPay, loanBal)
        loanBal -= payLoan
      }
      rows.push({ m, name: m % 12 === 0 ? m / 12 + ' yr' : m + ' mo', 'Now (minimums)': Math.round(payCur), 'With loan': Math.round(payLoan), intCur: Math.round(cumCur), intLoan: Math.round(cumLoan), saved: Math.round(cumCur - cumLoan) }
      )
      if (payCur === 0 && payLoan === 0) break
    }
    return rows
  }, [selBal, selMins, amount, aprText, loanPay, selected.size, state.debts])

  return (
    <Card className={open ? 'p-5' : 'px-5 py-3.5'}>
      <button onClick={() => setOpen(!open)} className="flex w-full items-center gap-2.5 text-left">
        <ChevronRight className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${open ? 'rotate-90' : ''}`} />
        <span className="text-[0.8125rem] font-semibold">Consolidation Loan Calculator</span>
        {!open && <span className="hidden text-[0.6875rem] text-muted-foreground sm:inline">would a loan help? enter amount, APR & payment per $1k to find out</span>}
        <span className="ml-auto shrink-0 text-[0.6875rem] font-medium text-primary">{open ? 'Collapse' : 'Open'}</span>
      </button>
      {open && (
        <div className="mt-4 fade-in">
          <div className="mb-4 flex flex-wrap items-end gap-3">
            <div><Label>Loan amount ($)</Label><Input type="number" step="500" min="0" className="w-32 font-bold" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></div>
            <div><Label>APR (%)</Label><Input type="number" step="0.25" min="0" className="w-24" value={f.apr} onChange={(e) => setF({ ...f, apr: e.target.value })} /></div>
            <div>
              <Label>Term (months)</Label>
              <Select className="w-32" value={f.term} onChange={(e) => setF({ ...f, term: e.target.value })}>
                {[12, 24, 36, 48, 60, 72, 84].map((m) => <option key={m} value={m}>{m} mo ({m / 12} yr)</option>)}
              </Select>
            </div>
            <div className="rounded-lg border bg-secondary/40 px-3.5 py-2">
              <div className="text-[0.65625rem] uppercase tracking-wider text-muted-foreground">Est. payment per $1k</div>
              <div className="text-base font-bold">${per1k.toFixed(2)}<span className="text-[0.6875rem] font-normal text-muted-foreground">/mo</span></div>
            </div>
            <div className="rounded-lg border border-sky-400/25 bg-sky-400/[0.07] px-3.5 py-2">
              <div className="text-[0.65625rem] uppercase tracking-wider text-muted-foreground">Your monthly payment</div>
              <div className="text-base font-bold text-sky-300">{fmt(loanPay)}<span className="text-[0.6875rem] font-normal text-muted-foreground">/mo</span></div>
              <div className="text-[0.625rem] text-muted-foreground">{fmt0(amount)} × ${per1k.toFixed(2)} per $1k</div>
            </div>
          </div>

          {/* recommendation */}
          <div className="mb-4 rounded-lg border border-primary/25 bg-primary/5 px-3.5 py-3 text-[0.78125rem] leading-relaxed">
            <div className="mb-2.5 flex flex-wrap items-center gap-2.5">
              <span className="font-semibold"><Lightbulb className="mr-1 inline h-4 w-4 align-[-3px] text-amber-300" />What matters most to you?</span>
              <Segmented value={goal} onChange={(v) => { setGoal(v); setSel(null) }} options={[['cash', 'Free up monthly cash'], ['interest', 'Save the most interest']]} />
            </div>
            {suggested.size ? (
              <>
                <b>Consolidate {[...suggested].join(', ')}</b> —{' '}
                {goal === 'cash'
                  ? <>you currently pay more per $1,000 on {suggested.size === 1 ? 'it' : 'these'} than this loan would cost, so moving {suggested.size === 1 ? 'it' : 'them'} over lowers your monthly payment.</>
                  : <>{suggested.size === 1 ? 'it carries' : 'they carry'} a higher APR than this loan, so you'd pay less interest.</>}
                {' '}Skipping any 0% promo debt — never refinance free money.
                {sel !== null && <Button variant="outline" size="xs" className="ml-2" onClick={() => setSel(null)}>Use suggestion</Button>}
              </>
            ) : (
              <>
                {goal === 'cash'
                  ? <>At {f.apr}% over {f.term} months this loan costs <b>${per1k.toFixed(2)} per $1,000</b> — more than the minimums you're paying on every debt. Consolidating would <b className="text-red-400">raise</b> your monthly payment. Try a longer term.</>
                  : <>At {f.apr}% none of your debts cost more than this loan (or none fit in {fmt0(amount)}) — consolidating would likely <b className="text-red-400">cost you more</b> in interest. Try a lower APR or bigger amount.</>}
              </>
            )}
          </div>

          {/* debt picker */}
          <div className="mb-4">
            <div className="mb-2 flex flex-wrap items-baseline gap-x-2 text-[0.65625rem] font-medium uppercase tracking-wider text-muted-foreground">
              <span>Which debts would the loan pay off?</span>
              <span className="normal-case tracking-normal opacity-80">loan costs ${per1k.toFixed(2)} per $1k — anything you pay more than that on frees up cash</span>
            </div>
            <div className="grid gap-1 sm:grid-cols-2">
              {eligible.slice().sort((a, b) => relief(b) - relief(a)).map((d) => {
                const on = selected.has(d.name)
                const rec = suggested.has(d.name)
                const r = relief(d)
                const promo = parseAPR(d.apr) === 0
                return (
                  <label key={d.name} className={`flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-[0.8125rem] transition ${on ? 'border-sky-400/40 bg-sky-400/[0.06]' : 'bg-secondary/30 hover:bg-secondary/60'}`}>
                    <input type="checkbox" className="h-4 w-4 accent-sky-400" checked={on} onChange={() => toggle(d.name)} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate">{d.name}</div>
                      <div className="text-[0.65625rem] text-muted-foreground">
                        pays ${(d.min / d.balance * 1000).toFixed(2)}/$1k ·{' '}
                        <span className={r > 0 ? 'text-emerald-400' : 'text-red-400'}>{r > 0 ? '+' : '−'}{fmt0(Math.abs(r * d.balance / 1000))}/mo</span>
                      </div>
                    </div>
                    {promo ? <Badge variant="warning">0% promo</Badge> : rec && <Badge variant="success">suggested</Badge>}
                    <span className="shrink-0 text-[0.6875rem] text-muted-foreground">APR {d.apr}</span>
                    <span className="w-20 shrink-0 text-right font-semibold">{fmt0(d.balance)}</span>
                  </label>
                )
              })}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[0.71875rem] text-muted-foreground">
              <span>Selected: <b className="text-foreground">{fmt0(selBal)}</b> across {selDebts.length} debt{selDebts.length === 1 ? '' : 's'} · minimums <b className="text-amber-400">{fmt(selMins)}/mo</b></span>
              {selDebts.length > 0 && (leftover >= 0
                ? <span>Loan covers it with <b className="text-emerald-400">{fmt0(leftover)}</b> left over</span>
                : <span className="text-red-400">Loan is {fmt0(-leftover)} short of covering these — uncheck something or raise the amount</span>)}
            </div>
          </div>

          {selDebts.length > 0 && loanPay > 0 && (
            <>
              {!loan && (
                <div className="mb-3 rounded-lg border border-red-400/20 bg-red-400/[0.07] px-3 py-2.5 text-xs text-red-300">
                  At {fmt(loanPay)}/mo this loan never pays off — the payment doesn't cover the interest. Raise the payment per $1k.
                </div>
              )}
              <div className="mb-4 grid grid-cols-2 gap-2.5 lg:grid-cols-4">
                <StatTile label="Monthly cash flow" value={(cash >= 0 ? '+' : '−') + fmt(Math.abs(cash)) + '/mo'} tone={cash >= 0 ? 'text-emerald-400' : 'text-red-400'} sub={cash >= 0 ? 'freed up vs those minimums' : 'more than those minimums'} highlight={cash > 0} />
                <StatTile label="Loan paid off in" value={loan ? fmtMonths(loan.months) : 'never'} tone={loan ? '' : 'text-red-400'} sub={loan ? fmt0(loan.interest) + ' loan interest' : ''} />
                <StatTile label="Those debts as-is" value={currMonths != null ? fmtMonths(currMonths) : 'some never pay off'} tone={currMonths != null ? '' : 'text-red-400'} sub={currInterest != null ? fmt0(currInterest) + ' interest at minimums' : 'minimum too low on one'} />
                <StatTile label="Interest difference" value={intDiff != null && loan ? (intDiff >= 0 ? 'save ' : 'costs ') + fmt0(Math.abs(intDiff)) : '—'} tone={intDiff > 0 ? 'text-emerald-400' : intDiff != null ? 'text-red-400' : 'text-muted-foreground'} sub="vs paying their minimums" highlight={intDiff > 0} />
              </div>
              {chartData.length > 0 && (
                <div className="mb-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <div className="mb-2 text-[0.65625rem] font-medium uppercase tracking-wider text-muted-foreground">Monthly payment over time</div>
                    <div className="h-48">
                      <ResponsiveContainer>
                        <LineChart data={chartData}>
                          <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={(v) => '$' + v} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={TIP.contentStyle} formatter={(v) => fmt0(v) + '/mo'} labelFormatter={(l) => 'Month ' + l.replace(' mo', '').replace(' yr', '×12')} />
                          <Line type="stepAfter" dataKey="Now (minimums)" stroke="#f87171" strokeWidth={2} dot={false} />
                          <Line type="stepAfter" dataKey="With loan" stroke="#38bdf8" strokeWidth={2} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-1.5 flex gap-4 text-[0.65625rem] text-muted-foreground">
                      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-400" />Now: keep paying minimums</span>
                      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-400" />With the loan ({fmt0(loanPay)}/mo)</span>
                    </div>
                  </div>
                  <div>
                    <div className="mb-2 text-[0.65625rem] font-medium uppercase tracking-wider text-muted-foreground">Interest saved as time goes on</div>
                    <div className="h-48">
                      <ResponsiveContainer>
                        <LineChart data={chartData}>
                          <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                          <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={(v) => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(1) + 'k' : v)} axisLine={false} tickLine={false} />
                          <Tooltip contentStyle={TIP.contentStyle} formatter={(v, n) => [fmt0(v), { saved: 'Interest saved so far', intCur: 'Interest paid — minimums', intLoan: 'Interest paid — loan' }[n] || n]} labelFormatter={(l) => 'Month ' + l.replace(' mo', '').replace(' yr', '×12')} />
                          <Line type="monotone" dataKey="intCur" stroke="#f87171" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                          <Line type="monotone" dataKey="intLoan" stroke="#38bdf8" strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
                          <Line type="monotone" dataKey="saved" stroke="#34d399" strokeWidth={2.5} dot={false} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-[0.65625rem] text-muted-foreground">
                      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-emerald-400" />Saved (the gap)</span>
                      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-red-400" />Interest piling up on minimums</span>
                      <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-sky-400" />Interest on the loan</span>
                    </div>
                  </div>
                </div>
              )}
              {after && before.done && (
                <div className="rounded-lg border bg-secondary/40 px-3.5 py-3 text-[0.78125rem] leading-relaxed text-foreground/85">
                  <b>Your whole debt picture</b> (keeping your {fmt0(state.sim.budget)}/mo plan):{' '}
                  debt-free <b className={after.done && after.end <= before.end ? 'text-emerald-400' : 'text-amber-400'}>{after.done ? monthLabel(after.end) : 'never'}</b> with the loan
                  {' '}vs <b>{monthLabel(before.end)}</b> without ·{' '}
                  total interest <b className={after.done && after.totalInterest <= before.totalInterest ? 'text-emerald-400' : 'text-amber-400'}>{after.done ? fmt0(after.totalInterest) : '—'}</b> vs <b>{fmt0(before.totalInterest)}</b>.
                  <span className="text-muted-foreground"> You'd still owe the same total — consolidation changes the rate and payment, not the amount.</span>
                </div>
              )}
              <p className="mt-3 text-[0.6875rem] text-muted-foreground">Pretend mode — nothing changes your real debts. This is an estimate, not financial advice; check the loan's actual terms and fees before signing anything.</p>
            </>
          )}
        </div>
      )}
    </Card>
  )
}

function DebtDialog({ idx, onClose }) {
  const { state, update } = useApp()
  const toast = useToast()
  const d = idx >= 0 ? state.debts[idx] : { name: '', balance: '', apr: '', min: '', dueDay: '', limit: '', note: '' }
  const [f, setF] = useState({ ...d })
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const save = () => {
    if (!String(f.name).trim()) return toast('Enter a name', 'error')
    const bal = parseFloat(f.balance)
    if (isNaN(bal)) return toast('Enter a balance', 'error')
    update((s) => {
      const debt = {
        name: String(f.name).trim(), balance: bal, apr: f.apr || '—', min: parseFloat(f.min) || 0,
        dueDay: parseInt(f.dueDay) || null, limit: parseFloat(f.limit) || null, note: f.note || '',
        payments: idx >= 0 ? s.debts[idx].payments || [] : [],
      }
      if (idx >= 0) s.debts[idx] = debt
      else s.debts.push(debt)
      s.debts.sort((a, b) => b.balance - a.balance)
    })
    toast(idx >= 0 ? 'Debt updated' : 'Debt added')
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{idx >= 0 ? 'Edit' : 'Add'} Debt</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>Name</Label><Input value={f.name} onChange={set('name')} placeholder="e.g. Chase Freedom" /></div>
          <div><Label>Balance ($)</Label><Input type="number" step="0.01" value={f.balance} onChange={set('balance')} /></div>
          <div><Label>APR</Label><Input value={f.apr} onChange={set('apr')} placeholder="e.g. 24.99%" /></div>
          <div><Label>Minimum payment ($)</Label><Input type="number" step="0.01" value={f.min} onChange={set('min')} /></div>
          <div><Label>Due day (1–31)</Label><Input type="number" min="1" max="31" value={f.dueDay || ''} onChange={set('dueDay')} /></div>
          <div><Label>Credit limit ($)</Label><Input type="number" value={f.limit || ''} onChange={set('limit')} placeholder="leave blank for loans" /></div>
          <div><Label>Note (optional)</Label><Input value={f.note} onChange={set('note')} /></div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
