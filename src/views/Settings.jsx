'use client'
import { useEffect, useState } from 'react'
import { useUser, useClerk } from '@clerk/nextjs'
import { Eye, Pencil, Plus, Link2, Users, ChevronRight, Loader2, UserMinus, Landmark, RefreshCw } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Segmented } from '@/components/ui/segmented'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { SectionLabel } from '@/components/shared'
import { OCCUPATIONS } from '@/components/onboarding'
import { useApp } from '@/store'
import { useToast } from '@/components/toast'
import { prettyDate } from '@/lib/utils'
import { SpaceNameDialog, InviteLinkDialog, RemoveMemberDialog } from '@/components/space-name-dialog'
import { ConnectBankButton } from '@/components/connect-bank'

export default function Settings() {
  const { viewingAs } = useApp()

  return (
    <div className="fade-in space-y-6">
      {viewingAs ? (
        <Card className="flex items-center gap-2 p-5 text-[0.8125rem] text-muted-foreground">
          <Eye className="h-4 w-4 shrink-0" />
          Settings aren't available while viewing another customer's account.
        </Card>
      ) : (
        <>
          <ProfileSection />
          <AccountSection />
          <ConnectedBanksSection />
          <SharedSpacesSection />
        </>
      )}
      <p className="pt-2 text-center text-[0.6875rem] text-muted-foreground">SteerMoney</p>
    </div>
  )
}

function ProfileSection() {
  const { user } = useUser()
  const toast = useToast()
  const [lang, setLang] = useState(user?.unsafeMetadata?.lang === 'es' ? 'es' : 'en')
  const [f, setF] = useState({
    firstName: user?.firstName || '',
    lastName: user?.lastName || '',
    dob: user?.unsafeMetadata?.dob || '',
    occupation: user?.unsafeMetadata?.occupation || '',
  })
  const [saving, setSaving] = useState(false)
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })

  const save = async () => {
    if (!f.firstName.trim()) return toast('Please enter your first name', 'error')
    setSaving(true)
    const metadata = { ...user.unsafeMetadata, lang, dob: f.dob || null, occupation: f.occupation || null }
    try {
      await user.update({ firstName: f.firstName.trim(), lastName: f.lastName.trim(), unsafeMetadata: metadata })
      toast('Profile saved')
    } catch {
      // name updates can be restricted by Clerk settings; keep the metadata at least
      try {
        await user.update({ unsafeMetadata: metadata })
        toast('Profile saved')
      } catch {
        toast("Couldn't save your profile", 'error')
      }
    }
    setSaving(false)
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title="Profile" />
      <Card className="space-y-3 p-5">
        <div>
          <Label>Language</Label>
          <Segmented value={lang} onChange={setLang} options={[['en', 'English'], ['es', 'Español']]} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>First name</Label><Input value={f.firstName} onChange={set('firstName')} /></div>
          <div><Label>Last name</Label><Input value={f.lastName} onChange={set('lastName')} /></div>
        </div>
        <div><Label>Date of birth</Label><Input type="date" value={f.dob} onChange={set('dob')} /></div>
        <div>
          <Label>What do you do for work?</Label>
          <Select className="w-full" value={f.occupation} onChange={set('occupation')}>
            <option value="">Choose one…</option>
            {OCCUPATIONS.map(([id, en, es]) => <option key={id} value={id}>{lang === 'es' ? es : en}</option>)}
          </Select>
        </div>
        <div className="flex justify-end">
          <Button disabled={saving} onClick={save}>Save</Button>
        </div>
      </Card>
    </div>
  )
}

function AccountSection() {
  const { user } = useUser()
  const { signOut, openUserProfile } = useClerk()

  return (
    <div className="space-y-2.5">
      <SectionLabel title="Account" />
      <Card className="space-y-3 p-5">
        <div>
          <div className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">Signed in as</div>
          <div className="text-[0.84375rem] font-semibold">{user?.primaryEmailAddress?.emailAddress}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => openUserProfile()}>Manage account</Button>
          <Button variant="destructive" onClick={() => signOut({ redirectUrl: '/sign-in' })}>Sign out</Button>
        </div>
      </Card>
    </div>
  )
}

