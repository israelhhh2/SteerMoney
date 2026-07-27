'use client'
import { Home, Car, ShoppingBag, Utensils, ShoppingCart, Package, Users, Banknote, Wifi, Baby, Clapperboard, Tv, Wrench, Scissors, CreditCard, TrendingUp, Repeat } from 'lucide-react'
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
      className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${className}`}
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

export function SectionHead({ title, desc }) {
  return (
    <div>
      {title ? <h3 className="text-sm font-semibold tracking-tight">{title}</h3> : null}
      {desc ? <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p> : null}
    </div>
  )
}

export function Kpi({ label, value, tone = 'text-foreground', icon: Icon, sub }) {
  const tint = tone.includes('red') ? '#f87171' : tone.includes('amber') ? '#fbbf24' : tone.includes('emerald') ? '#34d399' : '#38bdf8'
  return (
    <Card className="p-4 sm:p-5" style={{ boxShadow: `inset 0 2px 0 ${tint}33` }}>
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
        {Icon ? <Icon className="h-4 w-4" style={{ color: tint + '99' }} /> : null}
      </div>
      <div className={`text-xl font-bold tracking-tight sm:text-2xl ${tone}`}>{value}</div>
      {sub ? <div className="mt-1 text-[11px] text-muted-foreground">{sub}</div> : null}
    </Card>
  )
}

export function StatTile({ label, value, sub, tone = '', highlight = false }) {
  return (
    <div className={`rounded-xl border p-3.5 ${highlight ? 'border-emerald-400/25 bg-emerald-400/[0.06]' : 'bg-secondary/40'}`}>
      <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={`text-base font-bold tracking-tight ${tone}`}>{value}</div>
      {sub ? <div className="text-[11px] text-muted-foreground">{sub}</div> : null}
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
      <div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground sm:text-[11px]">{label}</div>
      <div className={`whitespace-nowrap text-base font-bold tracking-tight sm:text-xl md:text-2xl ${isNeg ? 'text-red-400' : 'text-emerald-400'}`}>{value}</div>
      {hint ? <div className={`mt-1 text-[10px] ${active ? (isNeg ? 'text-red-300' : 'text-emerald-300') : 'text-muted-foreground'}`}>{hint}</div> : null}
    </button>
  )
}
