'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, Wallet, CreditCard, Landmark } from 'lucide-react'
import { LineChart, Line, XAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Money, SectionLabel } from '@/components/shared'
import { ConnectBankButton } from '@/components/connect-bank'
import { useApp } from '@/store'
import { useToast } from '@/components/toast'
import { fmt0, today, isoDate, prettyDate, uid } from '@/lib/utils'
import { matchesBankAccount } from '@/lib/finance'

const TIP = { contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 } }

const TYPE_GROUPS = [['depository', 'Depository'], ['investment', 'Investments'], ['other', 'Other']]

// ---- daily series for the header chart (approximate on purpose) ----

function lastNDays(n) {
  const out = []
  const base = new Date(today() + 'T00:00:00')
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(base)
    d.setDate(d.getDate() - i)
    out.push(isoDate(d))
  }
  return out
}

// Carry the last known balance forward per day; accounts with no history
// contribute their current balance flat, and days before the first known
// entry fall back to that earliest entry.
function assetsOn(accounts, date) {
  return accounts.reduce((sum, a) => {
    const hist = (a.history || []).slice().sort((x, y) => x.date.localeCompare(y.date))
    if (!hist.length) return sum + (a.balance || 0)
    let val = hist[0].balance
    for (const h of hist) { if (h.date <= date) val = h.balance; else break }
    return sum + val
  }, 0)
}

// Walk backward from the current balance: a payment made after the day in
// question hadn't happened yet, so add it back.
function debtsOn(debts, date) {
  return debts.reduce((sum, d) => {
    const future = (d.payments || []).filter((p) => p.date > date)
    const bal = d.balance + future.reduce((s, p) => s + p.amount, 0)
    return sum + Math.max(0, bal)
  }, 0)
}

// Depository/investment Plaid accounts have no local history, so they carry
// their current balance flat across the whole window (assetsOn already does
// this for any account missing a `history` array).
function buildSeries(accounts, debts, plaidAssetAccounts) {
  const manual = accounts.filter((a) => a.type !== 'credit' && a.type !== 'loan')
  const merged = [...manual, ...(plaidAssetAccounts || [])]
  return lastNDays(90).map((date) => ({
    name: prettyDate(date),
    assets: Math.round(assetsOn(merged, date)),
    debts: Math.round(debtsOn(debts, date)),
  }))
}

// Stable-ish identity for a Plaid account row, used to line up "this debt
// matches this connected account" without relying on account_id existing on
// older, not-yet-resynced rows.
const acctKey = (a) => a.account_id || `${a.mask || ''}|${(a.name || '').toLowerCase()}`

