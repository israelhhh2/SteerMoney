'use client'
import { useEffect, useState } from 'react'
import {
  Plus, Flag, Check, Target, PiggyBank, Plane, Home, Car, Gift, Heart, GraduationCap, Umbrella, ShieldAlert, Sparkles,
} from 'lucide-react'
import { LineChart, Line, XAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { Bar, Ring, Money, SectionLabel, ViewToggle, ConfirmDialog } from '@/components/shared'
import { useApp } from '@/store'
import { useToast, useCenterToast } from '@/components/toast'
import { fmt0, today, prettyDate, ymLabel, uid } from '@/lib/utils'

export const ICONS = {
  piggybank: PiggyBank, plane: Plane, home: Home, car: Car, gift: Gift,
  heart: Heart, graduation: GraduationCap, umbrella: Umbrella, shield: ShieldAlert, sparkles: Sparkles,
}
const ICON_LIST = Object.keys(ICONS)

const METHOD_LABELS = { transfer: 'Bank transfer', cash: 'Cash set aside', deposit: 'Deposit', other: 'Other' }
const METHOD_OPTIONS = Object.entries(METHOD_LABELS)

const VIEW_KEY = 'fin-goal-view'

function GoalIcon({ icon, className = 'h-5 w-5' }) {
  const I = ICONS[icon] || Target
  return <I className={className} />
}

const TIP = { contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 } }

const savedTotal = (g) => (g.txs || []).reduce((s, t) => s + t.amount, 0)

function monthsLeft(targetDate) {
  const [ny, nm] = today().slice(0, 7).split('-').map(Number)
  const [ty, tm] = targetDate.split('-').map(Number)
  return Math.max(1, (ty - ny) * 12 + (tm - nm))
}

function neededPerMonth(g) {
  if (!g.targetDate) return 0
  return Math.max(0, (g.target - savedTotal(g)) / monthsLeft(g.targetDate))
}

// current month + next 5, as 'YYYY-MM'
function nextMonths(n) {
  const [y, m] = today().slice(0, 7).split('-').map(Number)
  return Array.from({ length: n }, (_, i) => {
    const d = new Date(y, m - 1 + i, 1)
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
  })
}

function cumulativeSeries(g) {
  let running = 0
  return (g.txs || []).slice().sort((a, b) => a.date.localeCompare(b.date))
    .map((t) => { running += t.amount; return { name: prettyDate(t.date), value: running } })
}

export default function Goals() {
  const { state: appState } = useApp()
  const state = { ...appState, goals: appState.goals || [] } // guards stale caches from before the goals table existed
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit
  const [detailId, setDetailId] = useState(null)
  const [view, setView] = useState('cards')
  useEffect(() => { try { setView(localStorage.getItem(VIEW_KEY) || 'cards') } catch {} }, [])
  const changeView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v) } catch {} }

  if (!state.goals.length) {
    return (
      <div className="fade-in space-y-6">
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Flag className="h-8 w-8 text-primary" />
          <h3 className="text-[0.9375rem] font-bold">Set your first goal</h3>
          <p className="max-w-sm text-[0.78125rem] text-muted-foreground">
            Goals help you save toward something specific, like a trip, a house, or an emergency fund, by tracking contributions and showing how close you are.
          </p>
          <Button onClick={() => setEditing(null)}><Plus />Add your first goal</Button>
        </Card>
        {editing !== undefined && <GoalEditorDialog id={editing} onClose={() => setEditing(undefined)} />}
      </div>
    )
  }

  const activeGoals = state.goals.filter((g) => g.status === 'active')
  const nowYm = today().slice(0, 7)
  const savedThisMonth = activeGoals.flatMap((g) => g.txs || []).filter((t) => t.date.startsWith(nowYm)).reduce((s, t) => s + t.amount, 0)
  const neededSum = activeGoals.reduce((s, g) => s + neededPerMonth(g), 0)
  const toGoThisMonth = Math.max(0, neededSum - savedThisMonth)
  const ringTotal = savedThisMonth + toGoThisMonth
  const pct = ringTotal > 0 ? (savedThisMonth / ringTotal) * 100 : 0

  const inProgress = activeGoals.filter((g) => savedTotal(g) < g.target)
  const ready = activeGoals.filter((g) => savedTotal(g) >= g.target)
  const archived = state.goals.filter((g) => g.status === 'archived')
  const detailGoal = detailId ? state.goals.find((g) => g.id === detailId) : null
  const monthShort = ymLabel(nowYm).split(' ')[0]

  return (
    <div className="fade-in space-y-6">
      <div className="flex items-center justify-end gap-2">
        <ViewToggle value={view} onChange={changeView} />
        <Button size="sm" onClick={() => setEditing(null)}><Plus />Add goal</Button>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-around gap-4">
          <div className="text-center">
            <Money value={fmt0(savedThisMonth)} className="text-2xl font-extrabold sm:text-3xl" />
            <div className="mt-0.5 text-[0.75rem] font-semibold text-muted-foreground">saved in {monthShort}</div>
          </div>
          <Ring pct={pct} color="#5b9df9" size={84} stroke={9} />
          <div className="text-center">
            <Money value={fmt0(toGoThisMonth)} className="text-2xl font-extrabold sm:text-3xl" />
            <div className="mt-0.5 text-[0.75rem] font-semibold text-muted-foreground">to go in {monthShort}</div>
          </div>
        </div>
      </Card>

      {inProgress.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Active" />
          {view === 'list' ? (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {inProgress.map((g) => <GoalRow key={g.id} goal={g} onClick={() => setDetailId(g.id)} />)}
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {inProgress.map((g) => <GoalCard key={g.id} goal={g} onClick={() => setDetailId(g.id)} />)}
            </div>
          )}
        </div>
      )}

      {ready.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Ready to spend" />
          {view === 'list' ? (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {ready.map((g) => <GoalRow key={g.id} goal={g} onClick={() => setDetailId(g.id)} />)}
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {ready.map((g) => <GoalCard key={g.id} goal={g} onClick={() => setDetailId(g.id)} />)}
            </div>
          )}
        </div>
      )}

      {archived.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Archived" />
          {view === 'list' ? (
            <Card className="divide-y divide-border/60 overflow-hidden">
              {archived.map((g) => <GoalRow key={g.id} goal={g} onClick={() => setDetailId(g.id)} mutedAmount />)}
            </Card>
          ) : (
            <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4">
              {archived.map((g) => <GoalCard key={g.id} goal={g} onClick={() => setDetailId(g.id)} muted />)}
            </div>
          )}
        </div>
      )}

      {editing !== undefined && <GoalEditorDialog id={editing} onClose={() => setEditing(undefined)} />}
      {detailGoal && <GoalDetailDialog goal={detailGoal} onClose={() => setDetailId(null)} onEdit={(id) => setEditing(id)} />}
    </div>
  )
}

