'use client'
import { useRef, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { Input, Label } from '@/components/ui/input'
import { Button } from '@/components/ui/button'

export function SpaceNameDialog({ title, label, initial = '', placeholder, onSave, onClose }) {
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
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button disabled={saving || !name.trim()} onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function RemoveMemberDialog({ name, spaceName, onConfirm, onClose }) {
  const [removing, setRemoving] = useState(false)

  const confirm = async () => {
    setRemoving(true)
    await onConfirm()
    setRemoving(false)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Remove {name} from {spaceName}?</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          They lose access immediately. Their own personal data is not affected.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={removing} onClick={confirm}>Remove</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function InviteLinkDialog({ url, onClose }) {
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
        <DialogHeader><DialogTitle>Invite link</DialogTitle></DialogHeader>
        <div>
          <Label>Share this link with your partner. It works for 7 days.</Label>
          <Input readOnly value={url} onFocus={(e) => e.target.select()} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Close</Button>
          <Button onClick={copy}>Copy</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
