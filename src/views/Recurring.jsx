'use client'
import { useEffect, useMemo, useState } from 'react'
import { Plus, Pencil, X, Search, FlaskConical, CreditCard, ChevronLeft, ChevronRight, CheckCircle2, Sparkles, Landmark } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Ring, Money, SectionLabel, CatIcon, ViewToggle, ConfirmDialog, TagPill } from '@/components/shared'
import { useApp, monthTx, incomeIn } from '@/store'
import { useToast, useCenterToast } from '@/components/toast'
import { fmt, fmt0, today, isoDate, prettyDate, ymLabel, ordinal, uid } from '@/lib/utils'
import { recEvery, recMonthly, nextDueDate, simulatePlan, fmtMonths, findPaidTx } from '@/lib/finance'
import { usePlaidItems, buildAccountInventory, accountUrlId, tagsForAccount } from '@/lib/accounts'
import { detectRecurring, CADENCE_LABEL } from '@/lib/recurring-detect'
import { useT } from '@/lib/i18n'

const VIEW_KEY = 'fin-rec-view'
// Suggested-subscription dismissals — a merchant the user explicitly said "not
// a bill" shouldn't keep reappearing. Plain localStorage (same untethered-to-
// user-id convention as VIEW_KEY above), not a store/DB slice: this is a
// per-browser "don't ask again," not data that needs to sync across devices
// or survive a cache clear — the least invasive option per CLAUDE.md's
// note-what-you-picked instruction, and avoids touching store.jsx's
// settings-slice sync (which only diffs `sim`/`mSim` today) for something
// this disposable.
const DISMISSED_KEY = 'fin-recur-dismissed'

