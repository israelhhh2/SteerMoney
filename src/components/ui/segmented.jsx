'use client'
import { cn } from '@/lib/utils'

// Copilot-style pill tabs for inline mode pickers.
// `scroll` is opt-in: renders as a single horizontally-scrollable no-wrap row instead
// of wrapping to multiple lines (used by the Dashboard's Cash Flow range picker so it
// doesn't wrap awkwardly at 390px). Existing callers keep the default wrap behavior.
// Every button stops propagation so pills nested inside a whole-card <Link> never
// trigger navigation.
export function Segmented({ options, value, onChange, className, scroll = false }) {
  return (
    <div
      className={cn(
        scroll ? 'no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto' : 'inline-flex flex-wrap items-center gap-1',
        className
      )}
    >
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={(e) => { e.stopPropagation(); onChange(v) }}
          className={cn(
            'shrink-0 rounded-full px-3 py-1 text-xs font-bold transition-colors',
            value === v ? 'bg-secondary text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
