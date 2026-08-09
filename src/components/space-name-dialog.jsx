'use client'
import { useRef, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { useT } from '@/lib/i18n'

export function SpaceNameDialog({ title, label, initial = '', placeholder, onSave, onClose }) {
  const t = useT()
  const [name, setName] = useState(initial)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef(null)

  const save = async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    setSaving(true)
    await onSave(trimmed)
    setSaving(false)
    onClose()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div>
          {label && <Label>{label}</Label>}
          <Input
            ref={inputRef}
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button disabled={saving || !name.trim()} onClick={save}>{t('Save')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Settings → Shared spaces → "Convert my personal space into a shared
// space." One dialog that both names the new space AND kicks off the
// create-then-move sequence — `busy` stays true across both steps (create
// the space, then transferPersonalDataToSpace into it), so unlike
// SpaceNameDialog above this can't just self-manage its own `saving` state;
// the caller (Settings.jsx) owns `busy` since it also owns the multi-step
// async flow and needs to know when to close/toast.
export function ConvertToSharedSpaceDialog({ initial = '', placeholder, desc, busy = false, onSave, onClose }) {
  const t = useT()
  const [name, setName] = useState(initial)

  const save = () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    onSave(trimmed)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('Convert to a shared space')}</DialogTitle></DialogHeader>
        {desc ? <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">{desc}</p> : null}
        <div>
          <Label>{t('Space name')}</Label>
          <Input
            autoFocus
            value={name}
            disabled={busy}
            onChange={(e) => setName(e.target.value)}
            placeholder={placeholder}
            onKeyDown={(e) => { if (e.key === 'Enter') save() }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
          <Button disabled={busy || !name.trim()} onClick={save}>
            {busy ? <Loader2 className="animate-spin" /> : null}{t('Create & Move')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RemoveMemberDialog({ name, spaceName, onConfirm, onClose }) {
  const t = useT()
  const [removing, setRemoving] = useState(false)

  const confirm = async () => {
    setRemoving(true)
    await onConfirm()
    setRemoving(false)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('Remove {name} from {space}?', { name, space: spaceName })}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t('They lose access immediately. Their own personal data is not affected.')}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="destructive" disabled={removing} onClick={confirm}>{t('Remove')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// Settings → Shared spaces → owner-only "Delete space." More destructive
// than RemoveMemberDialog above or Settings' "Erase all data" (Danger
// zone) — it wipes the entire space for every member, not just the
// caller's own data — so unlike shared.jsx's generic ConfirmDialog this
// requires typing the space's exact name before the button enables, the
// same "type to confirm" bar this app's other truly irreversible,
// multi-person action (deleting a space) should clear.
export function DeleteSpaceDialog({ space, busy = false, onConfirm, onClose }) {
  const t = useT()
  const [text, setText] = useState('')
  const match = text.trim() === space.name

  const confirm = () => {
    if (!match || busy) return
    onConfirm()
  }

  return (
    <Dialog open onOpenChange={(o) => !o && !busy && onClose()}>
      <DialogContent className="max-w-sm">
        <DialogHeader><DialogTitle>{t('Delete "{name}"?', { name: space.name })}</DialogTitle></DialogHeader>
        <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
          {t('This permanently deletes "{name}" for every member — all its accounts, debts, budgets, goals, recurring bills, transactions, payment history, and connected banks. This can\'t be undone.', { name: space.name })}
        </p>
        <div>
          <Label>{t('Type {name} to confirm', { name: space.name })}</Label>
          <Input
            autoFocus
            value={text}
            disabled={busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="destructive" disabled={busy || !match} onClick={confirm}>
            {busy ? <Loader2 className="animate-spin" /> : null}{t('Delete space')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InviteLinkDialog({ url, onClose }) {
  const t = useT()
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url)
    } catch {
      // clipboard may be unavailable; the URL is still visible to copy manually
    }
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>{t('Invite link')}</DialogTitle></DialogHeader>
        <div>
          <Label>{t('Share this link with your partner. It works for 7 days.')}</Label>
          <Input readOnly value={url} onFocus={(e) => e.target.select()} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t('Close')}</Button>
          <Button onClick={copy}>{t('Copy')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
