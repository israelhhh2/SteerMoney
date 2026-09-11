'use client'
// Statement upload — PDF/CSV credit card, loan, or bank statement → Claude
// extracts the transactions + account facts, this previews them (modeled on
// views/Transactions.jsx's ImportDialog: header card, include checkboxes,
// per-row category Select, dup detection) and confirms into the store the
// same way every other import in this app does — via update(), client-side,
// nothing server-written from the parse route itself (see app/api/
// statements/parse/route.js).
//
// Two call sites share this one component: views/AccountDetail.jsx's
// "Upload statement" button (preselects that account/debt as the target) and
// views/Transactions.jsx's Import menu's "Any statement (PDF/CSV)" item (no
// preselected target — defaults to the first option). Both just render
// <StatementUpload hint={...} defaultTargetKey={...}>{(open, parsing) => ...
// their own trigger button ...}</StatementUpload> — this component owns the
// hidden file input, the parse request, the "Reading statement…" loading
// state, and the full preview/confirm dialog; the caller only supplies the
// trigger's own look.
import { useEffect, useMemo, useState } from 'react'
import { Loader2, Landmark, CircleCheck, CircleAlert } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useApp } from '@/store'
import { useToast } from '@/components/toast'
import { useT } from '@/lib/i18n'
import { fmt, fmt0, prettyDate, uid } from '@/lib/utils'
import { cleanMerchant } from '@/lib/merchant'
import { guessCategory } from '@/lib/category-rules'
import { buildAccountInventory, accountTxKey, usePlaidItems } from '@/lib/accounts'

const MAX_FILE_BYTES = 10 * 1024 * 1024 // matches the server route's own 10MB cap

// Renders nothing visible itself beyond what `children` (a render prop —
// `(open, parsing) => ReactNode`) asks for: the caller's own trigger button,
// styled however fits that page. `hint` is a free-text account/debt name
// passed straight through to the parse route to help Claude confirm which
// statement it's looking at; `defaultTargetKey` preselects a target in the
// preview dialog (an accountTxKey() value) when the caller already knows
// which account/debt this upload is for.
export function StatementUpload({ hint, defaultTargetKey, children }) {
  const toast = useToast()
  const t = useT()
  const [parsing, setParsing] = useState(false)
  const [result, setResult] = useState(null) // { parsed, validation, usage } once parsed

  const onFile = async (file) => {
    if (!file) return
    if (file.size > MAX_FILE_BYTES) { toast(t('That file is too large — statements must be under 10 MB'), 'error'); return }
    setParsing(true)
    try {
      const fd = new FormData()
      fd.append('file', file)
      if (hint) fd.append('hint', hint)
      const res = await fetch('/api/statements/parse', { method: 'POST', body: fd })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || t("Couldn't read that statement"))
      setResult(data)
    } catch (e) {
      toast(e.message, 'error')
    } finally {
      setParsing(false)
    }
  }

  const open = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf,.csv,.txt,application/pdf,text/csv,text/plain'
    input.onchange = (e) => onFile(e.target.files[0])
    input.click()
  }

  return (
    <>
      {children(open, parsing)}
      {parsing && (
        <Dialog open onOpenChange={() => {}}>
          <DialogContent className="max-w-xs text-center">
            <DialogTitle className="sr-only">{t('Reading statement…')}</DialogTitle>
            <div className="flex flex-col items-center gap-3 py-4">
              <Loader2 className="h-6 w-6 animate-spin text-primary" />
              <p className="text-[0.8125rem] font-semibold">{t('Reading statement…')}</p>
              <p className="text-[0.71875rem] text-muted-foreground">{t('Claude is extracting the transactions — this can take a moment for a long statement.')}</p>
            </div>
          </DialogContent>
        </Dialog>
      )}
      {result && (
        <StatementPreviewDialog
          parsed={result.parsed}
          validation={result.validation}
          usage={result.usage}
          defaultTargetKey={defaultTargetKey}
          onClose={() => setResult(null)}
        />
      )}
    </>
  )
}

