'use client'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

const Input = forwardRef(({ className, type, ...props }, ref) => (
  <input
    type={type}
    ref={ref}
    className={cn(
      'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 [color-scheme:dark]',
      className
    )}
    {...props}
  />
))
Input.displayName = 'Input'

const Label = ({ className, ...props }) => (
  <label className={cn('mb-1.5 block text-xs font-medium text-muted-foreground', className)} {...props} />
)

export { Input, Label }