function ConnectedBanksSection() {
  const toast = useToast()
  const [items, setItems] = useState(null) // null = loading
  const [syncing, setSyncing] = useState(false)
  const [removing, setRemoving] = useState(null)

  const loadItems = async () => {
    try {
      const res = await fetch('/api/plaid/items')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Couldn't load connections")
      setItems(data.items || [])
    } catch (e) {
      toast(e.message, 'error')
      setItems([])
    }
  }

  useEffect(() => { loadItems() }, [])

  const sync = async () => {
    setSyncing(true)
    try {
      const res = await fetch('/api/plaid/sync', { method: 'POST' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Sync failed')
      toast(`Synced: ${data.added} new transactions`)
      setTimeout(() => window.location.reload(), 1200)
    } catch (e) {
      toast(e.message, 'error')
      setSyncing(false)
    }
  }

  const confirmRemove = async () => {
    try {
      const res = await fetch('/api/plaid/items', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: removing.item_id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Couldn't remove that connection")
      toast('Bank disconnected')
      await loadItems()
    } catch (e) {
      toast(e.message, 'error')
    }
    setRemoving(null)
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title="Connected banks" />
      <Card className="space-y-4 p-5">
        <p className="text-[0.78125rem] leading-relaxed text-muted-foreground">
          Connect a bank and SteerMoney pulls transactions in automatically. Connections are private to your personal data.
        </p>

        {items === null ? (
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading connections…
          </div>
        ) : items.length > 0 ? (
          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
            {items.map((it) => (
              <div key={it.id} className="flex flex-wrap items-center gap-2.5 px-3 py-2.5">
                <Landmark className="h-4 w-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.8125rem] font-semibold">{it.institution || 'Bank'}</div>
                  <div className="truncate text-[0.6875rem] text-muted-foreground">
                    {(it.accounts || []).map((a) => a.name + (a.mask ? ' ••' + a.mask : '')).join(', ') || 'No accounts found'}
                  </div>
                  <div className="text-[0.6875rem] text-muted-foreground">
                    {it.last_synced ? `Last synced ${prettyDate(it.last_synced.slice(0, 10))}` : 'Not yet synced'}
                  </div>
                </div>
                <Button variant="outline" size="xs" disabled={syncing} onClick={sync}>
                  {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}Sync now
                </Button>
                <Button variant="destructive" size="xs" onClick={() => setRemoving(it)}>Remove</Button>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-1 text-xs text-muted-foreground">No banks connected yet.</p>
        )}

        <div className="flex justify-end">
          <ConnectBankButton size="sm" onDone={async () => { await loadItems(); setTimeout(() => window.location.reload(), 1200) }} />
        </div>
      </Card>
      {removing && (
        <RemoveBankDialog
          institution={removing.institution || 'this bank'}
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  )
}

function RemoveBankDialog({ institution, onConfirm, onClose }) {
  const [removing, setRemoving] = useState(false)

  const confirm = async () => {
    setRemoving(true)
    await onConfirm()
    setRemoving(false)
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader><DialogTitle>Remove {institution}?</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          SteerMoney stops pulling new transactions from this bank. Transactions already imported stay in your account.
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="destructive" disabled={removing} onClick={confirm}>Remove</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SharedSpacesSection() {
  const { user } = useUser()
  const { spaces, createSpace, createInvite, renameSpace, fetchMembers, removeMember } = useApp()
  const toast = useToast()
  const [showNewSpace, setShowNewSpace] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [inviteUrl, setInviteUrl] = useState(null)
  const [expanded, setExpanded] = useState(null) // id of the space whose members are shown
  const [membersBySpace, setMembersBySpace] = useState({}) // id -> 'loading' | array
  const [removing, setRemoving] = useState(null) // { space, member }

  const saveNewSpace = async (name) => {
    const r = await createSpace(name)
    if (r.error) toast("Couldn't create the space: " + r.error, 'error')
    else toast(`"${name}" created. Copy the invite link to share it.`)
  }

  const saveRename = async (name) => {
    if (name === renaming.name) return
    const r = await renameSpace(renaming.id, name)
    if (r.error) toast("Couldn't rename the space: " + r.error, 'error')
    else toast('Space renamed')
  }

  const copyInvite = async (sp) => {
    const r = await createInvite(sp)
    if (r.error) return toast(r.error, 'error')
    try {
      await navigator.clipboard.writeText(r.url)
      toast('Invite link copied. It works for 7 days.')
    } catch {
      setInviteUrl(r.url)
    }
  }

  const loadMembers = async (spaceId) => {
    setMembersBySpace((m) => ({ ...m, [spaceId]: 'loading' }))
    const r = await fetchMembers(spaceId)
    if (r.error) { toast("Couldn't load members: " + r.error, 'error'); setMembersBySpace((m) => ({ ...m, [spaceId]: [] })) }
    else setMembersBySpace((m) => ({ ...m, [spaceId]: r.members }))
  }

  const toggleExpand = (sp) => {
    if (expanded === sp.id) { setExpanded(null); return }
    setExpanded(sp.id)
    if (!membersBySpace[sp.id]) loadMembers(sp.id)
  }

  const confirmRemove = async () => {
    const { space: sp, member } = removing
    const label = member.name || 'Member'
    const r = await removeMember(sp.id, member.user_id)
    if (r.error) toast(`Couldn't remove ${label}: ` + r.error, 'error')
    else { toast(`${label} removed`); loadMembers(sp.id) }
    setRemoving(null)
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title="Shared spaces" />
      <Card className="space-y-4 p-5">
        <p className="text-[0.78125rem] leading-relaxed text-muted-foreground">
          1. Create a shared space. 2. Copy the invite link and send it to your partner. 3. They open the link, create an account, and the space shows up for both of you. Use the switcher in the header to flip between Personal and the shared space. The person who created a space owns it and can remove members.
        </p>

        {spaces.length > 0 && (
          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
            {spaces.map((sp) => {
              const isOwner = sp.ownerId === user?.id
              const members = membersBySpace[sp.id]
              return (
                <div key={sp.id}>
                  <button
                    type="button"
                    className="flex w-full flex-wrap items-center gap-2 px-3 py-2.5 text-left transition hover:bg-secondary/30"
                    onClick={() => toggleExpand(sp)}
                  >
                    <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded === sp.id ? 'rotate-90' : ''}`} />
                    <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">{sp.name}</div>
                    {isOwner ? (
                      <span
                        role="button"
                        title="Rename space"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-accent [&_svg]:h-3.5 [&_svg]:w-3.5"
                        onClick={(e) => { e.stopPropagation(); setRenaming(sp) }}
                      >
                        <Pencil />
                      </span>
                    ) : null}
                    <span
                      role="button"
                      title="Copy an invite link for this shared space"
                      className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-xs font-medium shadow-sm transition-colors hover:bg-accent [&_svg]:h-3.5 [&_svg]:w-3.5"
                      onClick={(e) => { e.stopPropagation(); copyInvite(sp) }}
                    >
                      <Link2 />Copy invite link
                    </span>
                  </button>

                  {expanded === sp.id && (
                    <div className="fade-in space-y-2.5 border-t border-border/60 bg-secondary/20 px-3 py-3">
                      {members === 'loading' ? (
                        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />Loading members…
                        </div>
                      ) : (members || []).length === 0 ? (
                        <p className="py-1 text-xs text-muted-foreground">No members found.</p>
                      ) : (
                        members.map((m) => (
                          <div key={m.user_id} className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[0.6875rem] font-bold">
                              {(m.name || 'M').slice(0, 1).toUpperCase()}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[0.8125rem] font-medium">{m.name || 'Member'}</span>
                                {m.user_id === sp.ownerId && <Badge variant="info">Owner</Badge>}
                              </div>
                              <div className="truncate text-[0.6875rem] text-muted-foreground">{m.email || ''}</div>
                            </div>
                            {isOwner && m.user_id !== sp.ownerId && (
                              <Button variant="outline" size="xs" onClick={() => setRemoving({ space: sp, member: m })}>
                                <UserMinus />Remove
                              </Button>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}

        <div className="flex justify-end">
          <Button size="sm" onClick={() => setShowNewSpace(true)}><Plus />New shared space</Button>
        </div>
      </Card>
      {showNewSpace && (
        <SpaceNameDialog
          title="New shared space"
          placeholder="Our finances"
          onSave={saveNewSpace}
          onClose={() => setShowNewSpace(false)}
        />
      )}
      {renaming && (
        <SpaceNameDialog
          title="Rename space"
          initial={renaming.name}
          onSave={saveRename}
          onClose={() => setRenaming(null)}
        />
      )}
      {inviteUrl && <InviteLinkDialog url={inviteUrl} onClose={() => setInviteUrl(null)} />}
      {removing && (
        <RemoveMemberDialog
          name={removing.member.name || 'Member'}
          spaceName={removing.space.name}
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  )
}
