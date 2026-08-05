'use client'
import { useState } from 'react'
import { Plus, X, RotateCcw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { SectionHead } from '@/components/shared'
import { useApp, incomeIn, expensesIn } from '@/store'
import { useToast } from '@/components/toast'
import { fmt0, today, uid } from '@/lib/utils'
import { recMonthly, recEvery } from '@/lib/finance'

export default function Simulator() {
  const { state, update } = useApp()
  const toast = useToast()
  const [name, setName] = useState('')
  const [amt, setAmt] = useState('')

  const ms = state.mSim
  const income = parseFloat(ms.income) || 0
  const totalExp = ms.items.reduce((s, x) => s + x.amount, 0)
  const net = income - totalExp
  const pct = income ? Math.min(100, Math.round((totalExp / income) * 100)) : 0

  const mins = state.debts.reduce((s, d) => s + d.min, 0)
  const recT = state.recurring.filter((r) => r.active !== false).reduce((s, r) => s + recMonthly(r), 0)
  const yms = [...new Set(state.transactions.filter((t) => t.type === 'income' && t.cat !== 'transfer').map((t) => t.date.slice(0, 7)))]
  const avgInc = yms.length ? yms.reduce((s, m) => s + incomeIn(state, m), 0) / yms.length : 0

  const setIncome = (v) => update((s) => { s.mSim.income = Math.max(0, parseFloat(v) || 0) })

  const pull = (v) => {
    if (!v) return
    if (state.mSim.items.some((x) => x.src === v)) return toast('Already added', 'error')
    let it = null
    if (v === 'debt-all') it = { desc: 'All debt minimums', amount: mins }
    else if (v === 'rec-all') it = { desc: 'All recurring bills', amount: recT }
    else if (v === 'spend-avg') {
      const nowYm = today().slice(0, 7)
      const all = [...new Set(state.transactions.filter((t) => t.cat !== 'transfer').map((t) => t.date.slice(0, 7)))]
      const full = all.filter((m) => m !== nowYm)
      const use = full.length ? full : all
      const avg = use.reduce((s, m) => s + expensesIn(state, m), 0) / (use.length || 1)
      it = { desc: 'My avg monthly spending (everything)', amount: Math.round(avg) }
    } else if (v.startsWith('d:')) {
      const d = state.debts[+v.slice(2)]
      if (d) it = { desc: d.name + ' (min payment)', amount: d.min }
    } else if (v.startsWith('r:')) {
      const r = state.recurring.find((x) => x.id === v.slice(2))
      if (r) it = { desc: r.desc + (recEvery(r) > 1 ? ' (monthly avg)' : ''), amount: +recMonthly(r).toFixed(2) }
    }
    if (it) update((s) => { s.mSim.items.push({ id: uid('ms'), src: v, ...it }) })
  }

  const addCustom = () => {
    if (!name.trim()) return toast('Name the expense', 'error')
    const a = parseFloat(amt)
    if (isNaN(a)) return toast('Enter an amount', 'error')
    update((s) => { s.mSim.items.push({ id: uid('ms'), src: 'custom', desc: name.trim(), amount: Math.max(0, a) }) })
    setName(''); setAmt('')
  }

  return (
    <div className="fade-in space-y-6">
      <Card className="p-5">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <SectionHead title="Plan a month" desc="Type an income, stack up expenses, see what's left. Pretend mode — nothing here touches your real data." />
          <Button variant="outline" size="sm" onClick={() => update((s) => { s.mSim = { income: '', items: [] } })}><RotateCcw />Start over</Button>
        </div>
        <div className="mt-4 grid grid-cols-3 gap-2 sm:gap-3">
          <div className="rounded-xl border border-emerald-400/15 bg-emerald-400/[0.06] px-2 py-3 text-center sm:p-4">
            <div className="mb-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground sm:text-[0.6875rem]">Income</div>
            <div className="text-base font-bold tracking-tight text-emerald-400 sm:text-xl md:text-2xl">{fmt0(income)}</div>
          </div>
          <div className="rounded-xl border border-red-400/15 bg-red-400/[0.05] px-2 py-3 text-center sm:p-4">
            <div className="mb-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground sm:text-[0.6875rem]">Expenses</div>
            <div className="text-base font-bold tracking-tight text-red-400 sm:text-xl md:text-2xl">{fmt0(totalExp)}</div>
          </div>
          <div className={`rounded-xl border px-2 py-3 text-center sm:p-4 ${net >= 0 ? 'border-emerald-400/25 bg-emerald-400/[0.06]' : 'border-red-400/30 bg-red-400/[0.08]'}`}>
            <div className="mb-1 text-[0.625rem] uppercase tracking-wider text-muted-foreground sm:text-[0.6875rem]">{net >= 0 ? 'Left Over' : 'In The Negative'}</div>
            <div className={`text-base font-bold tracking-tight sm:text-xl md:text-2xl ${net >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{net >= 0 ? '' : '−'}{fmt0(Math.abs(net))}</div>
          </div>
        </div>
        {income > 0 && (
          <div className="mt-3">
            <div className="mb-1.5 flex justify-between text-[0.6875rem] text-muted-foreground">
              <span>Spent</span><span className={pct >= 100 ? 'font-semibold text-red-400' : ''}>{pct}% of income</span>
            </div>
            <div className="track !h-2.5"><div style={{ width: `${pct}%`, background: totalExp > income ? '#f87171' : pct > 80 ? '#fbbf24' : '#34d399' }} /></div>
          </div>
        )}
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="p-5">
          <SectionHead title="1 · Income for the month" />
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <div className="min-w-[140px] flex-1">
              <Label>Monthly income ($)</Label>
              <Input type="number" step="50" min="0" className="text-lg font-bold text-emerald-400" value={ms.income || ''} placeholder="0" onChange={(e) => setIncome(e.target.value)} />
            </div>
            {avgInc > 0 && <Button variant="outline" size="sm" onClick={() => setIncome(Math.round(avgInc))}>My avg ({fmt0(avgInc)})</Button>}
            <Button variant="outline" size="sm" onClick={() => setIncome(Math.round(incomeIn(state, today().slice(0, 7))))}>This month so far</Button>
          </div>
        </Card>
        <Card className="p-5">
          <SectionHead title="2 · Add expenses" />
          <div className="mb-3 mt-3">
            <Label>Pull from what I already have</Label>
            <Select className="w-full" value="" onChange={(e) => pull(e.target.value)}>
              <option value="">Choose to add…</option>
              <option value="debt-all">All debt minimums — {fmt0(mins)}/mo</option>
              <option value="rec-all">All recurring bills — {fmt0(recT)}/mo</option>
              <option value="spend-avg">My avg monthly spending (everything)</option>
              <optgroup label="Single debts">
                {state.debts.map((d, i) => <option key={d.name} value={`d:${i}`}>{d.name} — {fmt0(d.min)}/mo</option>)}
              </optgroup>
              <optgroup label="Single recurring bills">
                {state.recurring.filter((r) => r.active !== false).map((r) => <option key={r.id} value={`r:${r.id}`}>{r.desc} — {fmt0(recMonthly(r))}/mo</option>)}
              </optgroup>
            </Select>
          </div>
          <Label>Or type your own</Label>
          <div className="flex gap-2">
            <Input className="flex-1" placeholder="e.g. Groceries" value={name} onChange={(e) => setName(e.target.value)} />
            <Input type="number" step="10" min="0" className="w-28" placeholder="$" value={amt} onChange={(e) => setAmt(e.target.value)} />
            <Button className="shrink-0" onClick={addCustom}><Plus />Add</Button>
          </div>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex items-center border-b bg-secondary/40 px-4 py-2.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground">
          <span>Expense list</span><span className="ml-auto">{ms.items.length} item{ms.items.length === 1 ? '' : 's'} · {fmt0(totalExp)}</span>
        </div>
        <div className="divide-y divide-border/60">
          {ms.items.length ? ms.items.map((x) => (
            <div key={x.id} className="flex items-center gap-3 px-4 py-2">
              <span className="flex-1 truncate text-[0.8125rem]">{x.desc}</span>
              {x.src !== 'custom' && <Badge>pulled</Badge>}
              <Input type="number" step="5" min="0" className="h-8 w-28 text-right font-semibold" value={x.amount}
                onChange={(e) => update((s) => { const it = s.mSim.items.find((i) => i.id === x.id); if (it) it.amount = Math.max(0, parseFloat(e.target.value) || 0) })} />
              <button className="shrink-0 text-muted-foreground hover:text-red-400" onClick={() => update((s) => { s.mSim.items = s.mSim.items.filter((i) => i.id !== x.id) })}>
                <X className="h-3.5 w-3.5" />
              </button>
            </div>
          )) : <div className="p-10 text-center text-[0.8125rem] text-muted-foreground">No expenses yet — pull some in above or type your own.</div>}
        </div>
      </Card>
    </div>
  )
}
