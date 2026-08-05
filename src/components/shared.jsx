'use client'
import Link from 'next/link'
import { Home, Car, ShoppingBag, Utensils, ShoppingCart, Package, Users, Banknote, Wifi, Baby, Clapperboard, Tv, Wrench, Scissors, CreditCard, TrendingUp, Repeat, ChevronRight, LayoutGrid, List } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { catColor, fmt0 } from '@/lib/utils'
import { useApp } from '@/store'

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
  return (
    <div className="flex items-center gap-0.5 rounded-md border p-0.5">
      <button title="Card view" onClick={() => onChange('cards')} className={`rounded px-1.5 py-1 transition ${value === 'cards' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}><LayoutGrid className="h-3.5 w-3.5" /></button>
      <button title="List view" onClick={() => onChange('list')} className={`rounded px-1.5 py-1 transition ${value === 'list' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}><List className="h-3.5 w-3.5" /></button>
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

export function SectionHead({ title, desc }) {
  return (
    <div>
      {title ? <h3 className="text-[0.84375rem] font-bold tracking-tight">{title}</h3> : null}
      {desc ? <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p> : null}
    </div>
  )
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

export function Kpi({ label, value, tone = 'text-foreground', icon: Icon, sub }) {
  const tint = tone.includes('red') ? '#f4514c' : tone.includes('amber') ? '#fbbf24' : tone.includes('emerald') ? '#2fbf71' : '#5b9df9'
  return (
    <Card className="p-4 sm:p-5">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-bold text-muted-foreground">{label}</span>
        {Icon ? <Icon className="h-4 w-4" style={{ color: tint + '99' }} /> : null}
      </div>
      <div className={`text-xl font-extrabold tracking-tight sm:text-2xl ${tone}`}>{value}</div>
      {sub ? <div className="mt-1 text-[0.6875rem] font-semibold text-muted-foreground">{sub}</div> : null}
    </Card>
  )
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

export function Bar({ pct, color }) {
  return (
    <div className="track">
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%`, background: color }} />
    </div>
  )
}

export function MoneyTile({ label, hint, value, tone, active, onClick }) {
  const isNeg = tone === 'red'
  const base = isNeg ? 'border-red-400/15 bg-red-400/[0.05] hover:bg-red-400/[0.09]' : 'border-emerald-400/15 bg-emerald-400/[0.06] hover:bg-emerald-400/[0.1]'
  const activeCls = isNeg ? 'border-red-400/60' : 'border-emerald-400/60'
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-2 py-3 text-center transition sm:p-4 ${base} ${active ? activeCls : ''} ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      <div className="mb-1 text-[0.625rem] font-bold uppercase tracking-wider text-muted-foreground sm:text-[0.6875rem]">{label}</div>
      <div className={`whitespace-nowrap text-base font-extrabold tracking-tight sm:text-xl md:text-2xl ${isNeg ? 'text-red-400' : 'text-emerald-400'}`}>{value}</div>
      {hint ? <div className={`mt-1 text-[0.625rem] font-semibold ${active ? (isNeg ? 'text-red-300' : 'text-emerald-300') : 'text-muted-foreground'}`}>{hint}</div> : null}
    </button>
  )
}