export default function Recurring() {
  const { state, update, catInfo } = useApp()
  const t = useT()
  const toast = useToast()
  const centerToast = useCenterToast()
  const [filter, setFilter] = useState({ cat: 'all', status: 'all', sort: 'due', q: '' })
  const [whatIf, setWhatIf] = useState(new Set())
  const [editing, setEditing] = useState(undefined) // undefined closed · null new · id edit
  const [confirmDelId, setConfirmDelId] = useState(null) // recurring bill id pending delete confirmation
  const [deleting, setDeleting] = useState(false)
  const { plaidItems } = usePlaidItems()
  const [dismissed, setDismissed] = useState([])
  useEffect(() => { try { setDismissed(JSON.parse(localStorage.getItem(DISMISSED_KEY)) || []) } catch {} }, [])
  const dismissSuggestion = (key) => setDismissed((d) => {
    const next = [...new Set([...d, key])]
    try { localStorage.setItem(DISMISSED_KEY, JSON.stringify(next)) } catch {}
    return next
  })
  const nowYm = today().slice(0, 7)
  const [ym, setYm] = useState(nowYm)
  const [view, setView] = useState('cards')
  useEffect(() => { try { setView(localStorage.getItem(VIEW_KEY) || 'cards') } catch {} }, [])
  const changeView = (v) => { setView(v); try { localStorage.setItem(VIEW_KEY, v) } catch {} }
  const isCurrent = ym === nowYm
  const todayDom = +today().slice(8, 10)
  const shift = (n) => {
    const d = new Date(+ym.slice(0, 4), +ym.slice(5, 7) - 1 + n, 1)
    const next = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
    if (next > nowYm) return
    setYm(next)
  }

  const confirmDelBill = confirmDelId ? state.recurring.find((x) => x.id === confirmDelId) : null

  // Same merged manual+Plaid inventory Accounts.jsx/AccountDetail.jsx build
  // (lib/accounts.js) — reused here purely to resolve "which account" (name/
  // institution/mask) and its tags (tagsForAccount, keyed by accountUrlId())
  // for a Plaid account_id, whether that account came in unmatched or is
  // actually a manual debt fuzzy-matched to a Plaid connection.
  const inventory = useMemo(() => buildAccountInventory(state, plaidItems), [state.debts, state.accounts, plaidItems])
  const accountRowFor = (accountId) => (accountId ? inventory.all.find((a) => a.account_id === accountId) : null)

  // "Which account" + its tags, rendered under a recurring row's existing
  // desc/cadence line — only present when the bill carries an accountId
  // (i.e. it was added from a Suggested Subscriptions row below; manually
  // added bills have none, so this renders nothing for them, unchanged).
  const accountLineFor = (accountId) => {
    const acctRow = accountRowFor(accountId)
    if (!acctRow) return null
    const tags = tagsForAccount(state, accountUrlId(acctRow))
    return (
      <div className="mt-0.5 flex flex-wrap items-center gap-1 text-[0.625rem] text-muted-foreground">
        <Landmark className="h-2.5 w-2.5 shrink-0" />
        <span className="truncate">{acctRow.institution || t('Bank')}{acctRow.mask ? ` ••${acctRow.mask}` : ''}</span>
        {tags.map((tag) => <TagPill key={tag.id} tag={tag.tag} />)}
      </div>
    )
  }

  // Detected against every transaction + the current recurring list (so an
  // already-tracked bill's merchant is fuzzy-excluded — see
  // lib/recurring-detect.js), then filtered against this browser's dismissed
  // list. Recomputes only when transactions/recurring/dismissals change.
  const suggestions = useMemo(
    () => detectRecurring(state.transactions, state.recurring).filter((s) => !dismissed.includes(s.key)),
    [state.transactions, state.recurring, dismissed]
  )

  // Prefill exactly per spec: desc, amount, day-of-month from lastDate, cat
  // from the transactions' own category. Always added as a monthly (every:1)
  // bill — the store's recurring schema only supports "every N months" (see
  // RecurringDialog below), so a detected weekly/biweekly cadence has no
  // native representation yet; noted as a limitation in CLAUDE.md rather than
  // silently mis-tagging it as something the schema can't actually express.
  const addSuggestion = (s) => {
    update((st) => {
      const dueDay = Math.min(31, Math.max(1, new Date(s.lastDate + 'T00:00:00').getDate()))
      st.recurring.push({
        id: uid('r'), desc: s.displayName, amount: Math.round(s.avgAmount * 100) / 100,
        dueDay, cat: s.cat || 'other', active: true, every: 1,
        ...(s.accountId ? { accountId: s.accountId } : {}),
      })
    })
    dismissSuggestion(s.key)
    centerToast(t('{name} added to recurring', { name: s.displayName }))
  }

  // Deletion is a synchronous store mutation; the deliberate short delay +
  // busy spinner in ConfirmDialog matches the "it's working" feedback the
  // async Plaid-disconnect path gets elsewhere in the app.
  const handleDeleteRecurring = async () => {
    const id = confirmDelId
    setDeleting(true)
    await new Promise((r) => setTimeout(r, 350))
    try {
      update((s) => { s.recurring = s.recurring.filter((x) => x.id !== id) })
      centerToast(t('Recurring bill deleted'))
      setDeleting(false)
      setConfirmDelId(null)
    } catch (e) {
      centerToast(e?.message || t('Something went wrong'), 'error')
      setDeleting(false)
    }
  }

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
    toast(t('{name} logged', { name: r.desc }))
  }

  // this month (or the selected past month): what's been paid vs what's still coming.
  // "Paid" is verified against real transactions (imported or logged), not just t.rid,
  // so bills paid straight from the bank show up too.
  const monthly = act.filter((r) => recEvery(r) === 1).slice().sort((a, b) => a.dueDay - b.dueDay)
  const selTx = monthTx(state, ym)
  const paidMap = new Map()
  {
    let pool = selTx.slice()
    for (const r of monthly) {
      const tx = findPaidTx(r, pool)
      if (tx) { paidMap.set(r.id, tx); pool = pool.filter((t) => t !== tx) }
    }
  }
  const paidSum = monthly.filter((r) => paidMap.has(r.id)).reduce((s, r) => s + r.amount, 0)
  const dueSum = monthly.reduce((s, r) => s + r.amount, 0)
  const leftSum = Math.max(0, dueSum - paidSum)

  return (
    <div className="fade-in space-y-6">
      <div className="flex items-center gap-1">
        <Button variant="outline" size="xs" className="px-1.5" onClick={() => shift(-1)}><ChevronLeft /></Button>
        <span className="w-24 text-center text-[0.8125rem] font-semibold">{ymLabel(ym)}</span>
        <Button variant="outline" size="xs" className="px-1.5" disabled={isCurrent} onClick={() => shift(1)}><ChevronRight /></Button>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-around gap-4">
          <div className="text-center">
            <Money value={fmt0(leftSum)} className="text-2xl font-extrabold sm:text-3xl" />
            <div className="mt-0.5 text-[0.75rem] font-semibold text-muted-foreground">{isCurrent ? t('left to pay') : t('went unpaid')}</div>
          </div>
          <Ring pct={dueSum ? (paidSum / dueSum) * 100 : 0} color="#5b9df9" size={84} stroke={9} />
          <div className="text-center">
            <Money value={fmt0(paidSum)} className="text-2xl font-extrabold sm:text-3xl" />
            <div className="mt-0.5 text-[0.75rem] font-semibold text-muted-foreground">{t('paid so far')}</div>
          </div>
        </div>
        <div className="mt-4 text-center text-[0.71875rem] font-semibold text-muted-foreground">
          <b className="text-foreground">{act.length}</b> {t('active recurring bills')} · <b className="text-amber-400">{hasMulti ? '≈' : ''}{fmt(total)}</b>/{t('month')}
          {hasMulti && <span className="text-[0.6875rem] opacity-70"> {t('(2–3 mo bills averaged out)')}</span>}
        </div>
      </Card>

      {/* this month grid / list */}
      <div className="space-y-2.5">
        <div className="flex items-end justify-between">
          <SectionLabel title={isCurrent ? t('This month') : ymLabel(ym)} />
          <div className="flex items-center gap-2">
            <ViewToggle value={view} onChange={changeView} />
            <Button size="sm" onClick={() => setEditing(null)}><Plus />{t('Add recurring')}</Button>
          </div>
        </div>
        {monthly.length > 0 && (view === 'cards' ? (
          <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4 lg:grid-cols-6">
            {monthly.map((r) => {
              const paidTx = paidMap.get(r.id)
              const paid = !!paidTx
              const overdue = isCurrent && !paid && r.dueDay < todayDom
              return (
                <button
                  key={r.id}
                  onClick={() => setEditing(r.id)}
                  title={t('Edit this bill')}
                  className="relative flex flex-col items-center gap-1 rounded-2xl bg-card px-2 py-4 text-center transition hover:bg-accent/60"
                >
                  <span className={`absolute right-2 top-2 flex h-[18px] w-[18px] items-center justify-center rounded-full text-[0.625rem] font-black ${paid ? 'bg-primary text-primary-foreground' : 'bg-secondary text-muted-foreground'}`}>✓</span>
                  <CatIcon cat={r.cat} className="h-6 w-6" />
                  <span className="mt-1 w-full truncate text-[0.78125rem] font-bold">{r.desc}</span>
                  <Money value={fmt(r.amount)} className="text-[0.78125rem] font-extrabold" />
                  <span className={`text-[0.6875rem] font-semibold ${overdue ? 'text-red-400' : 'text-muted-foreground'}`}>{ordinal(r.dueDay)}</span>
                </button>
              )
            })}
          </div>
        ) : (
          <Card className="overflow-hidden">
            <div className="divide-y divide-border/60">
              {monthly.map((r, i) => {
                const paidTx = paidMap.get(r.id)
                const overdue = isCurrent && !paidTx && r.dueDay < todayDom
                const unpaid = !paidTx && (overdue || !isCurrent)
                return (
                  <button
                    key={r.id}
                    onClick={() => setEditing(r.id)}
                    className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-accent/60"
                  >
                    <span className="w-6 shrink-0 text-[0.75rem] font-semibold text-muted-foreground">{i + 1}.</span>
                    <CatIcon cat={r.cat} className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-bold">{r.desc}</span>
                    <span className={`shrink-0 text-[0.75rem] font-semibold ${overdue ? 'text-red-400' : 'text-muted-foreground'}`}>{ordinal(r.dueDay)}</span>
                    <Money value={fmt(r.amount)} className="shrink-0 text-right text-[0.8125rem] font-extrabold" />
                    <span className="flex w-24 shrink-0 items-center justify-end gap-1 text-[0.6875rem] font-semibold">
                      {paidTx ? (
                        <span className="flex items-center gap-1 text-emerald-400"><CheckCircle2 className="h-3.5 w-3.5" />{prettyDate(paidTx.date)}</span>
                      ) : unpaid ? (
                        <span className="text-red-400">{t('unpaid')}</span>
                      ) : (
                        <span className="text-muted-foreground">{t('upcoming')}</span>
                      )}
                    </span>
                  </button>
                )
              })}
            </div>
          </Card>
        ))}
        {!isCurrent && (
          <p className="text-[0.6875rem] text-muted-foreground/70">{t("Based on your current recurring list matched against that month's transactions.")}</p>
        )}
      </div>

      {/* what-if */}
      <Card className="p-4">
        <div className="mb-2 flex items-center gap-2">
          <FlaskConical className="h-4 w-4 text-muted-foreground" />
          <span className="text-[0.8125rem] font-semibold tracking-tight">{t('What-if simulator')}</span>
          <Badge className="uppercase tracking-wide">{t('nothing is actually changed')}</Badge>
        </div>
        {!sel.length ? (
          <div className="text-xs text-muted-foreground">{t('Check the box next to any bill below to see what canceling it would do to your monthly cash — and how much faster you could pay off your debt.')}</div>
        ) : (
          <>
            <div className="mb-2.5 text-xs text-muted-foreground">{t('If you cancel {count} bill{s} ({names}):', { count: sel.length, s: sel.length === 1 ? '' : 's', names: sel.map((r) => r.desc).join(', ') })}</div>
            <div className="mb-3 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[0.6875rem] text-muted-foreground">{t('You free up')}</div><div className="font-bold tracking-tight text-emerald-400">{fmt(save)}<span className="text-[0.6875rem] font-normal text-muted-foreground">/mo</span></div></div>
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[0.6875rem] text-muted-foreground">{t('Per year')}</div><div className="font-bold tracking-tight text-emerald-400">{fmt0(save * 12)}</div></div>
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[0.6875rem] text-muted-foreground">{t('Bills become')}</div><div className="font-bold tracking-tight">{fmt(total - save)}<span className="text-[0.6875rem] font-normal text-muted-foreground">/mo</span></div><div className="text-[0.625rem] text-muted-foreground/70">{t('was {amount}', { amount: fmt(total) })}</div></div>
              <div className="rounded-lg border bg-secondary/40 p-3"><div className="mb-0.5 text-[0.6875rem] text-muted-foreground">{t('Of your income')}</div><div className="font-bold tracking-tight">{avgIncome ? ((save / avgIncome) * 100).toFixed(1) + '%' : '—'}</div><div className="text-[0.625rem] text-muted-foreground/70">{t('≈{amount}/mo avg', { amount: fmt0(avgIncome) })}</div></div>
            </div>
            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3 text-xs">
              <CreditCard className="mr-1 inline h-4 w-4 align-[-3px] text-muted-foreground" />
              {sooner != null ? (
                t('Redirect that {save}/mo at your debt and you\'d be debt-free {months} sooner and save {interest} in interest (vs your current {budget}/mo plan).', { save: fmt(save), months: fmtMonths(Math.max(0, sooner)), interest: fmt0(Math.max(0, intSaved)), budget: fmt0(state.sim.budget) })
              ) : (
                t('Raise the payoff budget on the Debt page to see how redirecting this money would speed up your payoff.')
              )}
            </div>
            <Button variant="outline" size="xs" className="mt-2.5" onClick={() => setWhatIf(new Set())}>{t('Reset what-if')}</Button>
          </>
        )}
      </Card>

      {/* suggested subscriptions — detected from transaction history, see lib/recurring-detect.js */}
      {suggestions.length > 0 && (
        <Card className="p-4">
          <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-2">
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 shrink-0 text-muted-foreground" />
              <span className="text-[0.8125rem] font-semibold tracking-tight">{t('Suggested subscriptions')}</span>
            </div>
            <Badge className="w-fit text-[0.625rem] uppercase tracking-wide">{t('found in your transactions')}</Badge>
          </div>
          <div className="space-y-2">
            {suggestions.map((s) => {
              const acctRow = accountRowFor(s.accountId)
              const tags = acctRow ? tagsForAccount(state, accountUrlId(acctRow)) : []
              return (
                <div key={s.key} className="flex flex-wrap items-start gap-x-3 gap-y-2 rounded-xl border bg-secondary/30 px-3 py-2.5">
                  <span className="flex w-6 shrink-0 justify-center pt-0.5"><CatIcon cat={s.cat} /></span>
                  <div className="min-w-0 flex-1">
                    <div className="line-clamp-2 text-[0.8125rem] font-bold leading-snug">{s.displayName}</div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[0.6875rem] text-muted-foreground">
                      <span className="shrink-0">
                        {fmt(s.avgAmount)} · {CADENCE_LABEL[s.cadence] || s.cadence}
                        {s.typicalDay ? ` · ${t('usually the {day}', { day: ordinal(s.typicalDay) })}` : ''}
                      </span>
                      {/* Only flagged for the weaker 2-charge signal — a 3+
                          match is the normal/trusted case and doesn't need
                          a badge cluttering every row. */}
                      {s.confidenceLabel === 'medium' && (
                        <span className="shrink-0 rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0 text-[0.625rem] font-semibold text-amber-300">{t('seen 2x')}</span>
                      )}
                      {acctRow && (
                        <span className="flex min-w-0 items-center gap-1">
                          <Landmark className="h-2.5 w-2.5 shrink-0" />
                          <span className="truncate">{acctRow.institution || t('Bank')}{acctRow.mask ? ` ••${acctRow.mask}` : ''}</span>
                        </span>
                      )}
                      {tags.map((tag) => <TagPill key={tag.id} tag={tag.tag} />)}
                    </div>
                  </div>
                  <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
                    <Button size="xs" onClick={() => addSuggestion(s)}>{t('Add')}</Button>
                    <Button variant="outline" size="xs" onClick={() => dismissSuggestion(s.key)}>{t('Dismiss')}</Button>
                  </div>
                </div>
              )
            })}
          </div>
        </Card>
      )}

      {/* filters */}
      <Card className="flex flex-wrap items-center gap-2.5 p-3">
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input className="w-40 pl-8" placeholder={t('Search bills…')} value={filter.q} onChange={(e) => setFilter({ ...filter, q: e.target.value })} />
        </div>
        <Select className="text-xs" value={filter.cat} onChange={(e) => setFilter({ ...filter, cat: e.target.value })}>
          <option value="all">{t('All categories')}</option>
          {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
        </Select>
        <Select className="text-xs" value={filter.status} onChange={(e) => setFilter({ ...filter, status: e.target.value })}>
          <option value="all">{t('Active + paused')}</option><option value="active">{t('Active only')}</option><option value="paused">{t('Paused only')}</option>
        </Select>
        <Select className="text-xs" value={filter.sort} onChange={(e) => setFilter({ ...filter, sort: e.target.value })}>
          <option value="due">{t('Sort: due day')}</option><option value="amtHigh">{t('Sort: highest $')}</option><option value="amtLow">{t('Sort: lowest $')}</option><option value="name">{t('Sort: name A–Z')}</option>
        </Select>
        {isFiltered && (
          <>
            <Badge>{t('{count} shown', { count: list.length })} · <b className="text-amber-400">{fmt0(fTotal)}</b>/mo</Badge>
            <Button variant="outline" size="xs" onClick={() => setFilter({ cat: 'all', status: 'all', sort: 'due', q: '' })}>{t('Clear')}</Button>
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
                <input type="checkbox" className="h-4 w-4 shrink-0 cursor-pointer accent-emerald-400" checked={wi} disabled={off} onChange={() => toggleWhatIf(r.id)} title={t('What if I cancel this?')} />
                <span className="flex w-6 shrink-0 justify-center"><CatIcon cat={r.cat} /></span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.8125rem] font-bold">{r.desc}</div>
                  <div className="text-[0.6875rem] text-muted-foreground">
                    {recEvery(r) > 1 ? t('every {n} mo · next {date}', { n: recEvery(r), date: r.nextDate ? prettyDate(r.nextDate) : t('set a date') }) : t('day {day} · monthly', { day: r.dueDay })} · {catInfo(r.cat).name}
                  </div>
                  {accountLineFor(r.accountId)}
                </div>
                <span className="shrink-0 text-right">
                  <span className="text-[0.8125rem] font-semibold">{fmt(r.amount)}</span>
                  {recEvery(r) > 1 && <span className="block text-[0.625rem] text-muted-foreground">≈{fmt0(recMonthly(r))}/mo</span>}
                </span>
                <div className="flex w-full shrink-0 items-center justify-end gap-2 sm:w-auto">
                  <Button variant={off || logged ? 'outline' : 'secondary'} size="xs" disabled={off || logged} onClick={() => logRecurring(r)} title={logged ? t('Already logged this month') : t('Add this charge to this month’s transactions')}>
                    {logged ? t('✓ Logged') : t('Log this month')}
                  </Button>
                  <Button variant="outline" size="xs" onClick={() => { update((s) => { const rr = s.recurring.find((x) => x.id === r.id); rr.active = rr.active === false }); if (!off) setWhatIf((s) => { const n = new Set(s); n.delete(r.id); return n }) }}>
                    {off ? t('Enable') : t('Pause')}
                  </Button>
                  <button className="shrink-0 text-muted-foreground transition hover:text-foreground" onClick={() => setEditing(r.id)}><Pencil className="h-3.5 w-3.5" /></button>
                  <button className="shrink-0 text-muted-foreground transition hover:text-red-400" onClick={() => setConfirmDelId(r.id)}><X className="h-3.5 w-3.5" /></button>
                </div>
              </div>
            )
          }) : (
            <div className="p-10 text-center text-[0.8125rem] text-muted-foreground">
              {isFiltered ? <>{t('No bills match your filters')} — <button className="text-primary hover:underline" onClick={() => setFilter({ cat: 'all', status: 'all', sort: 'due', q: '' })}>{t('clear filters')}</button>.</> : t('No recurring bills yet.')}
            </div>
          )}
        </div>
      </Card>
      <p className="text-[0.6875rem] text-muted-foreground/70">{t('Recurring items show up in the dashboard\'s "due soon" list; "Log this month" records the charge as a transaction. Non-monthly bills advance their next date when logged.')}</p>

      {editing !== undefined && <RecurringDialog id={editing} onClose={() => setEditing(undefined)} />}
      {confirmDelBill && (
        <ConfirmDialog
          title={t('Delete recurring "{name}"?', { name: confirmDelBill.desc })}
          desc={t("This can't be undone.")}
          busy={deleting}
          onConfirm={handleDeleteRecurring}
          onClose={() => setConfirmDelId(null)}
        />
      )}
    </div>
  )
}