function GoalRow({ goal, onClick, mutedAmount }) {
  const saved = savedTotal(goal)
  const showProgress = goal.status === 'active' && saved < goal.target
  return (
    <div className="cursor-pointer px-4 py-3 transition hover:bg-secondary/40" onClick={onClick}>
      <div className="flex items-center gap-3">
        <span className="flex w-7 shrink-0 justify-center text-primary"><GoalIcon icon={goal.icon} /></span>
        <div className="min-w-0 flex-1 truncate text-[0.84375rem] font-bold">{goal.name}</div>
        <div className="shrink-0 text-right text-[0.8125rem]">
          <span className={`font-extrabold ${mutedAmount ? 'text-muted-foreground' : 'text-foreground'}`}>{fmt0(saved)}</span>
          <span className="font-semibold text-muted-foreground"> / {fmt0(goal.target)}</span>
        </div>
      </div>
      {showProgress && (goal.targetDate ? <ProgressFooter goal={goal} /> : <MonthCircles goal={goal} />)}
    </div>
  )
}

function GoalCard({ goal, onClick, muted }) {
  const saved = savedTotal(goal)
  const reached = goal.target > 0 && saved >= goal.target
  const pct = goal.target ? Math.min(100, (saved / goal.target) * 100) : 0
  return (
    <Card
      className={`cursor-pointer p-4 transition hover:bg-secondary/40 ${muted ? 'opacity-60' : ''}`}
      onClick={onClick}
    >
      <div className="flex items-center gap-2">
        <span className="flex w-6 shrink-0 justify-center text-primary"><GoalIcon icon={goal.icon} className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold">{goal.name}</div>
      </div>
      <div className="mt-2.5">
        <Money value={fmt0(saved)} className="text-base font-extrabold" />
        <span className="ml-1 text-[0.75rem] font-semibold text-muted-foreground">of {fmt0(goal.target)}</span>
      </div>
      <div className="mt-2"><Bar pct={reached ? 100 : pct} color="#2fbf71" /></div>
      {goal.targetDate && (
        <div className="mt-1 text-[0.625rem] font-semibold text-muted-foreground">
          {reached ? ymLabel(goal.targetDate) : `${monthsLeft(goal.targetDate)} mo left · ${ymLabel(goal.targetDate)}`}
        </div>
      )}
    </Card>
  )
}

function ProgressFooter({ goal }) {
  const pct = goal.target ? Math.min(100, (savedTotal(goal) / goal.target) * 100) : 0
  return (
    <div className="mt-2 pl-10">
      <Bar pct={pct} color="#2fbf71" />
      <div className="mt-1 flex items-center justify-between text-[0.6875rem] font-semibold text-muted-foreground">
        <span>{monthsLeft(goal.targetDate)} months left</span>
        <span className="flex items-center gap-1"><Flag className="h-3 w-3" />{ymLabel(goal.targetDate)}</span>
      </div>
    </div>
  )
}

