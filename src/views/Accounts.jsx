'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Plus, Wallet, ChevronDown, ChevronRight } from 'lucide-react'
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Segmented } from '@/components/ui/segmented'
import { Money, CardChip, SourceBadge, ConfirmDialog, SyncingPill } from '@/components/shared'
import { ConnectBankButton } from '@/components/connect-bank'
import { useApp } from '@/store'
import { useToast, useCenterToast } from '@/components/toast'
import { cn, fmt0, today, uid } from '@/lib/utils'
import {
  RANGE_KEYS, daysFor, buildSeries, pctChange, pctChange30,
  buildAccountInventory, accountUrlId, usePlaidItems, deleteManualAccount,
} from '@/lib/accounts'

const TIP = { contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 } }

// Slate-blue used for Copilot's uppercase micro-labels throughout this page
// (component-scoped per the design brief — not a global token change).
const LABEL_COLOR = '#6f8bb8'

export default function Accounts({ editParam, clearEditParam } = {}) {
  const { state } = useApp()
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit
  const [range, setRange] = useState('3M')
  const { plaidItems, plaidChecked } = usePlaidItems()

  // ?edit=<accountId> arrives from the account detail view's "Edit account"
  // action (manual accounts only) — open the dialog once, then clear the param.
  useEffect(() => {
    if (editParam) { setEditing(editParam); clearEditParam && clearEditParam() }
  }, [editParam])

  const { plaidAssetAccounts, cards, loans, depository } = useMemo(
    () => buildAccountInventory(state, plaidItems),
    [state.debts, state.accounts, plaidItems]
  )

  const manualAssets = state.accounts.filter((a) => a.type !== 'credit' && a.type !== 'loan').reduce((s, a) => s + a.balance, 0)
  const plaidAssets = plaidAssetAccounts.reduce((s, a) => s + (a.balance || 0), 0)
  const assetsTotal = manualAssets + plaidAssets
  const debtsTotal = state.debts.reduce((s, d) => s + d.balance, 0)

  const series = useMemo(
    () => buildSeries(state.accounts, state.debts, plaidAssetAccounts, daysFor(range)),
    [state.accounts, state.debts, plaidAssetAccounts, range]
  )
  const assetsPct = useMemo(() => pctChange(series, 'assets'), [series])
  const debtsPct = useMemo(() => pctChange(series, 'debts'), [series])

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
            <div className="mt-1"><ChangePill pct={assetsPct} /></div>
          </div>
          <div className="text-center">
            <div className="mb-1 flex items-center justify-center gap-1.5 text-[0.75rem] font-semibold text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ background: '#e08a3d' }} />Debt
            </div>
            <Money value={fmt0(debtsTotal)} className="text-2xl font-extrabold sm:text-3xl" />
            <div className="mt-1"><ChangePill pct={debtsPct} invert /></div>
          </div>
        </div>
        {series.length > 1 && (
          <div className="mt-4 h-40">
            <ResponsiveContainer>
              <AreaChart data={series} margin={{ top: 8, right: 4, left: 4, bottom: 0 }}>
                <defs>
                  <linearGradient id="acctAssets" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#5b9df9" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#5b9df9" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="acctDebt" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#e08a3d" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#e08a3d" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <XAxis dataKey="name" hide />
                <Tooltip {...TIP} formatter={(v, n) => [fmt0(v), n === 'assets' ? 'Assets' : 'Debt']} />
                <Area type="monotone" dataKey="assets" stroke="#5b9df9" strokeWidth={2.5} fill="url(#acctAssets)"
                  dot={(p) => (p.index === series.length - 1 ? <circle key={p.index} cx={p.cx} cy={p.cy} r={4} fill="#5b9df9" stroke="hsl(224 64% 4%)" strokeWidth={2} /> : null)}
                  style={{ filter: 'drop-shadow(0 0 6px rgba(91,157,249,0.45))' }} />
                <Area type="monotone" dataKey="debts" stroke="#e08a3d" strokeWidth={2.5} fill="url(#acctDebt)"
                  dot={(p) => (p.index === series.length - 1 ? <circle key={p.index} cx={p.cx} cy={p.cy} r={4} fill="#e08a3d" stroke="hsl(224 64% 4%)" strokeWidth={2} /> : null)}
                  style={{ filter: 'drop-shadow(0 0 6px rgba(224,138,61,0.4))' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        <div className="mt-3 flex justify-center">
          <Segmented options={RANGE_KEYS.map((k) => [k, k])} value={range} onChange={setRange} />
        </div>
      </Card>

      {cards.length > 0 && (
        <Section title="Credit cards" total={fmt0(cards.reduce((s, a) => s + a.balance, 0))} addHref="/debts">
          {cards.map((a) => <CardRow key={a.key} account={a} />)}
        </Section>
      )}

      {loans.length > 0 && (
        <Section title="Loans" total={fmt0(loans.reduce((s, a) => s + a.balance, 0))} addHref="/debts">
          {loans.map((a) => <LoanRow key={a.key} account={a} />)}
        </Section>
      )}

      <Section title="Depository" total={fmt0(depository.reduce((s, a) => s + a.balance, 0))} onAdd={() => setEditing(null)}>
        {depository.length ? (
          depository.map((a) => <DepositoryRow key={a.key} account={a} />)
        ) : (
          <div className="p-6 text-center text-[0.78125rem] text-muted-foreground">No depository accounts yet — add one or connect a bank.</div>
        )}
      </Section>

      {editing !== undefined && <AccountDialog id={editing} onClose={() => setEditing(undefined)} />}
    </div>
  )
}

// Red/green % pill. `invert` flips the good/bad color read for Debt, where a
// decrease is the desirable direction.
function ChangePill({ pct, invert = false }) {
  const good = invert ? pct <= 0 : pct >= 0
  return (
    <span className={cn('inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.625rem] font-bold', good ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400')}>
      {pct >= 0 ? '↗' : '↘'} {Math.abs(pct).toFixed(2)}%
    </span>
  )
}

function StatLabel({ children }) {
  return <div className="truncate text-[0.65rem] font-bold uppercase tracking-wide" style={{ color: LABEL_COLOR }}>{children}</div>
}

// Collapsible Copilot-style section header: "▾ Title  $total" with an optional
// "Add ›" affordance (either a Link, e.g. Credit cards → /debts, or a callback,
// e.g. Depository → the existing AccountDialog).
function Section({ title, total, addHref, onAdd, children, defaultOpen = true }) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div className="space-y-2.5">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <button onClick={() => setOpen((o) => !o)} className="flex min-w-0 items-center gap-1.5 text-left">
          <ChevronDown className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform', !open && '-rotate-90')} />
          <span className="truncate text-[0.9375rem] font-semibold">{title}</span>
          <span className="shrink-0 whitespace-nowrap text-[0.8125rem] font-bold" style={{ color: '#5b9df9' }}>{total}</span>
        </button>
        {addHref ? (
          <Link href={addHref} className="flex shrink-0 items-center text-[0.78125rem] font-bold text-primary/90 transition hover:text-primary">Add<ChevronRight className="h-3.5 w-3.5" /></Link>
        ) : onAdd ? (
          <button onClick={onAdd} className="flex shrink-0 items-center text-[0.78125rem] font-bold text-primary/90 transition hover:text-primary">Add<ChevronRight className="h-3.5 w-3.5" /></button>
        ) : null}
      </div>
      {open && <Card className="divide-y divide-border/60 overflow-hidden">{children}</Card>}
    </div>
  )
}

// Rows now navigate to /accounts/{id} — a Notion-style modal on in-app clicks
// (intercepted route, app/(app)/@modal/(.)accounts/[id]) or the full detail
// page on direct load/refresh. See views/AccountDetail.jsx.
function CardRow({ account }) {
  const hasLimit = !!account.limit
  const util = hasLimit ? Math.min(999, Math.round((account.balance / account.limit) * 100)) : null
  return (
    <Link href={`/accounts/${accountUrlId(account)}`} className="flex w-full items-center gap-3 px-3.5 py-3.5 text-left transition hover:bg-accent/60 sm:px-4">
      <CardChip institution={account.institution} name={account.name} mask={account.mask} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex justify-center gap-1.5"><SourceBadge accountId={account.account_id} institution={account.institution} />{account.status === 'syncing' && <SyncingPill />}</div>
        {hasLimit ? (
          <div className="grid grid-cols-3 items-center gap-1 text-center">
            <div><StatLabel>Balance</StatLabel><Money value={fmt0(account.balance)} className="text-sm font-extrabold sm:text-base" /></div>
            <div><StatLabel>Limit</StatLabel><Money value={fmt0(account.limit)} className="text-sm font-extrabold text-muted-foreground sm:text-base" /></div>
            <div>
              <StatLabel>Utilized</StatLabel>
              <div className={cn('text-sm font-extrabold sm:text-base', util > 80 ? 'text-red-400' : util > 30 ? 'text-amber-400' : 'text-emerald-400')}>{util}%</div>
            </div>
          </div>
        ) : (
          <div className="space-y-1.5">
            <div className="w-full rounded-full border border-amber-400/40 px-2 py-1 text-center text-[0.625rem] font-bold uppercase tracking-wide text-amber-400">
              Credit limit needed
            </div>
            <div className="text-center">
              <StatLabel>Balance</StatLabel>
              <Money value={fmt0(account.balance)} className="text-xl font-extrabold sm:text-2xl" />
            </div>
          </div>
        )}
      </div>
    </Link>
  )
}

function LoanRow({ account }) {
  return (
    <Link href={`/accounts/${accountUrlId(account)}`} className="flex w-full items-center gap-3 px-3.5 py-3.5 text-left transition hover:bg-accent/60 sm:px-4">
      <CardChip institution={account.institution} name={account.name} mask={account.mask} />
      <div className="min-w-0 flex-1 space-y-1.5 text-center">
        <div className="flex justify-center gap-1.5"><SourceBadge accountId={account.account_id} institution={account.institution} />{account.status === 'syncing' && <SyncingPill />}</div>
        <StatLabel>Balance</StatLabel>
        <Money value={fmt0(account.balance)} className="text-xl font-extrabold sm:text-2xl" />
      </div>
    </Link>
  )
}

function DepositoryRow({ account }) {
  const pct = pctChange30(account.history, account.balance)
  const available = account.available ?? account.balance
  return (
    <Link href={`/accounts/${accountUrlId(account)}`} className="flex w-full items-center gap-3 px-3.5 py-3.5 text-left transition hover:bg-accent/60 sm:px-4">
      <CardChip institution={account.institution} name={account.name} mask={account.mask} />
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex justify-center gap-1.5"><SourceBadge accountId={account.account_id} institution={account.institution} />{account.status === 'syncing' && <SyncingPill />}</div>
        <div className="grid grid-cols-3 items-center gap-1 text-center">
          <div><StatLabel>Available</StatLabel><Money value={fmt0(available)} className="text-sm font-extrabold sm:text-base" /></div>
          <div><StatLabel>Current</StatLabel><Money value={fmt0(account.balance)} className="text-sm font-extrabold sm:text-base" /></div>
          <div>
            <StatLabel>Change</StatLabel>
            {pct == null ? <div className="text-sm font-extrabold text-muted-foreground sm:text-base">–</div> : <ChangePill pct={pct} />}
          </div>
        </div>
      </div>
    </Link>
  )
}

function AccountDialog({ id, onClose }) {
  const { state, update } = useApp()
  const toast = useToast()
  const centerToast = useCenterToast()
  const a = id ? state.accounts.find((x) => x.id === id) : { name: '', type: 'depository', institution: '', mask: '', balance: '' }
  const [f, setF] = useState({ ...a })
  const [confirmDel, setConfirmDel] = useState(false)
  const [deleting, setDeleting] = useState(false)
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

  const del = async () => {
    // Deletion itself is a synchronous store mutation, but a brief busy state
    // (spinner in the confirm dialog, see ConfirmDialog's `busy` prop) gives
    // the same "it's working" feedback as the async Plaid-disconnect path.
    setDeleting(true)
    await new Promise((r) => setTimeout(r, 350))
    try {
      deleteManualAccount(update, id)
      centerToast('Account deleted')
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
          busy={deleting}
          onConfirm={del}
          onClose={() => setConfirmDel(false)}
        />
      )}
    </Dialog>
  )
}
