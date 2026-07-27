'use client'
import { useMemo, useState } from 'react'
import { Plus, Pencil, X, Search, FlaskConical, CreditCard } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { CatIcon } from '@/components/shared'
import { useApp, monthTx, incomeIn } from '@/store'
import { useToast } from '@/components/toast'
import { fmt, fmt0, today, isoDate, prettyDate, ymLabel, uid } from '@/lib/utils'
import { recEvery, recMonthly, nextDueDate, simulatePlan, fmtMonths } from '@/lib/finance'

export default function Recurring() {
  const { state, update, catInfo } = useApp()
  const toast = useToast()
  const [filter, setFilter] = useState({ cat: 'all', status: 'all', sort: 'due', q: '' })
  const [whatIf, setWhatIf] = useState(new Set())
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit

  const act = state.recurring.filter((r) => r.active !== false)
  const total = act.reduce((s, r) => s + recMonthly(r), 0)
  const hasMulti = act.some((r) => recEvery(r) > 1)

  let list = state.recurring.slice()
  if (filter.status === 'active') list = list.filter((r) => r.active !== false)
  else if (filter.status === 'paused') list = list.filter((r) => r.active === false)
  if (filter.cat !== 'all') list = list.filter((r) => r.cat === filter.cat)
  if (filter.q) list = list.filter((r) => r.desc.toLowerCase().includes(filter.q.toLowerCase()))
  const sorts = { due: (a, b) => a.dueDay - b.dueDay, amtHigh: (a, b) => b.amount - a.amount, amtLow: (a, b) => a.amount - b.amount, name: (a, b) => a.desc.localeCompare(b.desc) }
  list.sort(sorts[filter.sort] || sorts.due)
  const isFiltered = filter.cat !== 'all' || filter.status !== 'all' || filter.q
  const fTotal = list.filter((r) => r.active !== false).reduce((s, r) => s + recMonthly(r), 0)

  // what-if
  const sel = act.filter((r) => whatIf.has(r.id))
  const save = sel.reduce((s, r) => s + recMonthly(r), 0)
  const mins = state.debts.reduce((s, d) => s + d.min, 0)
  const yms = [...new Set(state.transactions.filter((t) => t.type === 'income' && t.cat !== 'transfer').map((t) => t.date.slice(0, 7)))]
  const avgIncome = yms.length ? yms.reduce((s, ym) => s + incomeIn(state, ym), 0) / yms.length : 0
  const base = useMemo(() => (sel.length ? simulatePlan(state.debts, state.sim.budget, state.sim.strategy) : null), [sel.length, state.debts, state.sim])
  const boost = useMemo(() => (sel.length ? simulatePlan(state.debts, state.sim.budget + save, state.sim.strategy) : null), [sel.length, save, state.debts, state.sim])
  const sooner = base && boost && base.done && boost.done ? base.months - boost.months : null
  const intSaved = base && boost && base.done && boost.done ? base.totalInterest - boost.totalInterest : null

  const toggleWhatIf = (id) => setWhatIf((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  const logRecurring = (r) => {
    update((s) => {
      const rr = s.recurring.find((x) => x.id === r.id)
      const ym = today().slice(0, 7)
      const dim = new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate()
      const date = recEvery(rr) > 1 ? rr.nextDate || today() : ym + '-' + String(Math.min(rr.dueDay, dim)).padStart(2, '0')
      s.transactions.unshift({ id: uid('tx'), rid: rr.id, date, desc: rr.desc, amount: rr.amount, type: 'expense', cat: rr.cat })
      s.transactions.sort((a, b) => b.date.localeCompare(a.date))
      if (recEvery(rr) > 1 && rr.nextDate) {
        const d = new Date(rr.nextDate + 'T00:00:00'); d.setMonth(d.getMonth() + recEvery(rr)); rr.nextDate = isoDate(d)
      }
    })
    toast(`${r.desc} logged`)
  }

  return (
    <div className="fade-in space-y-3">
      <Card className="flex flex-wrap items-center gap-3 p-3">
        <div className="text-[13px] text-muted-foreground">
          <b className="text-foreground">{act.length}</b> active recurring bills · <b className="text-amber-400">{hasMulti ? '≈' : ''}{fmt(total)}</b>/month
          {hasMulti && <span className="text-[11px] opacity-70"> (2–3 mo bills averaged out)</span>}
        </div>
        <Button size="sm" className="ml-auto" onClick={() => setEditing(null)}><Plus />Add recurring</Button>
      </Card>

      {/* what-if */}
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <span className="text-[13px] font-semibold tracking-tight">What-if simulator</span>
          <Badge className="uppercase tracking-wide">nothing is actually changed</Badge>
        </div>
        {!sel.length ? (
          <div className="text-xs text-muted-foreground">Check the box next to any bill below to see what canceling it would do to your monthly cash — and how much faster you could pay off your debt.</div>
        ) : (
          <>
            <div className="mb-2.5 text-xs text-muted-foreground">If you cancel <b className="text-foreground">{sel.length}</b> bill{sel.length === 1 ? '' : 's'} ({sel.map((r) => r.desc).join(', ')}):</div>
            <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[11px] text-muted-foreground">You free up</div><div className="font-bold tracking-tight text-emerald-400">{fmt(save)}<span className="text-[11px] font-normal text-muted-foreground">/mo</span></div></div>
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[11px] text-muted-foreground">Per year</div><div className="font-bold tracking-tight text-emerald-400">{fmt0(save * 12)}</div></div>
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[11px] text-muted-foreground">Bills become</div><div className="font-bold tracking-tight">{fmt(total - save)}<span className="text-[11px] font-normal text-muted-foreground">/mo</span></div><div className="text-[10px] text-muted-foreground/70">was {fmt(total)}</div></div>
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[11px] text-muted-foreground">Of your income</div><div className="font-bold tracking-tight">{avgIncome ? ((save / avgIncome) * 100).toFixed(1) + '%' : '—'}</div><div className="text-[10px] text-muted-foreground/70">≈{fmt0(avgIncome)}/mo avg</div></div>
            </div>
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-xs">
              <CreditCard className="mr-1 inline h-4 w-4 align-[-3px] text-muted-foreground" />
              {sooner != null ? (
                <>Redirect that {fmt(save)}/mo at your debt and you'd be <b>debt-free {fmtMonths(Math.max(0, sooner))} sooner</b> and save <b className="text-emerald-400">{fmt0(Math.max(0, intSaved))}</b> in interest <span className="text-muted-foreground">(vs your current {fmt0(state.sim.budget)}/mo plan)</span>.</>
              ) : (
                <>Raise the payoff budget on the Debt page to see how redirecting this money would speed up your payoff.</>
              )}
            </div>
            <Button variant="outline" size="xs" className="mt-2.5" onClick={() => setWhatIf(new Set())}>Reset what-if</Button>
          </>
        )}
      </Card>

      {/* filters */}
      <Card className="flex flex-wrap items-center gap-2.5 p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-40 pl-8" placeholder="Search bills…" value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        </div>
        <Select className="text-xs" value={filter.cat} onChange={(e) => setFilter({ ...filter, cat: e.target.value })}>
          <option value="all">All categories</option>
          {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <Select className="text-xs" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="all">Active + paused</option><option value="active">Active only</option><option value="paused">Paused only</option>
        </Select>
        <Select className="text-xs" value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value })}>
          <option value="due">Sort: due day</option><option value="amtHigh">Sort: highest $</option><option value="amtLow">Sort: lowest $</option><option value="name">Sort: name A–Z</option>
        </Select>
        {isFiltered && (
          <>
            <Badge>{list.length} shown · <b className="text-amber-400">{fmt0(fTotal)}</b>/mo</Badge>
            <Button variant="outline" size="xs" onClick={() => setFilter({ cat: 'all', status: 'all', sort: 'due', q: '' })}>Clear</Button>
          </>
        )}
      </Card>

      {/* list */}
      <Card className="overflow-hidden">
        <div className="divide-y divide-border/60">
          {list.length ? list.map((r) => {
            const off = r.active === false
            const logged = monthTx(state, today().slice(0, 7)).some((t) => t.rid === r.id)
            const wi = whatIf.has(r.id)
            return (
              <div key={r.id} className={`flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 ${off ? 'opacity-40' : ''} ${wi ? 'bg-primary/5' : ''}`}>
                <input type="checkbox" className="h-4 w-4 shrink-0 cursor-pointer accent-emerald-400" checked={wi} disabled={off} onChange={() => toggleWhatIf(r.id)} title="What if I cancel this?" />
                <span className="flex w-6 shrink-0 justify-center"><CatIcon cat={r.cat} /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13px] font-medium">{r.desc}</div>
                  <div className="text-[11px] text-muted-foreground">
                    {recEvery(r) > 1 ? `every ${recEvery(r)} mo · next ${r.nextDate ? prettyDate(r.nextDate) : 'set a date'}` : `day ${r.dueDay} · monthly`} · {catInfo(r.cat).name}
                  </div>
                </div>
                <span className="shrink-0 text-right">
                  <span className="text-[13px] font-semibold">{fmt(r.amount)}</span>
                  {recEvery(r) > 1 && <span className="block text-[10px] text-muted-foreground">≈{fmt0(recMonthly(r))}/mo</span>}
                </span>
                <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
                  <Button variant={off || logged ? 'outline' : 'secondary'} size="xs" disabled={off || logged} onClick={() => logRecurring(r)} title={logged ? 'Already logged this month' : 'Add this charge to this month’s transactions'}>
                    {logged ? '✓ Logged' : 'Log this month'}
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => { update((s) => { const rr = s.recurring.find((x) => x.id === r.id); rr.active = rr.active === false }); if (!off) setWhatIf((s) => { const n = new Set(s); n.delete(r.id); return n }) }}>
                    {off ? 'Enable' : 'Pause'}
                  </Button>
                  <button className="shrink-0 text-muted-foreground transition hover:text-foreground" onClick={() => setEditing(r.id)}><Pencil className="h-3.5 w-3.5" /></button>
                  <button className="shrink-0 text-muted-foreground transition hover:text-red-400" onClick={() => { if (confirm(`Delete recurring "${r.desc}"?`)) { update((s) => { s.recurring = s.recurring.filter((x) => x.id !== r.id) }); toast('Deleted') } }}><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )
          }) : (
            <div className="p-10 text-center text-[13px] text-muted-foreground">
              {isFiltered ? <>No bills match your filters — <button className="text-primary hover:underline" onClick={() => setFilter({ cat: 'all', status: 'all', sort: 'due', q: '' })}>clear filters</button>.</> : 'No recurring bills yet.'}
            </div>
          )}
        </div>
      </Card>
      <p className="text-[11px] text-muted-foreground/70">Recurring items show up in the dashboard's "due soon" list; "Log this month" records the charge as a transaction. Non-monthly bills advance their next date when logged.</p>

      {editing !== undefined && <RecurringDialog id={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

function RecurringDialog({ id, onClose }) {
  const { state, update } = useApp()
  const toast = useToast()
  const r = id ? state.recurring.find((x) => x.id === id) : { desc: '', amount: '', dueDay: 1, cat: 'subscriptions', every: 1, nextDate: null }
  const [f, setF] = useState({ ...r, every: r.every || 1, nextDate: r.nextDate || isoDate(nextDueDate(r.dueDay || 1)) })
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const save = () => {
    const desc = String(f.desc).trim()
    if (!desc) return toast('Enter a name')
    const amount = parseFloat(f.amount)
    if (isNaN(amount)) return toast('Enter an amount')
    const every = parseInt(f.every) || 1
    if (every > 1 && !f.nextDate) return toast('Pick the next payment date')
    update((s) => {
      const data = { desc, amount, dueDay: Math.min(31, Math.max(1, parseInt(f.dueDay) || 1)), cat: f.cat, every, nextDate: every > 1 ? f.nextDate : null }
      if (id) Object.assign(s.recurring.find((x) => x.id === id), data)
      else s.recurring.push({ id: uid('r'), ...data, active: true })
    })
    toast(id ? 'Recurring updated' : 'Recurring added')
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{id ? 'Edit' : 'Add'} Recurring Bill</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>Name</Label><Input value={f.desc} onChange={set('desc')} placeholder="e.g. Netflix" /></div>
          <div><Label>Amount ($)</Label><Input type="number" step="0.01" value={f.amount} onChange={set('amount')} /></div>
          <div><Label>Day of month (1–31)</Label><Input type="number" min="1" max="31" value={f.dueDay} onChange={set('dueDay')} /></div>
          <div>
            <Label>Repeats</Label>
            <Select className="w-full" value={f.every} onChange={set('every')}>
              {[[1, 'Every month'], [2, 'Every 2 months'], [3, 'Every 3 months'], [6, 'Every 6 months'], [12, 'Every year']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          {parseInt(f.every) > 1 && (
            <div><Label>Next payment date</Label><Input type="date" value={f.nextDate} onChange={set('nextDate')} /></div>
          )}
          <div className="sm:col-span-2">
            <Label>Category</Label>
            <Select className="w-full" value={f.cat} onChange={set('cat')}>
              {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