// v accepts a number (e.g. 24.99) or an already-formatted string ("24.99%",
// "—") straight from the model — DebtDialog stores APR as a display string
// (see views/Debts.jsx), never a bare number, so this normalizes either shape
// into that same convention. Returns null (leave the existing value alone)
// when there's nothing usable.
function formatApr(v) {
  if (v == null || v === '') return null
  const s = String(v).trim()
  if (s.endsWith('%')) return s
  const n = Number(s)
  return Number.isFinite(n) ? `${n}%` : null
}

// Same "is this really the same charge" heuristic as Transactions.jsx's own
// import dup-check, just merchant-normalized on both sides (a statement's
// wording of a merchant name often differs slightly from what's already
// stored) — same-date + same-amount rows whose cleaned merchant names match
// or overlap are flagged as a probable duplicate and pre-unchecked.
function descSimilar(a, b) {
  const na = cleanMerchant(a || '').toLowerCase().trim()
  const nb = cleanMerchant(b || '').toLowerCase().trim()
  if (!na || !nb) return String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase()
  return na === nb || na.includes(nb) || nb.includes(na)
}

function StatHeaderTile({ label, value }) {
  return (
    <div>
      <div className="text-[0.5625rem] font-bold uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`text-[0.8125rem] font-bold ${value ? '' : 'text-muted-foreground'}`}>{value || '–'}</div>
    </div>
  )
}

