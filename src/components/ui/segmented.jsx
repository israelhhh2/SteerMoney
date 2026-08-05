'use client'
import { cn } from '@/lib/utils'

// Copilot-style pill tabs for inline mode pickers.
export function Segmented({ options, value, onChange, className }) {
  return (
    <div className={cn('inline-flex flex-wrap items-center gap-1', className)}>
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            'rounded-full px-3 py-1 text-xs font-bold transition-colors',
            value === v ? 'bg-secondary text-foreground ring-1 ring-border' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
