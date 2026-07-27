'use client'
import { cn } from '@/lib/utils'

// shadcn Tabs-style segmented control for inline mode pickers.
export function Segmented({ options, value, onChange, className }) {
  return (
    <div className={cn('inline-flex flex-wrap items-center gap-0.5 rounded-lg bg-secondary/70 border p-1', className)}>
      {options.map(([v, label]) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          className={cn(
            'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors',
            value === v ? 'bg-accent text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
          )}
        >
          {label}
        </button>
      ))}
    </div>
  )
}
