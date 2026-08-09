'use client'
import { useMemo, useRef, useState } from 'react'
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
import { cleanDisplayName } from '@/lib/tx-display'
import { parseWescomCSV, guessCat } from '@/lib/wescom'
import { usePlaidItems } from '@/lib/accounts'
import { useIsMobile } from '@/lib/useMediaQuery'

export default function Transactions({ accountFilter, setAccountFilter, catFilter, setCatFilter }) {
  const { state, update, catInfo } = useApp()
  const toast = useToast()
  const centerToast = useCenterToast()
  const fileRef = useRef(null)
  const [ym, setYm] = useState(today().slice(0, 7))
  const [q, setQ] = useState('')
  // `cat` mirrors the `?cat=` param exactly the way `accountFilter` mirrors
  // `?account=` — no local-only state, so a deep link (Dashboard's "Where
  // the money went" rows, Budgets' category rows, AccountDetail's account
  // links) and the select itself always agree on what's selected.
  const cat = catFilter || 'all'
  const setCat = (id) => setCatFilter(id === 'all' ? null : id)
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit
  const [importRows, setImportRows] = useState(null) // null closed · [] -> preview dialog
  const [confirmDelId, setConfirmDelId] = useState(null) // transaction id pending delete confirmation
  const [deleting, setDeleting] = useState(false)
  const [sheetTxId, setSheetTxId] = useState(null) // mobile row tap -> detail bottom sheet, holds a transaction id
  const { plaidItems } = usePlaidItems()
  // Matches Tailwind's `sm` breakpoint — below it, rows are single-line/tappable
  // and open the detail sheet; at sm+ the row tap does nothing (desktop keeps
  // its existing hover pencil/X icons instead), so this gate keeps that click
  // handler from firing on desktop.
  const isMobile = useIsMobile()

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
  // Mobile rows drop the per-row institution subline entirely when every
  // visible transaction is on the same account (the common case — it's pure
  // repeated noise then) and fall back to a compact "••mask" line only when
  // the currently-filtered list actually spans more than one account.
  const visibleAccountIds = new Set(list.map((t) => t.accountId).filter(Boolean))
  const multiAccount = visibleAccountIds.size > 1
  const sheetTx = sheetTxId ? state.transactions.find((t) => t.id === sheetTxId) : null

  return (
    <div className="fade-in space-y-5">
      <input ref={fileRef} type="file" accept=".csv" className="hidden" onChange={(e) => { importFile(e.target.files[0]); e.target.value = '' }} />
      {/* Mobile: a tight vertical stack (month nav / search / the two selects
          side-by-side / chips / actions) so the filter block doesn't eat the
          whole viewport before any transactions show. `sm:contents` on the
          select-pair and `sm:flex` on the actions revert everything to the
          original single flex-wrap row at sm+. */}
      <Card className="flex flex-col gap-2.5 p-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-3">
        <div className="flex items-center gap-1">
          <Button variant="outline" size="xs" className="px-1.5" onClick={() => shift(-1)}><ChevronLeft /></Button>
          <span className="w-24 text-center text-[0.8125rem] font-semibold">{ymLabel(ym)}</span>
          <Button variant="outline" size="xs" className="px-1.5" onClick={() => shift(1)}><ChevronRight /></Button>
        </div>
        <div className="relative w-full sm:w-auto">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-full pl-8 sm:w-44" placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div className="grid grid-cols-2 gap-2 sm:contents">
          <Select className="w-full text-xs sm:w-auto" value={cat} onChange={(e) => setCat(e.target.value)}>
            <option value="all">All categories</option>
            {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            <option value="debt">Debt Payment</option><option value="income">Income</option><option value="transfer">Transfer</option>
          </Select>
          {/* Only rendered once there's at least one connected bank — manual-only
              users have nothing to filter by, so no dropdown clutter (design goal 3). */}
          {accountOptions.length > 0 && (
            <Select
              className="w-full text-xs sm:w-auto sm:max-w-[9.5rem] md:max-w-[13rem]"
              value={accountFilter || ''}
              onChange={(e) => setAccountFilter(e.target.value || null)}
            >
              <option value="">All accounts</option>
              {accountOptions.map((a) => <option key={a.id} value={a.id}>{a.label}</option>)}
            </Select>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs sm:ml-auto">
          <Badge>In <b className="text-emerald-400">{fmt0(inc)}</b></Badge>
          <Badge>Out <b className="text-foreground">{fmt0(exp)}</b></Badge>
          <Badge>Net <b className={inc - exp >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmt0(inc - exp)}</b></Badge>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:gap-2">
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
              // Mobile subline: short institution ("Wescom Financial" → "Wescom")
              // + mask, so rows stay identifiable with 3+ accounts without the
              // full-institution clutter.
              const shortInst = acct?.institution ? acct.institution.replace(/\s+(financial|bank|credit union|federal credit union|n\.?a\.?)\.?$/i, '') : null
              const mobileAcctLabel = acct ? `${shortInst || 'Bank'}${acct.mask ? ` ••${acct.mask}` : ''}` : null
              const displayName = cleanDisplayName(t.desc)
              return (
              <div
                key={t.id}
                className="group flex min-h-[2.75rem] items-center gap-2 px-4 py-1.5 transition-colors hover:bg-secondary/30 sm:min-h-0 sm:gap-3 sm:py-2"
                onClick={() => { if (isMobile) setSheetTxId(t.id) }}
              >
                <span className="flex w-5 shrink-0 justify-center sm:w-6"><CatIcon cat={t.cat} /></span>
                <span className="min-w-0 flex-1">
                  {/* Mobile: single-line cleaned-up name, plus a compact
                      "••mask" line only when this filtered view spans more
                      than one account — otherwise the row stays one line.
                      Desktop (sm:) is untouched: raw desc + full institution
                      subline, exactly as before. */}
                  <span className="block truncate text-[0.8125rem] text-foreground/90 sm:hidden" title={t.desc}>{displayName}</span>
                  <span className="hidden truncate text-[0.8125rem] text-foreground/90 sm:block" title={t.desc}>{t.desc}</span>
                  {multiAccount && mobileAcctLabel && (
                    <span className="block truncate text-[0.625rem] text-muted-foreground/80 sm:hidden">{mobileAcctLabel}</span>
                  )}
                  {acctLabel && (
                    <span className="hidden items-center gap-1 truncate text-[0.625rem] text-muted-foreground sm:flex" title={acctLabel}>
                      <Landmark className="h-2.5 w-2.5 shrink-0" />
                      <span className="truncate">{acctLabel}</span>
                    </span>
                  )}
                </span>
                <span className="hidden sm:inline-flex"><CatChip cat={t.cat} /></span>
                <span className={`shrink-0 whitespace-nowrap text-right text-[0.8125rem] font-semibold tabular-nums sm:w-24 ${t.type === 'income' ? 'text-emerald-400' : t.cat === 'transfer' ? 'text-muted-foreground' : ''}`}>
                  {t.type === 'income' ? '+' : '−'}{fmt(t.amount)}
                </span>
                <span className="hidden shrink-0 justify-end gap-1 sm:flex sm:w-12 sm:gap-1.5">
                  <button className="text-muted-foreground transition hover:text-foreground sm:opacity-0 sm:group-hover:opacity-100" title="Edit" onClick={(e) => { e.stopPropagation(); setEditing(t.id) }}><Pencil className="h-3 w-3 sm:h-3.5 sm:w-3.5" /></button>
                  <button className="text-muted-foreground transition hover:text-red-400 sm:opacity-0 sm:group-hover:opacity-100" title="Delete" onClick={(e) => { e.stopPropagation(); setConfirmDelId(t.id) }}><X className="h-3 w-3 sm:h-3.5 sm:w-3.5" /></button>
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
        {/* Mobile-only clearance so the last row scrolls fully clear of the
            feedback FAB (fixed bottom-[4.75rem+safe-area], see
            components/feedback-widget.jsx) instead of just relying on
            <main>'s page-level pb-32 — that padding gets eaten into by the
            "Use Import…" helper text below this card. */}
        {dates.length > 0 && <div className="h-14 sm:hidden" aria-hidden="true" />}
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
      {sheetTx && (
        <TxSheet
          t={sheetTx}
          acct={sheetTx.accountId ? accountsById[sheetTx.accountId] : null}
          onClose={() => setSheetTxId(null)}
          onEdit={() => { setSheetTxId(null); setEditing(sheetTx.id) }}
          onDelete={() => { setSheetTxId(null); setConfirmDelId(sheetTx.id) }}
        />
      )}
    </div>
  )
}

// Mobile transaction-detail bottom sheet — opened by tapping a row below sm:
// (see the row's onClick above). Shows the full untruncated info a row no
// longer has room for, then hands off to the exact same edit/delete flows
// the row's desktop pencil/X icons already use (TxDialog via setEditing,
// ConfirmDialog via setConfirmDelId in the parent) — nothing about those
// flows is reimplemented here.
function TxSheet({ t, acct, onClose, onEdit, onDelete }) {
  const displayName = cleanDisplayName(t.desc)
  const showRaw = displayName !== t.desc
  const acctLabel = acct
    ? `${acct.institution || 'Bank'}${acct.name ? ` — ${acct.name}` : ''}${acct.mask ? ` ••${acct.mask}` : ''}`
    : null
  const isIncome = t.type === 'income'
  const amountTone = isIncome ? 'text-emerald-400' : t.cat === 'transfer' ? 'text-muted-foreground' : 'text-foreground'

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent variant="sheet" className="sm:hidden">
        <DialogTitle className="sr-only">{displayName} transaction details</DialogTitle>
        <div className="flex items-start gap-3 pr-6">
          <span className="mt-0.5 flex w-8 shrink-0 justify-center"><CatIcon cat={t.cat} className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1">
            <h3 className="break-words text-base font-bold leading-snug text-foreground">{displayName}</h3>
            {showRaw && <p className="mt-0.5 break-words text-[0.6875rem] text-muted-foreground">{t.desc}</p>}
          </div>
        </div>

        <div className={`text-3xl font-extrabold tabular-nums tracking-tight ${amountTone}`}>
          {isIncome ? '+' : '−'}{fmt(t.amount)}
        </div>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5 rounded-xl border bg-secondary/30 p-3.5 text-[0.8125rem]">
          <div>
            <div className="text-[0.625rem] font-bold uppercase tracking-wider text-muted-foreground">Date</div>
            <div className="mt-0.5 font-semibold">{prettyDate(t.date)}</div>
          </div>
          <div>
            <div className="text-[0.625rem] font-bold uppercase tracking-wider text-muted-foreground">Category</div>
            <div className="mt-0.5"><CatChip cat={t.cat} /></div>
          </div>
          <div className="col-span-2">
            <div className="text-[0.625rem] font-bold uppercase tracking-wider text-muted-foreground">Account</div>
            <div className="mt-0.5 flex items-center gap-1.5 font-semibold">
              <Landmark className="h-3 w-3 shrink-0 text-muted-foreground" />
              <span className="truncate">{acctLabel || 'Manual entry'}</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 pt-1">
          <Button variant="outline" onClick={onEdit}><Pencil />Edit</Button>
          <Button variant="destructive" onClick={onDelete}><X />Delete</Button>
        </div>
      </DialogContent>
    </Dialog>
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