function StatementPreviewDialog({ parsed, validation, usage, defaultTargetKey, onClose }) {
  const { state, update } = useApp()
  const { plaidItems } = usePlaidItems()
  const t = useT()
  const toast = useToast()
  const [confirming, setConfirming] = useState(false)

  // Target options = every account this app knows about: manual debts,
  // manual (non-debt) accounts, and connected Plaid accounts — exactly what
  // buildAccountInventory already merges for Accounts.jsx/AccountDetail.jsx.
  const inventory = useMemo(() => buildAccountInventory(state, plaidItems), [state, plaidItems])
  const options = useMemo(() => inventory.all
    .map((a) => ({
      key: accountTxKey(a),
      row: a,
      label: `${a.institution ? a.institution + ' — ' : ''}${a.name}${a.mask ? ` ••${a.mask}` : ''}`,
    }))
    .filter((o) => o.key)
    .sort((x, y) => x.label.localeCompare(y.label)),
    [inventory])

  const [targetKey, setTargetKey] = useState(() =>
    (defaultTargetKey && options.some((o) => o.key === defaultTargetKey)) ? defaultTargetKey : (options[0]?.key || null)
  )
  const target = options.find((o) => o.key === targetKey)?.row || null
  const isCreditCardTarget = target?.kind === 'credit'
  const isDebtTarget = target?.source === 'debt'

  // "Also update this account's balance/APR/min/due" — only meaningful for a
  // debt row (APR/min/due/limit only exist on state.debts, see
  // lib/categories.js/views/Debts.jsx's DebtDialog). Default ON for a manual
  // (never Plaid-linked) debt — that's the whole reason to upload a
  // statement for it — OFF for a Plaid-linked one, where Plaid's own sync
  // already keeps those numbers current and a stale/partial statement
  // shouldn't casually override them. Re-derived every time the target
  // changes.
  const [updateBalance, setUpdateBalance] = useState(false)
  useEffect(() => {
    setUpdateBalance(isDebtTarget && !target?.item_id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  const validCats = useMemo(() => new Set([...state.budgets.map((b) => b.id), 'debt', 'income', 'transfer', 'refund', 'other']), [state.budgets])

  const buildRows = () => {
    const existing = targetKey ? state.transactions.filter((tx) => tx.accountId === targetKey) : []
    return (parsed.transactions || [])
      .filter((r) => r && r.date && r.amount != null) // defensive — the server already rejects these, belt & suspenders
      .map((r, i) => {
        const amount = Math.abs(Number(r.amount) || 0)
        const merchant = cleanMerchant(r.description || '')
        let cat
        if (r.type === 'payment') cat = isCreditCardTarget ? 'transfer' : 'debt'
        else if (r.type === 'fee' || r.type === 'interest') cat = 'fees'
        else if (r.type === 'refund') cat = 'refund'
        else if (r.type === 'income') cat = 'income'
        else cat = guessCategory({ name: merchant || r.description })
        if (!validCats.has(cat)) cat = 'other'
        const dup = existing.some((tx) => tx.date === r.date && Math.abs(tx.amount - amount) < 0.005 && descSimilar(tx.desc, r.description))
        return { key: i, date: r.date, desc: r.description, amount, srcType: r.type, cat, dup, include: !dup }
      })
  }

  // Rebuilt whenever the target account changes — dup detection and the
  // credit-card-only 'payment' → 'transfer' default both depend on which
  // account this would land on, so switching targets mid-review resets the
  // row list to what's correct for the NEW target (any manual include/
  // category tweak made against the old target is discarded, same tradeoff
  // ImportDialog accepts by only ever building its rows once).
  const [rows, setRows] = useState(buildRows)
  useEffect(() => {
    setRows(buildRows())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetKey])

  const setRow = (key, patch) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const selected = rows.filter((r) => r.include)
  const dups = rows.filter((r) => r.dup).length

  const period = parsed.statement_period || {}
  const periodLabel = period.start && period.end ? `${prettyDate(period.start)} – ${prettyDate(period.end)}` : null

  const doImport = () => {
    if (!targetKey) return toast(t('Choose an account'), 'error')
    setConfirming(true)
    update((s) => {
      selected.forEach((r) => {
        const type = (r.srcType === 'payment' || r.srcType === 'refund' || r.srcType === 'income') ? 'income' : 'expense'
        // catSource: 'import' — same provenance Transactions.jsx's Wescom
        // ImportDialog uses: came in through an import + this dialog's own
        // category Select, not Plaid and not a direct hand-pick, so a future
        // recategorization pass still treats it as safe to improve.
        s.transactions.push({
          id: uid('tx'), date: r.date, desc: r.desc, amount: r.amount, type, cat: r.cat, catSource: 'import',
          accountId: targetKey, merchant: cleanMerchant(r.desc) || null,
        })
      })
      s.transactions.sort((a, b) => b.date.localeCompare(a.date))

      if (updateBalance && isDebtTarget && target?.debtId) {
        const debt = s.debts.find((d) => d.id === target.debtId)
        if (debt) {
          if (parsed.new_balance != null) debt.balance = Number(parsed.new_balance)
          const apr = formatApr(parsed.apr_purchase)
          if (apr != null) debt.apr = apr
          if (parsed.minimum_payment != null) debt.min = Number(parsed.minimum_payment) || 0
          if (parsed.due_date) {
            const day = new Date(parsed.due_date + 'T00:00:00').getDate()
            if (!isNaN(day)) debt.dueDay = day
          }
          if (parsed.credit_limit != null) debt.limit = Number(parsed.credit_limit) || null
          if (parsed.closing_date) debt.balanceAsOf = parsed.closing_date
        }
      }
    })
    toast(selected.length === 1
      ? t('Imported {n} transaction from the statement', { n: selected.length })
      : t('Imported {n} transactions from the statement', { n: selected.length }))
    setConfirming(false)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>{t('Review statement')}</DialogTitle></DialogHeader>

        <div className="space-y-2 rounded-xl border bg-secondary/20 p-3">
          <div className="flex items-center gap-1.5 text-[0.8125rem] font-bold">
            <Landmark className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            {parsed.institution || t('Statement')}{parsed.account_last4 ? ` ••${parsed.account_last4}` : ''}
          </div>
          <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
            <StatHeaderTile label={t('Period')} value={periodLabel} />
            <StatHeaderTile label={t('New balance')} value={parsed.new_balance != null ? fmt0(parsed.new_balance) : null} />
            <StatHeaderTile label={t('Min payment')} value={parsed.minimum_payment != null ? fmt0(parsed.minimum_payment) : null} />
            <StatHeaderTile label={t('Due date')} value={parsed.due_date ? prettyDate(parsed.due_date) : null} />
            <StatHeaderTile label={t('APR')} value={parsed.apr_purchase != null ? formatApr(parsed.apr_purchase) : null} />
            <StatHeaderTile label={t('Credit limit')} value={parsed.credit_limit != null ? fmt0(parsed.credit_limit) : null} />
          </div>
          {validation?.reconciles ? (
            <div className="flex items-center gap-1.5 rounded-lg border border-emerald-400/20 bg-emerald-400/10 px-2.5 py-1.5 text-[0.71875rem] font-semibold text-emerald-400">
              <CircleCheck className="h-3.5 w-3.5 shrink-0" />{t('Reconciles with statement totals')}
            </div>
          ) : (
            <div className="flex items-start gap-1.5 rounded-lg border border-amber-400/20 bg-amber-400/10 px-2.5 py-1.5 text-[0.71875rem] font-semibold text-amber-400">
              <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{t("Totals don't match: {details}", { details: (validation?.mismatches || []).map((m) => m.field).join(', ') || t('check the rows below') })}</span>
            </div>
          )}
        </div>

        <div>
          <label className="mb-1 block text-[0.6875rem] font-bold uppercase tracking-wide text-muted-foreground">{t('Import into')}</label>
          <Select className="w-full" value={targetKey || ''} onChange={(e) => setTargetKey(e.target.value)}>
            {options.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
          </Select>
        </div>

        {isDebtTarget && (
          <label className="flex items-start gap-2 rounded-lg border border-dashed bg-secondary/20 px-3 py-2 text-[0.75rem]">
            <input type="checkbox" className="mt-0.5 h-3.5 w-3.5 shrink-0 accent-emerald-500" checked={updateBalance} onChange={(e) => setUpdateBalance(e.target.checked)} />
            <span>{t("Also update this account's balance/APR/min/due from the statement")}</span>
          </label>
        )}

        <div className="flex items-center gap-2 text-xs">
          <Badge>{t('{n} rows', { n: rows.length })}</Badge>
          {dups > 0 && <Badge>{dups} <b className="text-amber-400">{t('already imported')}</b></Badge>}
          <Badge>{selected.length} <b className="text-emerald-400">{t('selected')}</b></Badge>
        </div>

        <div className="-mx-1 max-h-[42vh] overflow-y-auto rounded-lg border">
          {rows.map((r) => (
            <div key={r.key} className={`flex flex-wrap items-center gap-x-2.5 gap-y-1 border-b border-border/60 px-3 py-1.5 last:border-b-0 ${r.include ? '' : 'opacity-45'}`}>
              <input type="checkbox" className="h-3.5 w-3.5 shrink-0 accent-emerald-500" checked={r.include} onChange={(e) => setRow(r.key, { include: e.target.checked })} />
              <span className="w-12 shrink-0 text-[0.6875rem] text-muted-foreground">{prettyDate(r.date)}</span>
              <span className="min-w-0 flex-1 truncate text-[0.75rem]" title={r.desc}>{r.desc}</span>
              {r.dup && <span className="shrink-0 rounded bg-amber-400/10 px-1.5 py-0.5 text-[0.625rem] font-medium text-amber-400">{t('dup')}</span>}
              <span className={`shrink-0 text-right text-[0.75rem] font-semibold sm:order-last sm:w-20 ${r.srcType === 'refund' || r.srcType === 'income' || r.srcType === 'payment' ? 'text-emerald-400' : ''}`}>
                {(r.srcType === 'refund' || r.srcType === 'income' || r.srcType === 'payment') ? '+' : '−'}{fmt(r.amount)}
              </span>
              <Select className="!h-7 ml-6 w-[calc(100%-1.5rem)] text-[0.6875rem] sm:ml-0 sm:w-32 sm:shrink-0" value={r.cat} onChange={(e) => setRow(r.key, { cat: e.target.value })}>
                {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                <option value="debt">{t('Debt Payment')}</option><option value="income">{t('Income')}</option><option value="transfer">{t('Transfer')}</option><option value="refund">{t('Refund')}</option>
              </Select>
            </div>
          ))}
        </div>

        <DialogFooter className="flex-wrap items-center justify-between">
          {usage && (
            <span className="text-[0.625rem] text-muted-foreground/70">
              {t('≈ {n} tokens', { n: (usage.input_tokens || 0) + (usage.output_tokens || 0) })}
            </span>
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
            <Button disabled={!selected.length || confirming || !targetKey} onClick={doImport}>{t('Import')} {selected.length || ''}</Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