export default function Accounts() {
  const { state } = useApp()
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit
  const [plaidItems, setPlaidItems] = useState([])
  const [plaidChecked, setPlaidChecked] = useState(false)

  useEffect(() => {
    let on = true
    fetch('/api/plaid/items')
      .then((r) => r.json())
      .then((d) => { if (on) { setPlaidItems(d.items || []); setPlaidChecked(true) } })
      .catch(() => { if (on) setPlaidChecked(true) })
    return () => { on = false }
  }, [])

  // Depository/investment Plaid accounts count as assets; credit/loan-type
  // ones stay out of both Assets and Debts — the Debt Tracker is the source
  // of truth for those, this view only shows their balance with a hint.
  const plaidAssetAccounts = useMemo(
    () => plaidItems.flatMap((it) => (it.accounts || []).filter((a) => a.type === 'depository' || a.type === 'investment')),
    [plaidItems]
  )
  const plaidAccountsFlat = useMemo(
    () => plaidItems.flatMap((it) => (it.accounts || []).map((a) => ({ ...a, institution: it.institution }))),
    [plaidItems]
  )
  const matchedAccountIds = useMemo(() => {
    const set = new Set()
    state.debts.forEach((d) => {
      const m = matchesBankAccount(d, plaidAccountsFlat)
      if (m) set.add(acctKey(m))
    })
    return set
  }, [state.debts, plaidAccountsFlat])

  const manualAssets = state.accounts.filter((a) => a.type !== 'credit' && a.type !== 'loan').reduce((s, a) => s + a.balance, 0)
  const plaidAssets = plaidAssetAccounts.reduce((s, a) => s + (a.balance || 0), 0)
  const assetsTotal = manualAssets + plaidAssets
  const debtsTotal = state.debts.reduce((s, d) => s + d.balance, 0)

  const series = useMemo(() => buildSeries(state.accounts, state.debts, plaidAssetAccounts), [state.accounts, state.debts, plaidAssetAccounts])

  const cards = state.debts.filter((d) => d.limit).slice().sort((a, b) => b.balance - a.balance)
  const loans = state.debts.filter((d) => !d.limit).slice().sort((a, b) => b.balance - a.balance)
  const byType = { depository: [], investment: [], other: [] }
  state.accounts.forEach((a) => { (byType[a.type] || byType.other).push(a) })

  const isEmpty = !state.accounts.length && !state.debts.length && plaidChecked && !plaidItems.length

  if (isEmpty) {
    return (
      <div className="fade-in space-y-6">
        <Card className="flex flex-col items-center gap-3 p-10 text-center">
          <Wallet className="h-8 w-8 text-primary" />
          <h3 className="text-[0.9375rem] font-bold">Track your accounts</h3>
          <p className="max-w-sm text-[0.78125rem] text-muted-foreground">
            Track balances for checking, savings, and investments here. Credit cards and loans live in the Debt Tracker.
          </p>
          <div className="flex flex-wrap justify-center gap-2">
            <Button onClick={() => setEditing(null)}><Plus />Add account</Button>
            <ConnectBankButton variant="outline" />
          </div>
        </Card>
        {editing !== undefined && <AccountDialog id={editing} onClose={() => setEditing(undefined)} />}
      </div>
    )
  }

  return (
    <div className="fade-in space-y-6">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <ConnectBankButton variant="outline" size="sm" />
        <Button size="sm" onClick={() => setEditing(null)}><Plus />Add account</Button>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-around gap-4">
          <div className="text-center">
            <div className="mb-1 flex items-center justify-center gap-1.5 text-[0.75rem] font-semibold text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: '#5b9df9' }} />Assets
            </div>
            <Money value={fmt0(assetsTotal)} className="text-2xl font-extrabold sm:text-3xl" />
          </div>
          <div className="text-center">
            <div className="mb-1 flex items-center justify-center gap-1.5 text-[0.75rem] font-semibold text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: '#e08a3d' }} />Debts
            </div>
            <Money value={fmt0(debtsTotal)} className="text-2xl font-extrabold sm:text-3xl" />
          </div>
        </div>
        {series.length > 0 && (
          <div className="mt-4 h-40">
            <ResponsiveContainer>
              <LineChart data={series}>
                <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} interval="preserveStartEnd" axisLine={false} tickLine={false} />
                <Tooltip {...TIP} formatter={(v, n) => [fmt0(v), n === 'assets' ? 'Assets' : 'Debts']} />
                <Line type="monotone" dataKey="assets" stroke="#5b9df9" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="debts" stroke="#e08a3d" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      {cards.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Credit cards" />
          <Card className="divide-y divide-border/60 overflow-hidden">
            {cards.map((d) => <DebtRow key={d.id} debt={d} />)}
            <GroupTotal value={cards.reduce((s, d) => s + d.balance, 0)} />
          </Card>
        </div>
      )}

      {loans.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Loans" />
          <Card className="divide-y divide-border/60 overflow-hidden">
            {loans.map((d) => <DebtRow key={d.id} debt={d} />)}
            <GroupTotal value={loans.reduce((s, d) => s + d.balance, 0)} />
          </Card>
        </div>
      )}

      {TYPE_GROUPS.map(([type, label]) => {
        const list = byType[type]
        if (!list.length) return null
        return (
          <div key={type} className="space-y-2.5">
            <SectionLabel title={label} />
            <Card className="divide-y divide-border/60 overflow-hidden">
              {list.map((a) => <AccountRow key={a.id} account={a} onClick={() => setEditing(a.id)} />)}
              <GroupTotal value={list.reduce((s, a) => s + a.balance, 0)} />
            </Card>
          </div>
        )
      })}

      {plaidItems.length > 0 && (
        <div className="space-y-2.5">
          <SectionLabel title="Connected banks" />
          <Card className="divide-y divide-border/60 overflow-hidden">
            {plaidItems.map((it) => <PlaidItemRow key={it.id} item={it} matchedAccountIds={matchedAccountIds} />)}
          </Card>
          <p className="text-[0.6875rem] text-muted-foreground/70">Connected accounts update when you sync from Settings.</p>
        </div>
      )}

      {editing !== undefined && <AccountDialog id={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

function GroupTotal({ value }) {
  return (
    <div className="flex items-center justify-between bg-secondary/20 px-4 py-2.5">
      <span className="text-[0.71875rem] font-semibold text-muted-foreground">Total</span>
      <Money value={fmt0(value)} className="text-[0.8125rem] font-extrabold" />
    </div>
  )
}

function DebtRow({ debt }) {
  return (
    <Link href="/debts" className="flex items-center gap-3 px-4 py-3 transition hover:bg-accent/60">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary/60 text-muted-foreground"><CreditCard className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.84375rem] font-bold">{debt.name}</div>
        <div className="text-[0.6875rem] text-muted-foreground">tracked in Debt Tracker</div>
      </div>
      <Money value={fmt0(debt.balance)} className="shrink-0 text-[0.8125rem] font-extrabold text-red-400" />
    </Link>
  )
}

function Sparkline({ history }) {
  const pts = (history || []).slice(-30)
  if (pts.length < 2) return null
  const vals = pts.map((p) => p.balance)
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const range = max - min || 1
  const w = 90, h = 24
  const step = w / (pts.length - 1)
  const coords = vals.map((v, i) => `${(i * step).toFixed(1)},${(h - ((v - min) / range) * h).toFixed(1)}`).join(' ')
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} className="hidden shrink-0 sm:block">
      <polyline points={coords} fill="none" stroke="#5b9df9" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function ChangeBadge({ account }) {
  const cutoff = new Date(today() + 'T00:00:00')
  cutoff.setDate(cutoff.getDate() - 30)
  const cutoffIso = isoDate(cutoff)
  const recent = (account.history || []).filter((h) => h.date >= cutoffIso).slice().sort((a, b) => a.date.localeCompare(b.date))
  if (!recent.length) return null
  const oldest = recent[0].balance
  if (!oldest) return null
  const pct = ((account.balance - oldest) / Math.abs(oldest)) * 100
  const positive = pct >= 0
  return <Badge variant={positive ? 'success' : 'destructive'}>{positive ? '+' : ''}{pct.toFixed(1)}%</Badge>
}

function AccountRow({ account, onClick }) {
  return (
    <button onClick={onClick} className="flex w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-accent/60">
      <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary/60 text-muted-foreground"><Landmark className="h-4 w-4" /></span>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[0.84375rem] font-bold">
          {account.name}
          {account.mask ? <span className="ml-1.5 font-semibold text-muted-foreground">•• {account.mask}</span> : null}
        </div>
        <div className="text-[0.6875rem] text-muted-foreground">{account.institution || 'Manual account'}</div>
      </div>
      <Sparkline history={account.history} />
      <div className="shrink-0 space-y-0.5 text-right">
        <ChangeBadge account={account} />
        <Money value={fmt0(account.balance)} className="block text-[0.8125rem] font-extrabold" />
      </div>
    </button>
  )
}

function PlaidItemRow({ item, matchedAccountIds }) {
  const accounts = item.accounts || []
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-secondary/60 text-muted-foreground"><Landmark className="h-4 w-4" /></span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.84375rem] font-bold">{item.institution || 'Bank'}</div>
          <div className="text-[0.6875rem] text-muted-foreground">
            {item.last_synced ? `Synced ${prettyDate(item.last_synced.slice(0, 10))}` : 'Not yet synced'}
          </div>
        </div>
      </div>
      {accounts.length > 0 ? (
        <div className="mt-2.5 space-y-2 pl-[2.75rem]">
          {accounts.map((a, i) => {
            const isDebtType = a.type === 'credit' || a.type === 'loan'
            const matched = isDebtType && matchedAccountIds.has(acctKey(a))
            return (
              <div key={acctKey(a) + i} className="flex items-center gap-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.78125rem] font-medium">
                    {a.name}
                    {a.mask ? <span className="ml-1.5 font-normal text-muted-foreground">•• {a.mask}</span> : null}
                  </div>
                  {isDebtType && (
                    <div className="truncate text-[0.65625rem] text-muted-foreground/80">
                      {matched ? 'tracked as debt below' : 'add it in the Debt Tracker to include it in payoff tools'}
                    </div>
                  )}
                </div>
                {a.balance != null && <Money value={fmt0(a.balance)} className="shrink-0 text-[0.8125rem] font-semibold" />}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="mt-2 pl-[2.75rem] text-[0.6875rem] text-muted-foreground">No accounts found</p>
      )}
    </div>
  )
}

function ConfirmDialog({ title, desc, onConfirm, onClose }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {desc ? <p className="text-[0.8125rem] text-muted-foreground">{desc}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm}>Delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function AccountDialog({ id, onClose }) {
  const { state, update } = useApp()
  const toast = useToast()
  const a = id ? state.accounts.find((x) => x.id === id) : { name: '', type: 'depository', institution: '', mask: '', balance: '' }
  const [f, setF] = useState({ ...a })
  const [confirmDel, setConfirmDel] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  const save = () => {
    const name = String(f.name).trim()
    if (!name) return toast('Enter a name', 'error')
    const balance = parseFloat(f.balance)
    if (isNaN(balance)) return toast('Enter a balance', 'error')
    const institution = String(f.institution || '').trim()
    const mask = String(f.mask || '').trim().slice(0, 4)
    update((s) => {
      if (id) {
        const acc = s.accounts.find((x) => x.id === id)
        acc.name = name
        acc.institution = institution
        acc.mask = mask
        if (balance !== acc.balance) {
          acc.balance = balance
          const d = today()
          acc.history = acc.history || []
          const entry = acc.history.find((h) => h.date === d)
          if (entry) entry.balance = balance
          else acc.history.push({ date: d, balance })
        }
      } else {
        s.accounts.push({ id: uid('a'), name, type: f.type, institution, mask, balance, history: [{ date: today(), balance }] })
      }
    })
    toast(id ? 'Account updated' : 'Account added')
    onClose()
  }

  const del = () => {
    update((s) => { s.accounts = s.accounts.filter((x) => x.id !== id) })
    toast('Account deleted')
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{id ? 'Edit' : 'Add'} Account</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>Name</Label><Input value={f.name} onChange={set('name')} placeholder="e.g. Everyday Checking" /></div>
          {!id && (
            <div className="sm:col-span-2">
              <Label>Type</Label>
              <Select className="w-full" value={f.type} onChange={set('type')}>
                <option value="depository">Checking or Savings</option>
                <option value="investment">Investment</option>
                <option value="other">Other</option>
              </Select>
              <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">Add credit cards and loans in the Debt Tracker so payoff tools work.</p>
            </div>
          )}
          <div><Label>Institution <span className="opacity-60">optional</span></Label><Input value={f.institution} onChange={set('institution')} placeholder="e.g. Chase" /></div>
          <div><Label>Mask / last 4 <span className="opacity-60">optional</span></Label><Input value={f.mask} maxLength={4} onChange={set('mask')} placeholder="0015" /></div>
          <div className="sm:col-span-2"><Label>{id ? 'Update balance' : 'Current balance'} ($)</Label><Input type="number" step="0.01" value={f.balance} onChange={set('balance')} /></div>
        </div>
        <DialogFooter>
          {id ? <Button variant="destructive" className="mr-auto" onClick={() => setConfirmDel(true)}>Delete</Button> : null}
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
      {confirmDel && (
        <ConfirmDialog
          title={`Delete "${a.name}"?`}
          desc="This removes the account and its balance history. This can't be undone."
          onConfirm={() => { setConfirmDel(false); del() }}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </Dialog>
  )
}