function RecurringDialog({ id, onClose }) {
  const { state, update } = useApp()
  const t = useT()
  const toast = useToast()
  const r = id ? state.recurring.find((x) => x.id === id) : { desc: '', amount: '', dueDay: 1, cat: 'subscriptions', every: 1, nextDate: null }
  const [f, setF] = useState({ ...r, every: r.every || 1, nextDate: r.nextDate || isoDate(nextDueDate(r.dueDay || 1)) })
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const save = () => {
    const desc = String(f.desc).trim()
    if (!desc) return toast(t('Enter a name'), 'error')
    const amount = parseFloat(f.amount)
    if (isNaN(amount)) return toast(t('Enter an amount'), 'error')
    const every = parseInt(f.every) || 1
    if (every > 1 && !f.nextDate) return toast(t('Pick the next payment date'), 'error')
    update((s) => {
      const data = { desc, amount, dueDay: Math.min(31, Math.max(1, parseInt(f.dueDay) || 1)), cat: f.cat, every, nextDate: every > 1 ? f.nextDate : null }
      if (id) Object.assign(s.recurring.find((x) => x.id === id), data)
      else s.recurring.push({ id: uid('r'), ...data, active: true })
    })
    toast(id ? t('Recurring updated') : t('Recurring added'))
    onClose()
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{id ? t('Edit Recurring Bill') : t('Add Recurring Bill')}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2"><Label>{t('Name')}</Label><Input value={f.desc} onChange={set('desc')} placeholder={t('e.g. Netflix')} /></div>
          <div><Label>{t('Amount ($)')}</Label><Input type="number" step="0.01" value={f.amount} onChange={set('amount')} /></div>
          <div><Label>{t('Day of month (1–31)')}</Label><Input type="number" min="1" max="31" value={f.dueDay} onChange={set('dueDay')} /></div>
          <div>
            <Label>{t('Repeats')}</Label>
            <Select className="w-full" value={f.every} onChange={set('every')}>
              {[[1, t('Every month')], [2, t('Every 2 months')], [3, t('Every 3 months')], [6, t('Every 6 months')], [12, t('Every year')]].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </div>
          {parseInt(f.every) > 1 && (
            <div><Label>{t('Next payment date')}</Label><Input type="date" value={f.nextDate} onChange={set('nextDate')} /></div>
          )}
          <div className="sm:col-span-2">
            <Label>{t('Category')}</Label>
            <Select className="w-full" value={f.cat} onChange={set('cat')}>
              {state.budgets.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button onClick={save}>{t('Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
