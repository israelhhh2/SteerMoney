'use client'
import { useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { Loader2, Trash2, Link2Off } from 'lucide-react'
import { AreaChart, Area, XAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { Segmented } from '@/components/ui/segmented'
import { Money, CardChip, CatIcon, CatChip, SourceBadge, ConfirmDialog, TransactionsSkeleton, ChartSkeleton, AccountTagsEditor, CardColorPicker } from '@/components/shared'
import { useApp } from '@/store'
import { useCenterToast } from '@/components/toast'
import { useT } from '@/lib/i18n'
import { fmt, fmt0, prettyDate, today } from '@/lib/utils'
import { matchesBankAccount } from '@/lib/finance'
import {
  RANGE_KEYS, typeLabel, pctChange30, relTime, accountHistorySeries,
  usePlaidItems, findAccountByUrlId, deleteManualAccount, deleteDebt, backToAccounts, colorForAccount,
} from '@/lib/accounts'

// Same wording lib/recurring-detect.js's EXCLUDE_PATTERNS already treats as
// "not a subscription, it's interest" — reused here (not imported, it's not
// exported and this only needs the two interest-specific patterns, not the
// whole cash-advance/fee/transfer exclusion list) to total up interest
// charges for the Card summary section below.
const INTEREST_PATTERNS = [/interest\s*charge/i, /finance\s*charge/i]

// Finds the Debt Tracker row (APR/min payment/due day live there, not on the
// Plaid account itself) behind a merged-inventory credit-card row. A `source
// === 'debt'` row already carries its own debtId. A `source === 'plaid'` row
// (no matching debt found by lib/accounts.js's buildAccountInventory, e.g.
// the auto-sync in lib/plaid-debts.js hasn't run yet) gets one more direct
// shot first via plaid_account_id — an exact id match that's stricter (and
// cheaper) than fuzzy name matching — before falling back to the same
// name/mask fuzzy matcher (lib/finance.js) the rest of the app already uses.
function findLinkedDebt(account, debts) {
  if (!debts?.length) return null
  if (account.source === 'debt' && account.debtId) return debts.find((d) => d.id === account.debtId) || null
  if (account.account_id) {
    const exact = debts.find((d) => d.plaidAccountId === account.account_id)
    if (exact) return exact
    return debts.find((d) => matchesBankAccount(d, [account])) || null
  }
  return null
}

const TIP = { contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 } }
const LABEL_COLOR = '#6f8bb8'
const TX_ROW_LIMIT = 60 // detail view shows recent activity; "View all" hands off to /transactions

function StatLabel({ children }) {
  return <div className="whitespace-nowrap text-[0.625rem] font-bold uppercase tracking-wide sm:text-[0.65rem]" style={{ color: LABEL_COLOR }}>{children}</div>
}

function ChangePill({ pct }) {
  const good = pct >= 0
  return (
    <span className={`inline-flex items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[0.625rem] font-bold ${good ? 'bg-emerald-400/10 text-emerald-400' : 'bg-red-400/10 text-red-400'}`}>
      {pct >= 0 ? '↗' : '↘'} {Math.abs(pct).toFixed(2)}%
    </span>
  )
}

// Copilot-style account detail: centered chip, name, three stats, a
// balance-history chart with its own range pills, last-sync note, a
// manage/edit action, and that account's own transactions inline. Used both
// as the full page (app/(app)/accounts/[id]/page.jsx) and, byte-identical,
// inside the Notion-style modal overlay (app/(app)/@modal/(.)accounts/[id]).
export default function AccountDetail({ id }) {
  const t = useT()
  const { state, update } = useApp()
  const { plaidItems, plaidChecked } = usePlaidItems()
  const [range, setRange] = useState('1M')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const router = useRouter()
  const centerToast = useCenterToast()

  const account = useMemo(
    () => (state ? findAccountByUrlId(id, state, plaidItems) : null),
    [id, state, plaidItems]
  )

  if (!state || !plaidChecked) {
    return <div className="py-16 text-center text-[0.8125rem] text-muted-foreground">{t('Loading account…')}</div>
  }

  if (!account) {
    return (
      <div className="space-y-3 py-10 text-center">
        <p className="text-[0.8125rem] text-muted-foreground">{t("We couldn't find that account.")}</p>
        <Link href="/accounts" className="text-[0.8125rem] font-semibold text-primary hover:underline">{t('Back to Accounts')}</Link>
      </div>
    )
  }

  // 'syncing' means this account's bank connection is still pulling in its
  // 730-day historical backfill (see lib/plaid-sync.js) — show placeholders
  // instead of a misleadingly-flat balance chart or an incomplete
  // transaction list. usePlaidItems() (lib/accounts.js) polls in the
  // background and this flips to false on its own once the backfill lands.
  const isSyncing = account.status === 'syncing'
  const isCredit = account.kind === 'credit' || account.kind === 'loan'
  const util = account.limit ? Math.min(999, Math.round((account.balance / account.limit) * 100)) : null

  // Card summary (payment/interest info) — credit cards only, never loans:
  // APR/minimum payment/due day aren't meaningful loan concepts the way this
  // app models them (Debt Tracker rows only ever get those fields from a
  // Plaid *credit card* liability, see lib/plaid-debts.js), so this stays
  // narrower than the `isCredit` flag the top stat row/chart color use.
  const isCreditCard = account.kind === 'credit'
  const linkedDebt = isCreditCard ? findLinkedDebt(account, state.debts) : null
  const cardApr = linkedDebt?.apr && linkedDebt.apr !== '—' ? linkedDebt.apr : null
  const cardMinPayment = linkedDebt?.min ? linkedDebt.min : null
  const cardDueDay = linkedDebt?.dueDay || null
  // "Interest charged this month": only computable for a Plaid-linked
  // account (needs real transactions to scan) — a manual/unlinked debt has
  // no transaction feed to look at, so this stays null (hidden) for those.
  const interestThisMonth = isCreditCard && account.account_id
    ? (state.transactions || [])
        .filter((t) => t.accountId === account.account_id && t.type === 'expense' && t.date.slice(0, 7) === today().slice(0, 7) && INTEREST_PATTERNS.some((re) => re.test(t.desc)))
        .reduce((sum, t) => sum + t.amount, 0)
    : null
  const history = accountHistorySeries(account, state.transactions, range)
  const changePct = pctChange30(account.history, account.balance)
  const lineColor = isCredit ? '#e08a3d' : '#5b9df9'

  const txHref = account.account_id ? `/transactions?account=${encodeURIComponent(account.account_id)}` : '/transactions'
  const manageHref = account.source === 'debt' ? '/debts' : account.source === 'plaid' ? '/settings' : null
  const manageLabel = account.source === 'manual' ? t('Edit account') : account.source === 'debt' ? t('Manage in Debt Tracker') : t('Manage connection')

  // Destructive action: manual rows delete straight out of the store (reusing
  // the exact mutations Accounts.jsx/Debts.jsx already use), Plaid rows can
  // only be disconnected at the bank-connection (item) level — there's no
  // per-account delete in Plaid's API.
  const isPlaid = account.source === 'plaid'
  const isDebt = account.source === 'debt'
  const destructiveLabel = isPlaid ? t('Disconnect bank') : isDebt ? t('Delete debt') : t('Delete account')
  const confirmTitle = isPlaid ? t('Disconnect {bank}?', { bank: account.institution || t('this bank') }) : t('Delete {name}?', { name: account.name })
  const confirmDesc = isPlaid
    ? t('All its accounts stop syncing. Existing transactions stay.')
    : t('This removes it and its history from SteerMoney.')

  const goBack = () => backToAccounts(router)

  const handleDelete = async () => {
    if (isPlaid) {
      if (!account.item_id) { centerToast(t("Couldn't find that bank connection"), 'error'); setConfirmDelete(false); return }
      setDeleting(true)
      try {
        const res = await fetch('/api/plaid/items', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ item_id: account.item_id }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || t("Couldn't disconnect that bank"))
        // Best-effort tag/color cleanup for this one account_id — a full item can
        // have several accounts, but this is the only one we have in hand here; any
        // sibling account's tags/colors are harmlessly orphaned (never shown again
        // since nothing will match their accountKey once this item is gone).
        if (account.account_id) update((s) => {
          s.accountTags = (s.accountTags || []).filter((t) => t.accountKey !== account.account_id)
          s.accountColors = (s.accountColors || []).filter((c) => c.accountKey !== account.account_id)
        })
        centerToast(t('{name} disconnected', { name: account.institution || t('Bank') }))
        setConfirmDelete(false)
        setDeleting(false)
        // Hard navigation, not router.push: the Accounts page fetches
        // /api/plaid/items once on mount (usePlaidItems), so a soft nav
        // keeps showing the just-disconnected bank until a manual refresh.
        // Short delay so the success toast is actually seen first.
        setTimeout(() => window.location.assign('/accounts'), 900)
        return
      } catch (e) {
        centerToast(e.message, 'error')
        setDeleting(false)
        return
      }
    }
    // Local store deletes are synchronous, but the confirm dialog's spinner
    // should still show briefly so the delete reads as "working" rather than
    // instant/silent — matches the feedback the Plaid disconnect path gets.
    setDeleting(true)
    await new Promise((r) => setTimeout(r, 350))
    try {
      if (isDebt) deleteDebt(update, account.debtId)
      else deleteManualAccount(update, account.accountRowId)
      centerToast(t('{name} deleted', { name: isDebt ? t('Debt') : account.name }))
      setConfirmDelete(false)
      setDeleting(false)
      goBack()
    } catch (e) {
      centerToast(e?.message || t('Something went wrong'), 'error')
      setDeleting(false)
    }
  }

  const accountTx = account.account_id
    ? state.transactions.filter((t) => t.accountId === account.account_id).slice().sort((a, b) => b.date.localeCompare(a.date))
    : []
  const byDate = {}
  accountTx.forEach((t) => { (byDate[t.date] = byDate[t.date] || []).push(t) })
  const dates = Object.keys(byDate).sort().reverse().slice(0, TX_ROW_LIMIT)

  return (
    <div className="flex flex-col items-center gap-4">
      <span className="text-[0.625rem] font-bold uppercase tracking-wider" style={{ color: LABEL_COLOR }}>{t(typeLabel(account))}</span>

      <CardChip institution={account.institution} name={account.name} mask={account.mask} size="lg" colorOverride={colorForAccount(state, id)} />

      <h1 className="max-w-full truncate text-center text-lg font-extrabold tracking-tight">{account.name}</h1>

      <div className="grid w-full max-w-sm grid-cols-3 gap-1.5 text-center sm:gap-2">
        {isCredit ? (
          <>
            <div><StatLabel>{t('Balance')}</StatLabel><Money value={fmt0(account.balance)} className="text-lg font-extrabold sm:text-xl" /></div>
            <div><StatLabel>{t('Limit')}</StatLabel>{account.limit ? <Money value={fmt0(account.limit)} className="text-lg font-extrabold sm:text-xl" /> : <div className="text-lg font-extrabold text-muted-foreground sm:text-xl">–</div>}</div>
            <div><StatLabel>{t('Utilized')}</StatLabel><div className="text-lg font-extrabold sm:text-xl">{util != null ? util + '%' : '–'}</div></div>
          </>
        ) : (
          <>
            <div><StatLabel>{t('Available')}</StatLabel><Money value={fmt0(account.available ?? account.balance)} className="text-lg font-extrabold sm:text-xl" /></div>
            <div><StatLabel>{t('Current')}</StatLabel><Money value={fmt0(account.balance)} className="text-lg font-extrabold sm:text-xl" /></div>
            <div><StatLabel>{t('Change')}</StatLabel>{changePct == null ? <div className="text-lg font-extrabold text-muted-foreground sm:text-xl">–</div> : <ChangePill pct={changePct} />}</div>
          </>
        )}
      </div>

      {isSyncing ? (
        <ChartSkeleton className="h-40 w-full max-w-xl" />
      ) : (
        <div className="h-40 w-full max-w-xl">
          <ResponsiveContainer>
            <AreaChart data={history} margin={{ top: 6, right: 4, left: 4, bottom: 0 }}>
              <defs>
                <linearGradient id="detailHist" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={lineColor} stopOpacity={0.35} />
                  <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
                </linearGradient>
              </defs>
              <XAxis dataKey="name" hide />
              <Tooltip {...TIP} formatter={(v) => fmt0(v)} />
              <Area type="monotone" dataKey="balance" stroke={lineColor} strokeWidth={2.5} fill="url(#detailHist)" dot={false}
                style={{ filter: `drop-shadow(0 0 6px ${isCredit ? 'rgba(224,138,61,0.4)' : 'rgba(91,157,249,0.45)'})` }} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}

      <Segmented options={RANGE_KEYS.map((k) => [k, k])} value={range} onChange={setRange} />

      <div className="flex flex-col items-center gap-1.5">
        <SourceBadge accountId={account.account_id} institution={account.institution} />
        <p className="text-center text-[0.71875rem] text-muted-foreground">
          {account.last_synced ? t('Latest update received {time}', { time: relTime(account.last_synced) }) : t('Manual account')}
        </p>
      </div>

      {/* Card summary: APR/minimum payment/due day/credit-limit/balance/
          utilization + this month's interest charges, credit cards only.
          Hidden entirely for non-credit accounts (loans, depository) and
          when the account has no debtId/account_id at all to look anything
          up from; every individual field inside falls back to "–" rather
          than showing blank/undefined/NaN, so a card with a Plaid balance
          but no liabilities data (institution doesn't support the product,
          or supabase/debts-plaid.sql hasn't been run yet — see
          lib/plaid-debts.js) still renders a useful, non-broken card. Same
          StatLabel/grid pattern the top-of-page stats and views/Accounts.jsx
          already use, in its own bordered box (like Tags/Card color below)
          rather than a plain grid, so it reads as one distinct "summary
          card" — kept 2-up (not 3) and full-width for the interest row so
          nothing crowds at a 390px mobile width. */}
      {isCreditCard && (
        <div className="w-full max-w-sm space-y-2.5">
          <h3 className="px-0.5 text-[0.9375rem] font-semibold">{t('Card summary')}</h3>
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 rounded-xl border p-4">
            <div><StatLabel>{t('Balance')}</StatLabel><Money value={fmt0(account.balance)} className="text-sm font-extrabold" /></div>
            <div><StatLabel>{t('Credit limit')}</StatLabel>{account.limit ? <Money value={fmt0(account.limit)} className="text-sm font-extrabold" /> : <div className="text-sm font-extrabold text-muted-foreground">–</div>}</div>
            <div><StatLabel>{t('Utilized')}</StatLabel><div className="text-sm font-extrabold">{util != null ? util + '%' : '–'}</div></div>
            <div><StatLabel>{t('APR')}</StatLabel><div className="text-sm font-extrabold">{cardApr || '–'}</div></div>
            <div><StatLabel>{t('Min payment')}</StatLabel>{cardMinPayment ? <Money value={fmt0(cardMinPayment)} className="text-sm font-extrabold" /> : <div className="text-sm font-extrabold text-muted-foreground">–</div>}</div>
            <div><StatLabel>{t('Due day')}</StatLabel><div className="text-sm font-extrabold">{cardDueDay || '–'}</div></div>
            {interestThisMonth != null && (
              <div className="col-span-2 border-t border-border/60 pt-3">
                <StatLabel>{t('Interest charged this month')}</StatLabel>
                <Money value={fmt0(interestThisMonth)} className={`text-sm font-extrabold ${interestThisMonth > 0 ? 'text-red-400' : ''}`} />
              </div>
            )}
          </div>
          {!linkedDebt && (
            <p className="px-0.5 text-[0.71875rem] text-muted-foreground">
              {t('APR, minimum payment, and due day come from the Debt Tracker —')} {account.source === 'plaid' ? t('sync your accounts or') + ' ' : ''}
              <Link href="/debts" className="font-semibold text-primary hover:underline">{t('add this card there')}</Link> {t('to fill them in.')}
            </p>
          )}
        </div>
      )}

      {/* Tags: per-account labels ("Mine"/"Julia's"/"Business") — see
          lib/accounts.js's tag helpers and CLAUDE.md 2026-08-08 (10). Works
          for every account type since `id` here is already the canonical
          accountUrlId() this row was looked up by. */}
      <AccountTagsEditor accountKey={id} className="w-full max-w-sm" />

      {/* Card color: tap-to-select preset swatches (+ "Auto" to reset) —
          see components/shared.jsx's CardColorPicker/lib/accounts.js's
          colorForAccount/setAccountColor. Same accountKey as the tags
          editor above, so it works unchanged for every account type. */}
      <div className="flex w-full max-w-sm flex-col items-center gap-1.5">
        <span className="text-[0.625rem] font-bold uppercase tracking-wide" style={{ color: LABEL_COLOR }}>{t('Card color')}</span>
        <CardColorPicker accountKey={id} />
      </div>

      <div className="w-full max-w-sm space-y-2">
        {isPlaid ? (
          // Hard navigation on purpose: this button renders both as the full
          // page AND inside the Notion-style @modal overlay. A soft <Link>
          // to /settings did nothing visible when the modal was opened while
          // /settings was already the page underneath it (the URL bar shows
          // /accounts/[id] due to the interception, so Next has no way to
          // know "we're already there" and the overlay just sat in place).
          // window.location.assign() always tears the whole app down and
          // reloads straight into /settings, so it closes the modal and
          // lands on the right page in both contexts, at the cost of a full
          // reload for this one (infrequent) action.
          <button
            type="button"
            onClick={() => { if (typeof window !== 'undefined') window.location.assign('/settings') }}
            className="block w-full rounded-xl bg-primary px-4 py-3 text-center text-[0.84375rem] font-bold text-primary-foreground transition hover:bg-primary/90"
          >
            {manageLabel}
          </button>
        ) : manageHref ? (
          <Link href={manageHref} className="block w-full rounded-xl bg-primary px-4 py-3 text-center text-[0.84375rem] font-bold text-primary-foreground transition hover:bg-primary/90">{manageLabel}</Link>
        ) : account.source === 'manual' ? (
          <Link href={`/accounts?edit=${encodeURIComponent(account.accountRowId)}`} className="block w-full rounded-xl bg-primary px-4 py-3 text-center text-[0.84375rem] font-bold text-primary-foreground transition hover:bg-primary/90">{manageLabel}</Link>
        ) : null}
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={deleting}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-destructive/30 bg-destructive/15 px-4 py-3 text-center text-[0.84375rem] font-bold text-red-400 transition hover:bg-destructive/25 disabled:opacity-50"
        >
          {deleting ? <Loader2 className="h-4 w-4 animate-spin" /> : isPlaid ? <Link2Off className="h-4 w-4" /> : <Trash2 className="h-4 w-4" />}
          {destructiveLabel}
        </button>
      </div>

      {confirmDelete && (
        <ConfirmDialog
          title={confirmTitle}
          desc={confirmDesc}
          confirmLabel={destructiveLabel}
          busy={deleting}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(false)}
        />
      )}

      <div className="w-full space-y-2.5 border-t border-border/60 pt-5">
        <div className="flex items-center justify-between px-0.5">
          <h3 className="text-[0.9375rem] font-semibold">{t('Transactions')}</h3>
          {account.account_id ? (
            // Hard navigation, not <Link>: a soft nav to a non-intercepted
            // route leaves the @modal slot's previous content mounted, so
            // the overlay stayed open on top of /transactions.
            <button
              type="button"
              onClick={() => { if (typeof window !== 'undefined') window.location.assign(txHref) }}
              className="flex shrink-0 items-center text-[0.78125rem] font-bold text-primary/90 transition hover:text-primary"
            >{t('View all in Transactions ›')}</button>
          ) : null}
        </div>
        {isSyncing ? (
          <TransactionsSkeleton />
        ) : dates.length ? (
          <div className="divide-y divide-border/60 overflow-hidden rounded-xl border">
            {dates.map((dt) => (
              <div key={dt}>
                <div className="border-b border-border/60 bg-secondary/40 px-4 py-1.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground">{prettyDate(dt)}</div>
                {byDate[dt].map((t) => (
                  <div key={t.id} className="flex items-center gap-3 px-4 py-2">
                    <span className="flex w-6 shrink-0 justify-center"><CatIcon cat={t.cat} /></span>
                    <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground/90" title={t.desc}>{t.desc}</span>
                    <span className="hidden sm:inline-flex"><CatChip cat={t.cat} /></span>
                    <span className={`w-20 shrink-0 text-right text-[0.8125rem] font-semibold sm:w-24 ${t.type === 'income' ? 'text-emerald-400' : t.cat === 'transfer' ? 'text-muted-foreground' : ''}`}>
                      {t.type === 'income' ? '+' : '−'}{fmt(t.amount)}
                    </span>
                  </div>
                ))}
              </div>
            ))}
          </div>
        ) : (
          <div className="rounded-xl border p-6 text-center text-[0.78125rem] text-muted-foreground">
            {account.account_id
              ? t('No transactions linked to this account yet — older synced transactions may predate account linkage.')
              : t("Manual accounts don't have linked transactions.")}
          </div>
        )}
      </div>
    </div>
  )
}
