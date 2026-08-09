'use client'
import { useState } from 'react'
import Link from 'next/link'
import { useUser } from '@clerk/nextjs'
import { Home, Car, ShoppingBag, Utensils, ShoppingCart, Package, Users, Banknote, Wifi, Baby, Clapperboard, Tv, Wrench, Scissors, CreditCard, TrendingUp, Repeat, ChevronRight, LayoutGrid, List, Link2, Pencil, Loader2, Plus, X, RotateCcw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { catColor, fmt0, cn } from '@/lib/utils'
import { useApp } from '@/store'
import { tagsForAccount, allAccountTags, addAccountTag, removeAccountTag, colorForAccount, setAccountColor } from '@/lib/accounts'
import { useT } from '@/lib/i18n'

const CAT_ICONS = {
  housing: Home, auto: Car, shopping: ShoppingBag, dining: Utensils, groceries: ShoppingCart,
  other: Package, family: Users, cash: Banknote, utilities: Wifi, kids: Baby,
  entertainment: Clapperboard, subscriptions: Tv, household: Wrench, personal: Scissors,
  debt: CreditCard, income: TrendingUp, transfer: Repeat,
}

export function CatIcon({ cat, className = 'h-4 w-4' }) {
  const I = CAT_ICONS[cat] || Package
  return <I className={className} style={{ color: catColor(cat) }} />
}

export function CatTile({ cat, className = '' }) {
  const c = catColor(cat)
  return (
    <span
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl ${className}`}
      style={{ color: c, background: c + '14', border: `1px solid ${c}30` }}
    >
      <CatIcon cat={cat} className="h-4 w-4" style={{ color: c }} />
    </span>
  )
}

export function CatChip({ cat }) {
  const { catInfo } = useApp()
  return (
    <Badge>
      <CatIcon cat={cat} className="h-3 w-3" />
      {catInfo(cat).name}
    </Badge>
  )
}

// Copilot-style cards/list view toggle, used by Recurring/Budgets/Goals; persistence key is left to the caller.
export function ViewToggle({ value, onChange }) {
  const t = useT()
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      <button title={t('Card view')} onClick={() => onChange('cards')} className={`rounded px-1.5 py-1 transition ${value === 'cards' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}><LayoutGrid className="h-3.5 w-3.5" /></button>
      <button title={t('List view')} onClick={() => onChange('list')} className={`rounded px-1.5 py-1 transition ${value === 'list' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}><List className="h-3.5 w-3.5" /></button>
    </div>
  )
}

// Copilot-style uppercase section label with an optional "Link ›" on the right.
export function SectionLabel({ title, link, href, onClick }) {
  const right = link ? (
    href ? (
      <Link href={href} className="flex items-center text-[0.78125rem] font-bold text-primary/90 transition hover:text-primary">{link}<ChevronRight className="h-3.5 w-3.5" /></Link>
    ) : (
      <button onClick={onClick} className="flex items-center text-[0.78125rem] font-bold text-primary/90 transition hover:text-primary">{link}<ChevronRight className="h-3.5 w-3.5" /></button>
    )
  ) : null
  return (
    <div className="flex items-end justify-between px-0.5">
      <h3 className="text-[0.71875rem] font-extrabold uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>
      {right}
    </div>
  )
}

// `href`/`total`/`chevron` are opt-in additions for the Dashboard's clickable-card
// pass — with none of them set this renders byte-identical markup to before, so
// every existing caller (Charts/Debts/Simulator/etc.) is unaffected.
export function SectionHead({ title, desc, total, chevron = false, href }) {
  if (!href && total == null && !chevron) {
    return (
      <div>
        {title ? <h3 className="text-[0.84375rem] font-bold tracking-tight">{title}</h3> : null}
        {desc ? <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p> : null}
      </div>
    )
  }
  const showChevron = href || chevron
  const titleEl = title ? (
    <h3 className="flex min-w-0 items-center gap-1.5 text-[0.84375rem] font-bold tracking-tight">
      <span className="truncate">{title}</span>
      {total != null ? <span className="shrink-0 whitespace-nowrap text-xs font-semibold text-muted-foreground">{total}</span> : null}
      {showChevron ? <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition group-hover:translate-x-0.5 group-hover:text-primary" /> : null}
    </h3>
  ) : null
  const body = (
    <div className="min-w-0">
      {titleEl}
      {desc ? <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p> : null}
    </div>
  )
  // `href` gives the header its own click target (used standalone, e.g. Cash Flow).
  // `chevron` alone just draws the affordance when a parent element is already the link.
  return href ? <Link href={href} className="group block min-w-0 transition hover:text-primary">{body}</Link> : body
}

// Big money value with Copilot's small superscript dollar sign.
export function Money({ value, className = '' }) {
  const neg = /^[-−]/.test(String(value))
  const clean = String(value).replace(/^[-−]?\$?/, '')
  return (
    <span className={`whitespace-nowrap tracking-tight ${className}`}>
      {neg && '-'}<sup className="mr-px text-[0.62em] font-bold opacity-80">$</sup>{clean}
    </span>
  )
}

// Deterministic hue from an institution/account name so each card gets a stable,
// distinct gradient (no real issuer branding data available — this stands in for it).
export function cardHue(seed) {
  let h = 0
  const s = seed || ''
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
  return h
}

// Curated preset hues for the "let me edit the card to change color" feature
// (CardColorPicker below) — same gradient formula cardHue()'s hash-based
// default already uses, just fixed to hues that read as an obvious color
// name instead of an arbitrary one, so users pick from something
// recognizable rather than a random point on the wheel.
export const CARD_COLOR_PRESETS = [
  { key: 'red', label: 'Red', hue: 355 },
  { key: 'orange', label: 'Orange', hue: 22 },
  { key: 'amber', label: 'Amber', hue: 42 },
  { key: 'green', label: 'Green', hue: 145 },
  { key: 'teal', label: 'Teal', hue: 178 },
  { key: 'blue', label: 'Blue', hue: 210 },
  { key: 'indigo', label: 'Indigo', hue: 245 },
  { key: 'violet', label: 'Violet', hue: 268 },
  { key: 'pink', label: 'Pink', hue: 330 },
]

function cardGradient(hue) {
  return `linear-gradient(135deg, hsl(${hue} 65% 40%), hsl(${(hue + 40) % 360} 55% 24%))`
}

// Copilot-style "credit card" visual chip, shared by the Dashboard's Credit Cards
// list and the Accounts page's account rows/detail sheet.
// `size`: 'dash' (Dashboard's small name-only chip — exact previous look) ·
// 'row' (Accounts list rows, default) · 'lg' (Accounts detail sheet, bigger).
// `colorOverride`: an optional hue number (one of CARD_COLOR_PRESETS, or any
// number) from lib/accounts.js's colorForAccount() — when present, it wins
// over the deterministic name/institution hash; omitted or null falls back
// to the original auto-color behavior unchanged (0 is a valid override hue,
// so this checks for null/undefined specifically, not falsiness).
export function CardChip({ institution, name, mask, size = 'row', colorOverride }) {
  const hue = colorOverride ?? cardHue(institution || name || '')
  const gradient = cardGradient(hue)

  if (size === 'dash') {
    return (
      <div className="flex h-10 w-16 shrink-0 items-center justify-center overflow-hidden rounded-xl px-1.5 shadow-sm" style={{ background: gradient }}>
        <span className="truncate text-center text-[0.5625rem] font-bold leading-tight text-white/90">{name}</span>
      </div>
    )
  }
  const big = size === 'lg'
  return (
    <div
      className={cn('flex shrink-0 flex-col justify-between overflow-hidden shadow-md', big ? 'h-32 w-56 rounded-2xl p-4' : 'h-20 w-32 rounded-xl p-2.5')}
      style={{ background: gradient }}
    >
      <div className={cn('truncate font-semibold text-white/80', big ? 'text-xs' : 'text-[0.5625rem]')}>{institution || 'Bank'}</div>
      <div className="flex items-end justify-between gap-1">
        <span className={cn('truncate font-bold text-white', big ? 'text-sm' : 'text-[0.625rem]')}>{name}</span>
        {mask ? <span className={cn('shrink-0 font-semibold text-white/70', big ? 'text-xs' : 'text-[0.5625rem]')}>••{mask}</span> : null}
      </div>
    </div>
  )
}

// Tiny muted "where did this data come from" pill for account rows/detail —
// a manually-entered debt/account gets a plain "Manual" pill (Pencil icon);
// anything actually linked to a Plaid account_id gets "Plaid · {institution}"
// (Link2 icon). A manual debt that happens to fuzzy-match a connected Plaid
// account (see lib/finance.js matchesBankAccount) picks up that account's
// account_id too, so this same `!!account_id` check is the single source of
// truth for both — no separate manual/matched-debt branch needed.
export function SourceBadge({ accountId, institution, className = '' }) {
  const t = useT()
  const linked = !!accountId
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide',
        linked ? 'border-indigo-400/25 bg-indigo-400/10 text-indigo-300' : 'border-border bg-secondary/60 text-muted-foreground',
        className
      )}
    >
      {linked ? <Link2 className="h-2.5 w-2.5" /> : <Pencil className="h-2.5 w-2.5" />}
      {linked ? t('Plaid · {institution}', { institution: institution || t('Bank') }) : t('Manual')}
    </span>
  )
}

// ---- Account tags ("Mine"/"Julia's"/"Business" — shared-space account labels) ----
// Small fixed palette, picked by hashing the tag name — same "deterministic,
// no real data needed" trick as cardHue() above, just mapped onto a curated
// set of muted pill tones instead of an arbitrary hue so tags always look
// intentional next to the rest of this dark UI.
const TAG_PALETTE = [
  { bg: 'bg-sky-400/10', text: 'text-sky-300', border: 'border-sky-400/25' },
  { bg: 'bg-violet-400/10', text: 'text-violet-300', border: 'border-violet-400/25' },
  { bg: 'bg-emerald-400/10', text: 'text-emerald-300', border: 'border-emerald-400/25' },
  { bg: 'bg-amber-400/10', text: 'text-amber-300', border: 'border-amber-400/25' },
  { bg: 'bg-pink-400/10', text: 'text-pink-300', border: 'border-pink-400/25' },
  { bg: 'bg-cyan-400/10', text: 'text-cyan-300', border: 'border-cyan-400/25' },
]

export function tagTone(tag) {
  let h = 0
  const s = String(tag || '').toLowerCase()
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % TAG_PALETTE.length
  return TAG_PALETTE[h]
}

// Read-only pill — Accounts.jsx list rows and AccountDetail.jsx both use this
// for display; pass `onRemove` to also get an × (AccountTagsEditor below).
export function TagPill({ tag, onRemove, className = '' }) {
  const t = useT()
  const tone = tagTone(tag)
  return (
    <span className={cn('inline-flex max-w-[8rem] shrink-0 items-center gap-1 rounded-full border px-2 py-0.5 text-[0.625rem] font-bold', tone.bg, tone.text, tone.border, className)}>
      <span className="truncate">{tag}</span>
      {onRemove ? (
        <button type="button" onClick={onRemove} aria-label={t('Remove {tag} tag', { tag })} className="shrink-0 rounded-full p-0.5 opacity-70 transition hover:opacity-100">
          <X className="h-2.5 w-2.5" />
        </button>
      ) : null}
    </span>
  )
}

function TagSuggestChip({ label, onClick }) {
  return (
    <button type="button" onClick={onClick} className="shrink-0 rounded-full border border-border/70 bg-secondary/50 px-2 py-0.5 text-[0.625rem] font-semibold text-muted-foreground transition hover:text-foreground">
      {label}
    </button>
  )
}

// Editable tags row for one account — existing tags as removable pills, a
// "+ Add tag" ghost button that reveals a tiny inline input, and tap-to-add
// suggestions (existing tags in the space so "Julia" gets reused rather than
// retyped, or — the very first time, before any tag exists anywhere in this
// space — the signed-in user's own first name + "Shared", so a couple has an
// obvious starting point instead of a blank input). `accountKey` must be the
// same canonical id accountUrlId() (lib/accounts.js) produces — works
// unchanged for manual accounts, manual debts, and Plaid accounts.
export function AccountTagsEditor({ accountKey, className = '' }) {
  const { state, update } = useApp()
  const { user } = useUser()
  const t = useT()
  const [adding, setAdding] = useState(false)
  const [text, setText] = useState('')

  const tags = tagsForAccount(state, accountKey)
  const spaceTags = allAccountTags(state)
  const noTagsYet = spaceTags.length === 0
  const suggestions = spaceTags.filter((t) => !tags.some((x) => x.tag.toLowerCase() === t.toLowerCase()))
  const firstName = user?.firstName || null

  const commit = (raw) => {
    const val = String(raw ?? text).trim()
    if (!val) return
    addAccountTag(update, accountKey, val)
    setText('')
    setAdding(false)
  }

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-1.5', className)}>
      {tags.map((t) => <TagPill key={t.id} tag={t.tag} onRemove={() => removeAccountTag(update, t.id)} />)}

      {adding ? (
        <>
          <span className="inline-flex items-center gap-1">
            <input
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commit(text)
                if (e.key === 'Escape') { setAdding(false); setText('') }
              }}
              maxLength={24}
              placeholder={noTagsYet ? (firstName ? t('e.g. {name}', { name: firstName }) : t("e.g. Mine, Julia’s, Business")) : t('Tag name')}
              className="h-6 w-28 rounded-full border border-input bg-transparent px-2.5 text-[0.6875rem] outline-none focus-visible:ring-1 focus-visible:ring-ring [color-scheme:dark]"
            />
            <button type="button" onClick={() => commit(text)} className="shrink-0 rounded-full bg-primary/90 px-2 py-0.5 text-[0.625rem] font-bold text-primary-foreground">{t('Add')}</button>
            <button type="button" onClick={() => { setAdding(false); setText('') }} className="shrink-0 text-[0.625rem] font-semibold text-muted-foreground hover:text-foreground">{t('Cancel')}</button>
          </span>
          {!text && noTagsYet && firstName && (
            <div className="flex w-full flex-wrap items-center justify-center gap-1.5 pt-0.5">
              <TagSuggestChip label={firstName} onClick={() => commit(firstName)} />
              <TagSuggestChip label={t('Shared')} onClick={() => commit('Shared')} />
            </div>
          )}
          {!text && !noTagsYet && suggestions.length > 0 && (
            <div className="flex w-full flex-wrap items-center justify-center gap-1.5 pt-0.5">
              {suggestions.slice(0, 6).map((s) => <TagSuggestChip key={s} label={s} onClick={() => commit(s)} />)}
            </div>
          )}
        </>
      ) : (
        <button
          type="button"
          onClick={() => setAdding(true)}
          className="inline-flex shrink-0 items-center gap-0.5 rounded-full border border-dashed border-border px-2 py-0.5 text-[0.625rem] font-semibold text-muted-foreground transition hover:border-primary/40 hover:text-primary"
        >
          <Plus className="h-2.5 w-2.5" />{t('Add tag')}
        </button>
      )}
    </div>
  )
}

// ---- card color picker ("let me edit the card to change color") ----
// Tap-to-select swatches — no free-form color picker, per the "keep it dead
// simple, non-tech users" brief every other account-detail control here
// follows. `accountKey` is the same canonical accountUrlId() AccountTagsEditor
// above already takes, so this works unchanged for manual accounts, manual
// debts, and Plaid accounts, and rides along with shared spaces for free
// (same reasoning as tags — store.jsx re-points the whole state, colors
// included, at the active space).
//
// The "Auto" swatch resets by deleting the account_colors row entirely (see
// lib/accounts.js's setAccountColor) rather than storing a sentinel value —
// CardChip's existing hash-based cardHue() is simply what renders the moment
// there's no override row for this key, so "Auto" is really just "no
// override", not a distinct third state to track.
export function CardColorPicker({ accountKey, className = '' }) {
  const { state, update } = useApp()
  const t = useT()
  const current = colorForAccount(state, accountKey)

  return (
    <div className={cn('flex flex-wrap items-center justify-center gap-2', className)}>
      <button
        type="button"
        onClick={() => setAccountColor(update, accountKey, null)}
        aria-label={t('Reset to automatic color')}
        title={t('Auto')}
        className={cn(
          'flex h-7 w-7 shrink-0 items-center justify-center rounded-full border-2 bg-secondary/60 text-muted-foreground transition',
          current == null ? 'border-primary' : 'border-transparent hover:border-border'
        )}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
      {CARD_COLOR_PRESETS.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => setAccountColor(update, accountKey, p.hue)}
          aria-label={p.label}
          title={p.label}
          className={cn(
            'h-7 w-7 shrink-0 rounded-full border-2 shadow-sm transition',
            current === p.hue ? 'border-primary' : 'border-transparent hover:border-border/70'
          )}
          style={{ background: cardGradient(p.hue) }}
        />
      ))}
    </div>
  )
}

// Placeholder shown wherever a freshly-connected Plaid account's
// transactions aren't fully backfilled yet (item status === 'syncing' — see
// lib/plaid-sync.js and the webhook route's HISTORICAL_UPDATE/
// SYNC_UPDATES_AVAILABLE handling). Shared by AccountDetail.jsx's inline
// transaction list and Transactions.jsx's ?account= filtered view, so a
// syncing account never flashes an empty/partial list before flipping over
// to real data once lib/accounts.js's usePlaidItems() polling clears the flag.
export function TransactionsSkeleton() {
  return (
    <div className="space-y-3">
      <div className="divide-y divide-border/60 overflow-hidden rounded-xl border">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex animate-pulse items-center gap-3 px-4 py-3">
            <span className="h-6 w-6 shrink-0 rounded-full bg-secondary/70" />
            <span className="h-3 min-w-0 flex-1 rounded-full bg-secondary/70" />
            <span className="h-3 w-16 shrink-0 rounded-full bg-secondary/70" />
          </div>
        ))}
      </div>
      <p className="px-2 text-center text-[0.78125rem] text-muted-foreground">
        Hang tight — we're pulling in your transactions. This usually takes a minute or two.
      </p>
    </div>
  )
}

// Subtle pulsing block standing in for a chart while its underlying data
// isn't ready yet (same 'syncing' state as TransactionsSkeleton above) — same
// footprint as the real chart via `className` so nothing jumps on swap.
export function ChartSkeleton({ className = 'h-40 w-full' }) {
  return <div className={cn('animate-pulse rounded-xl bg-secondary/40', className)} />
}

// Tiny "still loading" pill for views/Accounts.jsx list rows belonging to a
// syncing item — sits next to SourceBadge so a freshly-connected account
// reads as "still working", not broken/empty.
export function SyncingPill() {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/25 bg-amber-400/10 px-1.5 py-0.5 text-[0.5625rem] font-bold uppercase tracking-wide text-amber-300">
      <Loader2 className="h-2.5 w-2.5 animate-spin" />
      Syncing…
    </span>
  )
}

// SVG circular progress ring (Copilot budget rings). pct > 100 renders a full ring.
export function Ring({ pct, color, size = 64, stroke = 5, children }) {
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r
  const p = Math.min(100, Math.max(0, pct))
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--secondary))" strokeWidth={stroke} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeLinecap="round" strokeDasharray={`${(c * p) / 100} ${c}`} className="transition-all duration-500"
        />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center">{children}</div>
    </div>
  )
}

// Copilot budget status color: green on pace, amber near the limit, red over.
// Muted shades on purpose — the saturated versions glowed too hard on the navy background.
export function budgetTone(spent, limit) {
  if (!limit) return '#5b9df9'
  if (spent > limit) return '#c25352'
  const p = spent / limit
  if (p >= 0.9) return '#c98a3d'
  if (p >= 0.66) return '#c2a24a'
  return '#3d9970'
}

// `href` is opt-in — without it this is the exact same card as before (Debts/Admin
// use it unlinked). With it, the whole tile becomes a nav target to match Dashboard's
// clickable-card pass, with a chevron next to the label as the affordance.
export function Kpi({ label, value, tone = 'text-foreground', icon: Icon, sub, href }) {
  const tint = tone.includes('red') ? '#f4514c' : tone.includes('amber') ? '#fbbf24' : tone.includes('emerald') ? '#2fbf71' : '#5b9df9'
  const inner = (
    <>
      <div className="mb-2 flex items-start justify-between gap-2">
        <span className="flex min-w-0 items-start gap-1 text-[0.625rem] font-bold uppercase leading-tight tracking-tight text-muted-foreground sm:text-[0.65625rem] sm:tracking-wider">
          <span className="min-w-0 break-words">{label}</span>
          {href ? <ChevronRight className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground/50 transition group-hover:translate-x-0.5 group-hover:text-primary" /> : null}
        </span>
        {Icon ? <Icon className="h-4 w-4 shrink-0" style={{ color: tint + '99' }} /> : null}
      </div>
      <div className={`text-xl font-extrabold tracking-tight sm:text-2xl ${tone}`}>{value}</div>
      {sub ? <div className="mt-1 text-[0.6875rem] font-semibold text-muted-foreground">{sub}</div> : null}
    </>
  )
  if (href) {
    return (
      <Link href={href} className="group block">
        <Card className="cursor-pointer p-4 transition hover:border-primary/40 hover:bg-secondary/[0.12] sm:p-5">{inner}</Card>
      </Link>
    )
  }
  return <Card className="p-4 sm:p-5">{inner}</Card>
}

export function StatTile({ label, value, sub, tone = '', highlight = false }) {
  return (
    <div className={`rounded-xl border p-3.5 ${highlight ? 'border-primary/25 bg-primary/[0.07]' : 'bg-secondary/40'}`}>
      <div className="mb-1 text-[0.65625rem] font-bold uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-extrabold tracking-tight ${tone}`}>{value}</div>
      {sub ? <div className="text-[0.6875rem] font-semibold text-muted-foreground">{sub}</div> : null}
    </div>
  )
}

// `thin` is opt-in (used by the Dashboard credit-card chips for a slimmer utilization
// bar) — default track height is unchanged for every other caller.
export function Bar({ pct, color, thin = false }) {
  return (
    <div className={thin ? 'track !h-[0.28rem]' : 'track'}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  )
}

// Generic destructive confirm dialog — Accounts.jsx (delete manual account),
// AccountDetail.jsx (delete account/debt, disconnect bank), and Settings.jsx
// (erase all data) share this exact Cancel/Delete markup instead of each
// defining their own. `busy` swaps the confirm button's icon for a spinner
// and disables both buttons (and the backdrop/Esc close) while the caller's
// async work — or, for synchronous store mutations, a deliberate brief delay
// so the spinner is actually visible — is in flight.
export function ConfirmDialog({ title, desc, confirmLabel = 'Delete', busy = false, onConfirm, onClose }) {
  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        {desc ? <p className="text-[0.8125rem] text-muted-foreground">{desc}</p> : null}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="animate-spin" /> : null}{confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MoneyTile({ label, hint, value, tone, active, onClick }) {
  const isNeg = tone === 'red'
  const base = isNeg ? 'border-red-400/15 bg-red-400/[0.05] hover:bg-red-400/[0.09]' : 'border-emerald-400/15 bg-emerald-400/[0.06] hover:bg-emerald-400/[0.1]'
  const activeCls = isNeg ? 'border-red-400/60' : 'border-emerald-400/60'
  return (
    <button
      onClick={onClick}
      className={`min-w-0 rounded-xl border px-2 py-3 text-center transition sm:p-4 ${base} ${active ? activeCls : ''} ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      {/* Fixed-height label + always-rendered hint zones keep the three
          tiles' amounts and bottoms aligned even when one label wraps to
          two lines or a tile has no hint. */}
      <div className="mb-1 flex min-h-[1.75rem] items-end justify-center text-[0.625rem] font-bold uppercase leading-tight tracking-wider text-muted-foreground sm:min-h-[1rem] sm:text-[0.6875rem]">{label}</div>
      <div className={`text-base font-extrabold tracking-tight sm:text-xl md:text-2xl ${isNeg ? 'text-red-400' : 'text-emerald-400'}`}>{value}</div>
      <div className={`mt-1 min-h-[0.875rem] text-[0.625rem] font-semibold ${active ? (isNeg ? 'text-red-300' : 'text-emerald-300') : 'text-muted-foreground'}`}>{hint || ' '}</div>
    </button>
  )
}
