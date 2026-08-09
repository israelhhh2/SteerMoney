'use client'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { forwardRef } from 'react'
import { cn } from '@/lib/utils'

const Dialog = DialogPrimitive.Root
const DialogTrigger = DialogPrimitive.Trigger
const DialogClose = DialogPrimitive.Close

// z-index: this Portal renders straight into document.body as a sibling of
// everything else fixed-positioned in the app (the @modal intercepting-route
// overlay at z-[60], the toast provider's corner toasts at z-[60]) — so its
// z-index has to be compared globally, not just against its own children.
// Bumped from z-50 → z-[65]/z-[70] (2026-08-08) because a ConfirmDialog
// opened from inside the account detail modal (components/shared.jsx →
// this file, used by views/AccountDetail.jsx) was rendering *underneath*
// the @modal overlay's opaque z-[60] backdrop — Radix reported
// data-state=open/opacity:1 in the DOM, but the modal's backdrop painted
// over it, so the page looked frozen (clicks still hit the invisible
// button). See CLAUDE.md session log for the full z-index ladder.
// `variant="sheet"` (additive, 2026-08-08) turns this same Content into a
// mobile bottom sheet — anchored to the bottom edge, full width, rounded top
// corners, a drag-handle affordance, slides up on open, and pads for
// env(safe-area-inset-bottom) instead of centering like every other dialog
// in the app. Every existing caller is untouched (variant defaults to the
// original centered-modal look). Radix's Dialog.Content already body-scroll
// locks and handles Escape/backdrop-click/focus-trap for both variants, so
// none of that is reimplemented here. Used by views/Transactions.jsx's
// mobile transaction detail sheet.
const DialogContent = forwardRef(({ className, children, variant = 'center', ...props }, ref) => (
  <DialogPrimitive.Portal>
    <DialogPrimitive.Overlay className="fixed inset-0 z-[65] bg-black/70 backdrop-blur-[2px] data-[state=open]:fade-in" />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        variant === 'sheet'
          ? 'fixed inset-x-0 bottom-0 z-[70] grid w-full gap-3 border-t bg-card p-5 pt-2.5 shadow-2xl rounded-t-2xl max-h-[85vh] overflow-y-auto sheet-in'
          : 'fixed left-1/2 top-1/2 z-[70] grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-card p-6 shadow-2xl rounded-xl max-h-[85vh] overflow-y-auto fade-in',
        className
      )}
      style={variant === 'sheet' ? { paddingBottom: 'calc(1.25rem + env(safe-area-inset-bottom))' } : undefined}
      {...props}
    >
      {variant === 'sheet' && <div aria-hidden="true" className="mx-auto -mt-1 mb-0.5 h-1.5 w-10 shrink-0 rounded-full bg-border" />}
      {children}
      <DialogPrimitive.Close className="absolute right-4 top-4 rounded-sm text-muted-foreground opacity-70 transition-opacity hover:opacity-100 focus:outline-none">
        <X className="h-4 w-4" />
      </DialogPrimitive.Close>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
))
DialogContent.displayName = 'DialogContent'

const DialogHeader = ({ className, ...props }) => (
  <div className={cn('flex flex-col space-y-1.5 text-left', className)} {...props} />
)
const DialogTitle = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Title ref={ref} className={cn('text-base font-semibold tracking-tight', className)} {...props} />
))
DialogTitle.displayName = 'DialogTitle'
const DialogDescription = forwardRef(({ className, ...props }, ref) => (
  <DialogPrimitive.Description ref={ref} className={cn('text-xs text-muted-foreground', className)} {...props} />
))
DialogDescription.displayName = 'DialogDescription'
const DialogFooter = ({ className, ...props }) => (
  <div className={cn('flex flex-row justify-end gap-2', className)} {...props} />
)

export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter }
