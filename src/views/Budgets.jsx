'use client'
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Pencil, Plus, Upload } from 'lucide-react'
import * as XLSX from 'xlsx'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Bar, Ring, Money, CatIcon, budgetTone, ViewToggle } from '@/components/shared'
import { useApp, monthTx, spentIn } from '@/store'
import { useToast } from '@/components/toast'
import { fmt0, today, ymLabel, uid } from '@/lib/utils'

const VIEW_KEY = 'fin-bud-view'

export default function Budgets({ onViewTx }) {
  const { state, update } = useApp()
  const toast = useToast()
  const fileRef = useRef(null)
  const [ym, setYm] = useState(today().slice(0, 7))
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit
  const [view, setView] = useState('list')
  useEffect(() => { try { setView(localStorage.getItem(VIEW_KEY) || 'list') } catch {} }, [])
  const changeView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v) } catch {} }

  const shift = (n) => {
    const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)
    setYm(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'))
  }

  const totalBudget = state.budgets.reduce((s, b) => s + b.limit, 0)
  const totalSpent = state.budgets.reduce((s, b) => s + spentIn(state, ym, b.id), 0)
  const debtPaid = spentIn(state, ym, 'debt')
  const budgetIds = new Set(state.budgets.map((b) => b.id))
  const unbudgeted = monthTx(state, ym).filter((t) => t.type === 'expense' && !budgetIds.has(t.cat) && t.cat !== 'debt' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
  const maxSp = Math.max(1, ...state.budgets.map((b) => spentIn(state, ym, b.id)))
  const overall = totalBudget ? Math.min(100, Math.round((totalSpent / totalBudget) * 100)) : 0

  const importFile = (file) => {
    if (!file) return
    const rd = new FileReader()
    rd.onload = (e) => {
      try {
        const wbk = XLSX.read(e.target.result, { type: 'array' })
        const rows = XLSX.utils.sheet_to_json(wbk.Sheets[wbk.SheetNames[0]], { header: 1, raw: true, defval: null })
        let updated = 0, added = 0
        update((s) => {
          rows.forEach((r) => {
            if (!r || r.length < 2) return
            const name = (r[0] == null ? '' : String(r[0])).trim()
            let lim = r[1]
            if (typeof lim === 'string') lim = parseFloat(lim.replace(/[$,\s]/g, ''))
            if (!name || lim == null || isNaN(lim) || lim < 0) return
            if (/^(category$|total$|how to|then in|personal finance)/i.test(name)) return
            const b = s.budgets.find((x) => x.name.toLowerCase() === name.toLowerCase() || x.id === name.toLowerCase())
            if (b) { b.limit = lim; updated++ }
            else { s.budgets.push({ id: uid('b'), name, limit: lim }); added++ }
          })
        })
        if (updated + added === 0) toast('No category rows found — keep the template layout: Category | Monthly Limit', 'error')
        else toast(`Budget imported — ${updated} updated${added ? `, ${added} new` : ''}`)
      } catch (err) { toast("Couldn't read that file — save it as .xlsx or .csv", 'error') }
    }
    rd.readAsArrayBuffer(file)
  }

  return (
    <div className="fade-in space-y-6">
      <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" className="hidden" onChange={(e) => { importFile(e.target.files[0]); e.target.value = '' }} />
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="xs" className="px-1.5" onClick={() => shift(-1)}><ChevronLeft /></Button>
          <span className="w-24 text-center text-[0.8125rem] font-semibold">{ymLabel(ym)}</span>
          <Button variant="outline" size="xs" className="px-1.5" onClick={() => shift(1)}><ChevronRight /></Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <Badge>Budgeted <b className="text-foreground">{fmt0(totalBudget)}</b></Badge>
          <Badge>Spent <b className={totalSpent > totalBudget ? 'text-red-400' : 'text-emerald-400'}>{fmt0(totalSpent)}</b></Badge>
          <Badge>Left <b className={totalBudget - totalSpent < 0 ? 'text-red-400' : 'text-foreground'}>{fmt0(totalBudget - totalSpent)}</b></Badge>
          <ViewToggle value={view} onChange={changeView} />
          <Button variant="outline" size="sm" onClick={() => fileRef.current.click()}><Upload />Import</Button>
          <Button size="sm" onClick={() => setEditing(null)}><Plus />Add budget</Button>
        </div>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-around gap-4">
          <div className="text-center">
            <Money value={fmt0(totalSpent)} className={`text-2xl font-extrabold sm:text-3xl ${totalSpent > totalBudget ? 'text-red-400' : ''}`} />
            <div className="mt-0.5 text-[0.75rem] font-semibold text-muted-foreground">spent in {ymLabel(ym).split(' ')[0]}</div>
          </div>
          <Ring pct={overall} color={totalSpent > totalBudget ? '#f4514c' : '#5b9df9'} size={84} stroke={9} />
          <div className="text-center">
            <Money value={fmt0(totalBudget)} className="text-2xl font-extrabold sm:text-3xl" />
            <div className="mt-0.5 text-[0.75rem] font-semibold text-muted-foreground">total budget</div>
          </div>
        </div>
        <div className="mt-4 flex flex-wrap justify-center gap-x-5 gap-y-1 text-[0.6875rem] font-semibold text-muted-foreground">
          <span>Debt payments this month: <b className="text-foreground/80">{fmt0(debtPaid)}</b> (tracked on the Debt page, not in budgets)</span>
          {unbudgeted > 0 && <span>Spending with no budget: <b className="text-amber-400">{fmt0(unbudgeted)}</b></span>}
        </div>
      </Card>

      {view === 'list' ? (
        <Card className="overflow-hidden">
          <div className="flex items-center border-b bg-secondary/40 px-4 py-2.5 text-[0.65625rem] font-bold uppercase tracking-wider text-muted-foreground">
            <span>Spent</span><span className="ml-auto">Budget · tap a row for its transactions</span>
          </div>
          <div className="divide-y divide-border/60">
            {state.budgets.slice().sort((a, b) => spentIn(state, ym, b.id) - spentIn(state, ym, a.id)).map((b) => {
              const sp = spentIn(state, ym, b.id)
              const over = b.limit > 0 && sp > b.limit
              const barPct = b.limit ? Math.min(100, Math.round((sp / b.limit) * 100)) : Math.round((sp / maxSp) * 100)
              const n = monthTx(state, ym).filter((t) => t.type === 'expense' && t.cat === b.id).length
              return (
                <div key={b.id} className="group flex cursor-pointer items-center gap-2 px-3 py-3 transition hover:bg-secondary/40 sm:gap-3 sm:px-4" onClick={() => onViewTx && onViewTx(b.id)}>
                  <span className="flex w-6 shrink-0 justify-center sm:w-7"><CatIcon cat={b.id} className="h-5 w-5" /></span>
                  <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">
                    <div className="truncate text-[0.84375rem] font-bold">{b.name}</div>
                    <div className="truncate text-[0.65625rem] font-semibold text-muted-foreground">
                      {n} purchase{n === 1 ? '' : 's'}{over && <> · <span className="font-bold text-red-400">{fmt0(sp - b.limit)} over</span></>}
                    </div>
                  </div>
                  <span className={`w-14 shrink-0 text-right text-[0.8125rem] font-extrabold sm:w-16 ${over ? 'text-red-400' : ''}`}>{fmt0(sp)}</span>
                  <div className="hidden flex-1 sm:block"><Bar pct={barPct} color={budgetTone(sp, b.limit)} /></div>
                  <span className="w-14 shrink-0 text-right text-[0.8125rem] font-semibold text-muted-foreground sm:w-16">{b.limit ? fmt0(b.limit) : '—'}</span>
                  <button
                    className="shrink-0 text-muted-foreground transition hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100"
                    title="Edit limit"
                    onClick={(e) => { e.stopPropagation(); setEditing(b.id) }}
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                </div>
              )
            })}
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
          {state.budgets.slice().sort((a, b) => spentIn(state, ym, b.id) - spentIn(state, ym, a.id)).map((b) => {
            const sp = spentIn(state, ym, b.id)
            const over = b.limit > 0 && sp > b.limit
            return (
              <Card
                key={b.id}
                className="relative flex cursor-pointer flex-col items-center gap-2 p-4 text-center transition hover:bg-secondary/40"
                onClick={() => onViewTx && onViewTx(b.id)}
              >
                <button
                  className="absolute right-2 top-2 text-muted-foreground transition hover:text-foreground"
                  title="Edit limit"
                  onClick={(e) => { e.stopPropagation(); setEditing(b.id) }}
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <Ring pct={b.limit ? Math.min(100, (sp / b.limit) * 100) : 0} color={budgetTone(sp, b.limit)} size={56} stroke={5}>
                  <CatIcon cat={b.id} className="h-5 w-5" />
                </Ring>
                <div className="w-full truncate text-[0.8125rem] font-bold">{b.name}</div>
                <div className="text-[0.8125rem]">
                  <span className={`font-extrabold ${over ? 'text-red-400' : ''}`}>{fmt0(sp)}</span>
                  <span className="font-semibold text-muted-foreground"> / {b.limit ? fmt0(b.limit) : '—'}</span>
                </div>
                {b.limit > 0 && (
                  <div className={`text-[0.6875rem] font-semibold ${over ? 'text-red-400' : 'text-muted-foreground'}`}>
                    {over ? `${fmt0(sp - b.limit)} over` : `${fmt0(b.limit - sp)} left`}
                  </div>
                )}
              </Card>
            )
          })}
        </div>
      )}
      <p className="text-[0.6875rem] text-muted-foreground/70">
        Tap the pencil to change a limit, or use Import with the Budget Template.xlsx — columns: Category | Monthly Limit. Matching is by name; new names become new categories.
      </p>

      {editing !== undefined && <BudgetDialog id={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

function BudgetDialog({ id, onClose }) {
  const { state, update } = useApp()
  const toast = useToast()
  const b = id ? state.budgets.find((x) => x.id === id) : { name: '', limit: '' }
  const [f, setF] = useState({ ...b })
  const save = () => {
    if (!String(f.name).trim()) return toast('Enter a name', 'error')
    update((s) => {
      const limit = parseFloat(f.limit) || 0
      if (id) Object.assign(s.budgets.find((x) => x.id === id), { name: f.name.trim(), limit })
      else s.budgets.push({ id: uid('b'), name: f.name.trim(), limit })
    })
    toast(id ? 'Budget updated' : 'Budget added')
    onClose()
  }
  const del = () => {
    if (!confirm(`Delete the "${b.name}" budget? Its transactions are kept and will show as unbudgeted.`)) return
    update((s) => { s.budgets = s.budgets.filter((x) => x.id !== id) })
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{id ? 'Edit' : 'New'} Budget</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Date nights" /></div>
          <div><Label>Monthly limit ($) <span className="opacity-60">0 = no limit</span></Label><Input type="number" min="0" step="1" value={f.limit} onChange={(e) => setF({ ...f, limit: e.target.value })} /></div>
        </div>
        <DialogFooter>
          {id && <Button variant="destructive" className="mr-auto" onClick={del}>Delete</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
