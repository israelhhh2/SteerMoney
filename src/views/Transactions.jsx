'use client'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Landmark, Pencil, Plus, Search, Upload, X } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { CatIcon, CatChip, ConfirmDialog, TransactionsSkeleton } from '@/components/shared'
import { useApp, monthTx } from '@/store'
import { useToast, useCenterToast } from '@/components/toast'
import { fmt, fmt0, today, ymLabel, prettyDate, uid } from '@/lib/utils'
import { parseWescomCSV, guessCat } from '@/lib/wescom'
import { usePlaidItems } from '@/lib/accounts'

export default function Transactions({ preset, clearPreset, accountFilter, setAccountFilter }) {
  const { state, update, catInfo } = useApp()
  const toast = useToast()
  const centerToast = useCenterToast()
  const fileRef = useRef(null)
  const [ym, setYm] = useState(today().slice(0, 7))
  const [q, setQ] = useState('')
  const [cat, setCat] = useState('all')
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit
  const [importRows, setImportRows] = useState(null) // null closed · [] -> preview dialog
  const [confirmDelId, setConfirmDelId] = useState(null) // transaction id pending delete confirmation
  const [deleting, setDeleting] = useState(false)
  const { plaidItems } = usePlaidItems()

  // One flat lookup, keyed by Plaid account_id, shared by the account
  // dropdown's options and each row's small "which account" label — both
  // just need {institution, name, mask, status} for a given accountId.
  // usePlaidItems() (lib/accounts.js) self-polls while any item is
  // 'syncing', so `status` here flips to 'ok' on its own once the
  // historical backfill lands — no extra effect needed here for that.
  const accountsById = useMemo(() => {
    const map = {}
    for (const it of plaidItems) {
      for (const a of it.accounts || []) {
        map[a.account_id] = { mask: a.mask, name: a.name, institution: it.institution, status: it.status }
      }
    }
    return map
  }, [plaidItems])

  // Dropdown options, one per known Plaid account — "Institution — Name
  // ••mask" per the design brief. Sorted by institution then account name
  // so accounts from the same bank sit together as the list grows.
  const accountOptions = useMemo(() => {
    const opts = []
    for (const it of plaidItems) {
      for (const a of it.accounts || []) {
        const label = `${it.institution || 'Bank'} — ${a.name}${a.mask ? ` ••${a.mask}` : ''}`
        opts.push({ id: a.account_id, label, institution: it.institution || '', name: a.name || '' })
      }
    }
    return opts.sort((x, y) => x.institution.localeCompare(y.institution) || x.name.localeCompare(y.name))
  }, [plaidItems])

  const filterAccount = accountFilter ? accountsById[accountFilter] || {} : null

  // While the filtered account's bank connection is still pulling in its
  // historical backfill, show the same "please wait" placeholder used by
  // AccountDetail.jsx instead of a possibly-empty/partial transaction list.
  const isSyncingAccount = !!accountFilter && filterAccount?.status === 'syncing'

  const importFile = (file) => {
    if (!file) return
    const rd = new FileReader()
    rd.onload = (e) => {
      const parsed = parseWescomCSV(e.target.result)
      if (!parsed.length) return toast("Couldn't find any transactions — export History as CSV from Wescom online banking", 'error')
      const validCats = new Set([...state.budgets.map((b) => b.id), 'debt', 'income', 'transfer', 'other'])
      const existing = new Set(state.transactions.map((t) => `${t.date}|${t.type}|${t.amount.toFixed(2)}|${t.desc}`))
      setImportRows(parsed.map((r, i) => {
        const dup = existing.has(`${r.date}|${r.type}|${r.amount.toFixed(2)}|${r.desc}`)
        return { ...r, key: i, cat: guessCat(r.desc, r.type, state.transactions, validCats), dup, include: !dup }
      }))
    }
    rd.readAsText(file)
  }

  useEffect(() => {
    if (preset) { setCat(preset); setQ(''); clearPreset && clearPreset() }
  }, [preset])

  const shift = (n) => {
    const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)
    setYm(d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0'))
  }

  // Deletion is a synchronous store mutation; the deliberate short delay +
  // busy spinner in ConfirmDialog matches the "it's working" feedback the
  // async Plaid-disconnect path gets elsewhere in the app.
  const handleDeleteTx = async () => {
    const id = confirmDelId
    setDeleting(true)
    await new Promise((r) => setTimeout(r, 350))
    try {
      update((s) => { s.transactions = s.transactions.filter((x) => x.id !== id) })
      centerToast('Transaction deleted')
      setDeleting(false)
      setConfirmDelId(null)
    } catch (e) {
      centerToast(e?.message || 'Something went wrong', 'error')
      setDeleting(false)
    }
  }

  let list = monthTx(state, ym)
  if (accountFilter) list = list.filter((t) => t.accountId === accountFilter)
  if (cat !== 'all') list = list.filter((t) => t.cat === cat)
  if (q) list = list.filter((t) => t.desc.toLowerCase().includes(q.toLowerCase()))
  const inc = list.filter((t) => t.type === 'income' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
  const exp = list.filter((t) => t.type === 'expense' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
  const byDate = {}
  list.forEach((t) => { (byDate[t.date] = byDate[t.date] || []).push(t) })
  const dates = Object.keys(byDate).sort().reverse()

  return (
    <div className="fade-in space-y-5">
      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { importFile(e.target.files[0]); e.target.value = '' }} />
      <Card className="flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="xs" className="px-1.5" onClick={() => shift(-1)}><ChevronLeft /></Button>
          <span className="w-24 text-center text-[0.8125rem] font-semibold">{ymLabel(ym)}</span>
          <Button variant="outline" size="xs" className="px-1.5" onClick={() => shift(1)}><ChevronRight /></Button>
        </div>
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-44 pl-8" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <Select className="text-xs" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="all">All categories</option>
          {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          <option value="debt">Debt Payment</option><option value="income">Income</option><option value="transfer">Transfer</option>
        </Select>
        {/* Only rendered once there's at least one connected bank — manual-only
            users have nothing to filter by, so no dropdown clutter (design goal 3). */}
        {accountOptions.length > 0 && (
          <Select
            className="max-w-[9.5rem] text-xs sm:max-w-[13rem]"
            value={accountFilter || ''}
            onChange={(e) => setAccountFilter(e.target.value || null)}
          >
            <option value="">All accounts</option>
            {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
          </Select>
        )}
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <Badge>In <b className="text-emerald-400">{fmt0(inc)}</b></Badge>
          <Badge>Out <b className="text-foreground">{fmt0(exp)}</b></Badge>
          <Badge>Net <b className={inc - exp >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmt0(inc - exp)}</b></Badge>
          <Button variant="outline" size="sm" onClick={() => fileRef.current.click()}><Upload />Import</Button>
          <Button size="sm" onClick={() => setEditing(null)}><Plus />Add</Button>
        </div>
      </Card>

      <Card className="overflow-hidden">
        {isSyncingAccount ? (
          <div className="p-4">
            <TransactionsSkeleton />
          </div>
        ) : dates.length ? dates.map((dt) => (
          <div key={dt}>
            <div className="border-y border-border/60 bg-secondary/40 px-4 py-1.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground first:border-t-0">{prettyDate(dt)}</div>
            {byDate[dt].map((t) => {
              const acct = t.accountId ? accountsById[t.accountId] : null
              const acctLabel = acct ? `${acct.institution || 'Bank'}${acct.mask ? ` ••${acct.mask}` : acct.name ? ` — ${acct.name}` : ''}` : null
              return (
              <div key={t.id} className="group flex items-center gap-3 px-4 py-2 transition-colors hover:bg-secondary/30">
                <span className="flex w-6 shrink-0 justify-center"><CatIcon cat={t.cat} /></span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[0.8125rem] text-foreground/90" title={t.desc}>{t.desc}</span>
                  {acctLabel && (
                    <span className="flex items-center gap-1 truncate text-[0.625rem] text-muted-foreground" title={acctLabel}>
                      <Landmark className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{acctLabel}</span>
                    </span>
                  )}
                </span>
                <span className="hidden sm:inline-flex"><CatChip cat={t.cat} /></span>
                <span className={`w-20 shrink-0 text-right text-[0.8125rem] font-semibold sm:w-24 ${t.type === 'income' ? 'text-emerald-400' : t.cat === 'transfer' ? 'text-muted-foreground' : ''}`}>
                  {t.type === 'income' ? '+' : '−'}{fmt(t.amount)}
                </span>
                <span className="flex w-12 shrink-0 justify-end gap-1.5">
                  <button className="text-muted-foreground transition hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100" title="Edit" onClick={() => setEditing(t.id)}><Pencil className="h-3.5 w-3.5" /></button>
                  <button className="text-muted-foreground transition hover:text-red-400 sm:opacity-0 sm:group-hover:opacity-100" title="Delete" onClick={() => setConfirmDelId(t.id)}><X className="h-3.5 w-3.5" /></button>
                </span>
              </div>
              )
            })}
          </div>
        )) : (
          <div className="p-10 text-center text-[0.8125rem] text-muted-foreground">
            No transactions in {ymLabel(ym)}{(q || cat !== 'all' || accountFilter) && <> matching your filters — <button className="text-primary hover:underline" onClick={() => { setQ(''); setCat('all'); if (accountFilter) setAccountFilter(null) }}>clear filters</button></>}.
          </div>
        )}
      </Card>
      <p className="text-[0.6875rem] text-muted-foreground/70">Use Import with a Wescom History CSV. Rows are auto-categorized and duplicates you already have are skipped. Debt payments made on the Debt page also land here.</p>

      {editing !== undefined && <TxDialog id={editing} onClose={() => setEditing(undefined)} />}
      {importRows && <ImportDialog rows={importRows} setRows={setImportRows} onClose={() => setImportRows(null)} />}
      {confirmDelId && (
        <ConfirmDialog
          title="Delete this transaction?"
          desc="This can't be undone."
          busy={deleting}
          onConfirm={handleDeleteTx}
          onClose={() => setConfirmDelId(null)}
        />
      )}
    </div>
  )
}

function ImportDialog({ rows, setRows, onClose }) {
  const { state, update } = useApp()
  const toast = useToast()
  const dups = rows.filter((r) => r.dup).length
  const selected = rows.filter((r) => r.include)
  const setRow = (key, patch) => setRows(rows.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const doImport = () => {
    update((s) => {
      selected.forEach((r) => s.transactions.push({ id: uid('tx'), date: r.date, desc: r.desc, amount: r.amount, type: r.type, cat: r.cat }))
      s.transactions.sort((a, b) => b.date.localeCompare(a.date))
    })
    toast(`Imported ${selected.length} transaction${selected.length === 1 ? '' : 's'}`)
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Import from Wescom</DialogTitle></DialogHeader>
        <div className="flex items-center gap-2 text-xs">
          <Badge>{rows.length} rows</Badge>
          {dups > 0 && <Badge>{dups} <b className="text-amber-400">already imported</b></Badge>}
          <Badge>{selected.length} <b className="text-emerald-400">selected</b></Badge>
        </div>
        <div className="-mx-1 max-h-[50vh] overflow-y-auto rounded-lg border">
          {rows.map((r) => (
            <div key={r.key} className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border/60 px-3 py-1.5 last:border-b-0 ${r.include ? '' : 'opacity-45'}`}>
              <input type="checkbox" className="h-3.5 w-3.5 shrink-0 accent-emerald-500" checked={r.include} onChange={(e) => setRow(r.key, { include: e.target.checked })} />
              <span className="w-12 shrink-0 text-[0.6875rem] text-muted-foreground">{prettyDate(r.date)}</span>
              <span className="min-w-0 flex-1 truncate text-[0.75rem]" title={r.desc}>{r.desc}</span>
              {r.dup && <span className="shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-400">dup</span>}
              <span className={`shrink-0 text-right text-[0.75rem] font-semibold sm:order-last sm:w-20 ${r.type === 'income' ? 'text-emerald-400' : ''}`}>
                {r.type === 'income' ? '+' : '−'}{fmt(r.amount)}
              </span>
              <Select className="!h-7 ml-6 w-[calc(100%-1.5rem)] text-[0.6875rem] sm:ml-0 sm:w-32 sm:shrink-0" value={r.cat} onChange={(e) => setRow(r.key, { cat: e.target.value })}>
                {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="debt">Debt Payment</option><option value="income">Income</option><option value="transfer">Transfer</option>
              </Select>
            </div>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={!selected.length} onClick={doImport}>Import {selected.length || ''}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function TxDialog({ id, onClose }) {
  const { state, update } = useApp()
  const toast = useToast()
  const t = id ? state.transactions.find((x) => x.id === id) : { date: today(), desc: '', amount: '', type: 'expense', cat: 'other' }
  const [f, setF] = useState({ ...t })
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const save = () => {
    if (!String(f.desc).trim()) return toast('Enter a description', 'error')
    const amount = parseFloat(f.amount)
    if (isNaN(amount)) return toast('Enter an amount', 'error')
    update((s) => {
      const data = { date: f.date, desc: f.desc.trim(), amount: Math.abs(amount), type: f.type, cat: f.cat }
      if (id) Object.assign(s.transactions.find((x) => x.id === id), data)
      else s.transactions.unshift({ id: uid('tx'), ...data })
      s.transactions.sort((a, b) => b.date.localeCompare(a.date))
    })
    toast(id ? 'Transaction updated' : 'Transaction added')
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{id ? 'Edit' : 'Add'} Transaction</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>Description</Label><Input value={f.desc} onChange={set('desc')} /></div>
          <div><Label>Amount ($)</Label><Input type="number" step="0.01" value={f.amount} onChange={set('amount')} /></div>
          <div><Label>Date</Label><Input type="date" value={f.date} onChange={set('date')} /></div>
          <div>
            <Label>Type</Label>
            <Select className="w-full" value={f.type} onChange={set('type')}>
              <option value="expense">Expense</option><option value="income">Income</option>
            </Select>
          </div>
          <div>
            <Label>Category</Label>
            <Select className="w-full" value={f.cat} onChange={set('cat')}>
              {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              <option value="debt">Debt Payment</option><option value="income">Income</option><option value="transfer">Transfer</option>
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