function MonthCircles({ goal }) {
  return (
    <div className="mt-2.5 flex justify-between pl-10 pr-2">
      {nextMonths(6).map((ym, i) => {
        const has = (goal.txs || []).some((t) => t.date.startsWith(ym))
        const [mon, yr] = ymLabel(ym).split(' ')
        return (
          <div key={ym} className="flex flex-col items-center gap-1">
            <div className={`flex h-10 w-10 items-center justify-center rounded-full border-2 ${has ? 'border-[#2fbf71] bg-[#2fbf71]/10' : 'border-border'}`}>
              {has && <Check className="h-4 w-4 text-[#2fbf71]" />}
            </div>
            <span className="text-[0.625rem] font-semibold text-muted-foreground">{mon}</span>
            {i === 0 && <span className="text-[0.5625rem] text-muted-foreground/60">{yr}</span>}
          </div>
        )
      })}
    </div>
  )
}

function GoalDetailDialog({ goal, onClose, onEdit }) {
  const { update } = useApp()
  const toast = useToast()
  const [addingTx, setAddingTx] = useState(false)
  const [tx, setTx] = useState({ amount: '', date: today(), note: '', method: 'transfer' })

  const saved = savedTotal(goal)
  const toGo = Math.max(0, goal.target - saved)
  const reached = saved >= goal.target
  const need = neededPerMonth(goal)
  const series = cumulativeSeries(goal)
  const txList = (goal.txs || []).slice().sort((a, b) => b.date.localeCompare(a.date))

  const saveTx = () => {
    const amount = parseFloat(tx.amount)
    if (isNaN(amount) || amount === 0) return toast('Enter an amount', 'error')
    update((s) => {
      s.goals.find((x) => x.id === goal.id).txs.push({ id: uid('gtx'), date: tx.date, amount, note: tx.note.trim() || null, method: tx.method })
    })
    toast('Progress updated')
    setAddingTx(false)
    setTx({ amount: '', date: today(), note: '', method: 'transfer' })
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <div className="flex items-center gap-2">
            <GoalIcon icon={goal.icon} className="h-5 w-5 text-primary" />
            <DialogTitle>{goal.name}</DialogTitle>
          </div>
        </DialogHeader>

        <div>
          <Money value={fmt0(saved)} className="text-2xl font-extrabold" />
          {reached ? (
            <div className="mt-0.5 text-[0.75rem] font-bold text-emerald-400">Goal reached</div>
          ) : (
            <div className="mt-0.5 text-[0.75rem] font-semibold text-muted-foreground">{fmt0(toGo)} to go</div>
          )}
        </div>

        {series.length > 0 && (
          <div className="h-40">
            <ResponsiveContainer>
              <LineChart data={series}>
                <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                <Tooltip {...TIP} formatter={(v) => fmt0(v)} />
                <Line type="monotone" dataKey="value" stroke="#2fbf71" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        {goal.targetDate && !reached && (
          <div className="text-[0.75rem] font-semibold text-muted-foreground">You need to save <span className="text-foreground">{fmt0(need)}</span> per month</div>
        )}

        <div className="grid grid-cols-2 gap-3 rounded-lg border bg-secondary/40 p-3 text-[0.78125rem]">
          <div><div className="text-muted-foreground">Goal amount</div><div className="font-bold">{fmt0(goal.target)}</div></div>
          <div><div className="text-muted-foreground">Target date</div><div className="font-bold">{goal.targetDate ? ymLabel(goal.targetDate) : '—'}</div></div>
        </div>

        <div className="max-h-40 space-y-1.5 overflow-y-auto">
          {txList.length ? txList.map((t) => (
            <div key={t.id} className="flex items-center justify-between text-[0.78125rem]">
              <div>
                <span className="font-semibold">{prettyDate(t.date)}</span>
                <span className="ml-2 text-muted-foreground">{t.note || METHOD_LABELS[t.method] || 'Contribution'}</span>
              </div>
              <span className={`font-bold ${t.amount < 0 ? 'text-red-400' : 'text-emerald-400'}`}>
                {t.amount < 0 ? '−' : '+'}{fmt0(Math.abs(t.amount))}
              </span>
            </div>
          )) : <div className="py-4 text-center text-[0.75rem] text-muted-foreground">No contributions yet.</div>}
        </div>

        {addingTx && (
          <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
            <div><Label>Amount ($)</Label><Input type="number" step="0.01" value={tx.amount} onChange={(e) => setTx({ ...tx, amount: e.target.value })} placeholder="-50 to withdraw" /></div>
            <div><Label>Date</Label><Input type="date" value={tx.date} onChange={(e) => setTx({ ...tx, date: e.target.value })} /></div>
            <div><Label>Note (optional)</Label><Input value={tx.note} onChange={(e) => setTx({ ...tx, note: e.target.value })} /></div>
            <div className="sm:col-span-3">
              <Label>Method</Label>
              <Segmented value={tx.method} onChange={(v) => setTx({ ...tx, method: v })} options={METHOD_OPTIONS} />
            </div>
          </div>
        )}

        <DialogFooter>
          {addingTx ? (
            <>
              <Button variant="ghost" onClick={() => setAddingTx(false)}>Cancel</Button>
              <Button onClick={saveTx}>Save</Button>
            </>
          ) : goal.status === 'archived' ? (
            <Button variant="outline" onClick={() => { update((s) => { s.goals.find((x) => x.id === goal.id).status = 'active' }); toast('Goal unarchived') }}>Unarchive</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => { onClose(); onEdit(goal.id) }}>Goal settings</Button>
              <Button onClick={() => setAddingTx(true)}>Update progress</Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function GoalEditorDialog({ id, onClose }) {
  const { state: appState, update } = useApp()
  const goals = appState.goals || [] // guards stale caches from before the goals table existed
  const toast = useToast()
  const centerToast = useCenterToast()
  const g = id ? goals.find((x) => x.id === id) : { name: '', icon: ICON_LIST[0], target: '', targetDate: '', status: 'active' }
  const [f, setF] = useState({ ...g, targetDate: g.targetDate || '' })
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const save = () => {
    const name = String(f.name).trim()
    if (!name) return toast('Enter a name', 'error')
    const target = parseFloat(f.target)
    if (isNaN(target) || target <= 0) return toast('Enter a goal amount', 'error')
    update((s) => {
      const data = { name, icon: f.icon, target, targetDate: f.targetDate || null }
      if (id) Object.assign(s.goals.find((x) => x.id === id), data)
      else s.goals.push({ id: uid('g'), ...data, status: 'active', txs: [] })
    })
    toast(id ? 'Goal updated' : 'Goal added')
    onClose()
  }
  const toggleArchive = () => {
    update((s) => { const gg = s.goals.find((x) => x.id === id); gg.status = gg.status === 'archived' ? 'active' : 'archived' })
    toast(g.status === 'archived' ? 'Goal unarchived' : 'Goal archived')
    onClose()
  }
  const del = async () => {
    // Deletion itself is a synchronous store mutation, but a brief busy state
    // (spinner in ConfirmDialog's `busy` prop) gives the same "it's working"
    // feedback as the async Plaid-disconnect path elsewhere in the app.
    setDeleting(true)
    await new Promise((r) => setTimeout(r, 350))
    try {
      update((s) => { s.goals = s.goals.filter((x) => x.id !== id) })
      centerToast('Goal deleted')
      setDeleting(false)
      setConfirmDel(false)
      onClose()
    } catch (e) {
      centerToast(e?.message || 'Something went wrong', 'error')
      setDeleting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{id ? 'Edit' : 'New'} Goal</DialogTitle></DialogHeader>
        <div className="grid gap-3">
          <div><Label>Name</Label><Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Trip to Japan" /></div>
          <div>
            <Label>Icon</Label>
            <div className="flex flex-wrap gap-2">
              {ICON_LIST.map((k) => {
                const I = ICONS[k]
                return (
                  <button
                    key={k}
                    type="button"
                    onClick={() => setF({ ...f, icon: k })}
                    className={`flex h-9 w-9 items-center justify-center rounded-lg border transition ${f.icon === k ? 'ring-1 ring-primary bg-primary/10' : 'hover:bg-secondary/50'}`}
                  >
                    <I className="h-4 w-4" />
                  </button>
                )
              })}
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label>Goal amount ($)</Label><Input type="number" min="0" step="1" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></div>
            <div>
              <Label>Target date <span className="opacity-60">optional</span></Label>
              <div className="flex gap-1.5">
                <Input type="month" value={f.targetDate} onChange={(e) => setF({ ...f, targetDate: e.target.value })} />
                {f.targetDate && <Button variant="outline" size="xs" onClick={() => setF({ ...f, targetDate: '' })}>Clear</Button>}
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          {id && <Button variant="destructive" className="mr-auto" onClick={() => setConfirmDel(true)}>Delete</Button>}
          {id && <Button variant="outline" onClick={toggleArchive}>{g.status === 'archived' ? 'Unarchive' : 'Archive'}</Button>}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
      {confirmDel && (
        <ConfirmDialog
          title={`Delete the "${g.name}" goal?`}
          desc="This can't be undone."
          busy={deleting}
          onConfirm={del}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </Dialog>
  )
}
