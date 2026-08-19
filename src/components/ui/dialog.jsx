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
// Bottom-right-then-snap-to-center bug (the centered variant only): the
// element needs a *static* `transform: translate(-50%, -50%)` to center
// itself (it's `fixed left-1/2 top-1/2`, so without that compensating
// translate its top-left corner — not its center — sits at the viewport's
// midpoint, i.e. it renders toward the bottom-right of true center). The
// shared `.fade-in` utility (globals.css) was doing the open animation, but
// its `@keyframes fadeIn` *also* animates `transform` (`translateY(3px)` →
// `none`) — a CSS animation's transform keyframes fully replace an
// element's transform for the animation's duration, they don't compose
// with a separate static transform utility. So for the ~250ms `fade-in`
// ran, this dialog had NO centering translate at all (rendering off toward
// the bottom-right), then the instant the animation ended, the static
// `-translate-x-1/2 -translate-y-1/2` utility classes took back over and it
// snapped to center. Fix: give the centered variant its own keyframes that
// bake the centering translate into every frame (see the inline <style>
// below) instead of reusing `.fade-in` — scoped here rather than editing
// globals.css since `sheet`'s own `.sheet-in` keyframes have no competing
// static transform (it's positioned via `inset-x-0 bottom-0`, not
// translate) and is unaffected either way.
// onOpenAutoFocus: prevented app-wide, on every dialog, by design — Radix's
// default behavior on mount is to auto-focus the first focusable descendant
// (almost always the first text <Input> in one of our forms), which on
// mobile Safari/Chrome instantly pops the on-screen keyboard the moment a
// dialog opens (reported from /recurring: "when I click to edit anything
// don't automatically open keyboard, it's annoying and messes up the ui
// zoom" — an edit dialog opening isn't the same as the user tapping into a
// field, so it shouldn't behave like one). Prevented here once, at the
// source, rather than adding `onOpenAutoFocus={(e) => e.preventDefault()}`
// to every call site — fixes RecurringDialog, TxDialog, SpaceNameDialog,
// ConvertToSharedSpaceDialog, DeleteSpaceDialog, and everything else built
// on this component in one place. Focus still lands inside the dialog (Radix
// falls back to the Content container itself), so Escape/Tab and the
// existing focus trap keep working — only the automatic jump into a text
// field is skipped. The keyboard still opens the instant the user taps a
// field themselves, same as always.
const DialogContent = forwardRef(({ className, children, variant = 'center', ...props }, ref) => (
  <DialogPrimitive.Portal>
    {variant !== 'sheet' && (
      <style>{'@keyframes dialogCenterIn{from{opacity:0;transform:translate(-50%,-50%) translateY(3px)}to{opacity:1;transform:translate(-50%,-50%)}}'}</style>
    )}
    <DialogPrimitive.Overlay className="fixed inset-0 z-[65] bg-black/70 backdrop-blur-[2px] data-[state=open]:fade-in" />
    <DialogPrimitive.Content
      ref={ref}
      onOpenAutoFocus={(e) => e.preventDefault()}
      className={cn(
        variant === 'sheet'
          ? 'fixed inset-x-0 bottom-0 z-[70] grid w-full gap-3 border-t bg-card p-5 pt-2.5 shadow-2xl rounded-t-2xl max-h-[85vh] overflow-y-auto sheet-in'
          : 'fixed left-1/2 top-1/2 z-[70] grid w-full max-w-lg -translate-x-1/2 -translate-y-1/2 gap-4 border bg-card p-6 shadow-2xl rounded-xl max-h-[85vh] overflow-y-auto [animation:dialogCenterIn_0.25s_ease]',
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
