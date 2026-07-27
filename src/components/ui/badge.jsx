'use client'
import { cva } from 'class-variance-authority'
import { cn } from '@/lib/utils'

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] font-medium transition-colors whitespace-nowrap',
  {
    variants: {
      variant: {
        default: 'border-border bg-secondary/60 text-muted-foreground',
        success: 'border-emerald-400/25 bg-emerald-400/10 text-emerald-400',
        destructive: 'border-red-400/25 bg-red-400/10 text-red-400',
        warning: 'border-amber-400/25 bg-amber-400/10 text-amber-400',
        info: 'border-indigo-400/25 bg-indigo-400/10 text-indigo-300',
      },
    },
    defaultVariants: { variant: 'default' },
  }
)

function Badge({ className, variant, ...props }) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
