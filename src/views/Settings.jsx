'use client'
import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthUser, useSignOut } from '@/components/auth-provider'
import { Eye, Pencil, Plus, Link2, Users, ChevronRight, Loader2, UserMinus, Landmark, RefreshCw, AlertTriangle, Trash2, ArrowRightLeft } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Segmented } from '@/components/ui/segmented'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { SectionLabel, ConfirmDialog, SyncingPill } from '@/components/shared'
import { OCCUPATIONS } from '@/components/onboarding'
import { useApp } from '@/store'
import { useToast, useCenterToast } from '@/components/toast'
import { prettyDate } from '@/lib/utils'
import { SpaceNameDialog, InviteLinkDialog, RemoveMemberDialog, ConvertToSharedSpaceDialog, DeleteSpaceDialog } from '@/components/space-name-dialog'
import { ConnectBankButton, PlaidLinkRunner } from '@/components/connect-bank'
import { usePlaidItems } from '@/lib/accounts'
import { useT } from '@/lib/i18n'

export default function Settings() {
  const { viewingAs } = useApp()
  const t = useT()

  return (
    <div className="fade-in space-y-6">
      {viewingAs ? (
        <Card className="flex items-center gap-2 p-5 text-[0.8125rem] text-muted-foreground">
          <Eye className="h-4 w-4 shrink-0" />
          {t("Settings aren't available while viewing another customer's account.")}
        </Card>
      ) : (
        <>
          <ProfileSection />
          <AccountSection />
          <ConnectedBanksSection />
          <SharedSpacesSection />
          <DangerZoneSection />
        </>
      )}
      <p className="pt-2 text-center text-[0.6875rem] text-muted-foreground">SteerMoney</p>
    </div>
  )
}

function ProfileSection() {
  const { user } = useAuthUser()
  const toast = useToast()
  const t = useT()
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
    if (!f.firstName.trim()) return toast(t('Please enter your first name'), 'error')
    setSaving(true)
    const metadata = { ...user.unsafeMetadata, lang, dob: f.dob || null, occupation: f.occupation || null }
    try {
      await user.update({ firstName: f.firstName.trim(), lastName: f.lastName.trim(), unsafeMetadata: metadata })
      toast(t('Profile saved'))
    } catch {
      // name updates can fail independently of metadata updates; keep the metadata at least
      try {
        await user.update({ unsafeMetadata: metadata })
        toast(t('Profile saved'))
      } catch {
        toast(t("Couldn't save your profile"), 'error')
      }
    }
    setSaving(false)
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title={t('Profile')} />
      <Card className="space-y-3 p-5">
        <div>
          <Label>{t('Language / Idioma')}</Label>
          <Segmented value={lang} onChange={setLang} options={[['en', t('English')], ['es', t('Español')]]} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label>{t('First name')}</Label><Input value={f.firstName} onChange={set('firstName')} /></div>
          <div><Label>{t('Last name')}</Label><Input value={f.lastName} onChange={set('lastName')} /></div>
        </div>
        <div><Label>{t('Date of birth')}</Label><Input type="date" value={f.dob} onChange={set('dob')} /></div>
        <div>
          <Label>{t('What do you do for work?')}</Label>
          <Select className="w-full" value={f.occupation} onChange={set('occupation')}>
            <option value="">{t('Choose one…')}</option>
            {OCCUPATIONS.map(([id, en, es]) => <option key={id} value={id}>{lang === 'es' ? es : en}</option>)}
          </Select>
        </div>
        <div className="flex justify-end">
          <Button disabled={saving} onClick={save}>{t('Save')}</Button>
        </div>
      </Card>
    </div>
  )
}

// NOTE (Supabase Auth migration): Clerk's "Manage account" opened a
// Clerk-hosted profile modal (email/password/2FA management) with no
// Supabase Auth equivalent — Supabase Auth has no hosted account-management
// UI to link to. That button is dropped; name/language/etc. are already
// editable in ProfileSection above, on this same page. Email/password
// changes would need dedicated UI (out of scope for this sweep).
function AccountSection() {
  const { user } = useAuthUser()
  const signOut = useSignOut()
  const router = useRouter()
  const t = useT()

  const handleSignOut = async () => {
    await signOut()
    router.push('/sign-in')
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title={t('Account')} />
      <Card className="space-y-3 p-5">
        <div>
          <div className="text-[0.6875rem] font-bold uppercase tracking-wider text-muted-foreground">{t('Signed in as')}</div>
          <div className="text-[0.84375rem] font-semibold">{user?.email}</div>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="destructive" onClick={handleSignOut}>{t('Sign out')}</Button>
        </div>
      </Card>
    </div>
  )
}

function ConnectedBanksSection() {
  const toast = useToast()
  const t = useT()
  const { refetch } = useApp()
  const { refetchPlaidItems } = usePlaidItems()
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
      // itemErrors: some connections synced fine, one or more others hit an
      // error (reauth needed, Plaid outage, etc.) — surfaced instead of
      // silently dropped, see lib/plaid-sync.js's per-item isolation.
      if (data.itemErrors?.length) {
        toast(t('Synced {n} new transactions, but {count} connection{plural} failed ({banks}) — try Fix connection below', {
          n: data.added, count: data.itemErrors.length, plural: data.itemErrors.length > 1 ? 's' : '',
          banks: data.itemErrors.map((e) => e.institution || t('a bank')).join(', '),
        }), 'error')
      } else {
        toast(t('Synced: {n} new transactions', { n: data.added }))
      }
      // No page reload — refresh this section's own connection list, the
      // shared usePlaidItems() consumers (header "Updated" note, Accounts,
      // AccountDetail), and the store's debts/transactions/etc. so a synced
      // balance/transaction shows up in place.
      await loadItems()
      await refetchPlaidItems()
      refetch()
    } catch (e) {
      toast(e.message, 'error')
    } finally {
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
      toast(t('Bank disconnected'))
      await loadItems()
    } catch (e) {
      toast(e.message, 'error')
    }
    setRemoving(null)
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title={t('Connected banks')} />
      <Card className="space-y-4 p-5">
        <p className="text-[0.78125rem] leading-relaxed text-muted-foreground">
          {t('Connect a bank and SteerMoney pulls transactions in automatically. Connections are private to your personal data.')}
        </p>

        {items === null ? (
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />{t('Loading connections…')}
          </div>
        ) : items.length > 0 ? (
          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
            {items.map((it) => (
              <div key={it.id} className="flex flex-col gap-2 px-3 py-3">
                <div className="flex items-start gap-2.5">
                  <Landmark className="h-4 w-4 shrink-0 translate-y-0.5 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-[0.8125rem] font-semibold">{it.institution || t('Bank')}</span>
                      {/* 'syncing' = the initial 730-day historical backfill hasn't
                          landed yet (see lib/plaid-sync.js) — this clears itself
                          (usePlaidItems()'s polling, or this list's own loadItems
                          refresh) once it does, so no action button is needed here. */}
                      {it.status === 'syncing' && <SyncingPill />}
                      {it.status === 'reauth_required' && <Badge variant="warning">{t('Needs attention')}</Badge>}
                      {it.status === 'revoked' && <Badge variant="destructive">{t('Access revoked')}</Badge>}
                    </div>
                    <div className="text-[0.6875rem] text-muted-foreground">
                      {(it.accounts || []).map((a) => a.name + (a.mask ? ' ••' + a.mask : '')).join(', ') || t('No accounts found')}
                    </div>
                  </div>
                </div>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="whitespace-nowrap text-[0.6875rem] text-muted-foreground">
                    {it.last_synced ? t('Last synced {date}', { date: prettyDate(it.last_synced.slice(0, 10)) }) : t('Not yet synced')}
                  </span>
                  <div className="flex shrink-0 flex-wrap items-center gap-2">
                    {it.status === 'reauth_required' || it.status === 'revoked' ? (
                      <FixConnectionButton item={it} onFixed={loadItems} />
                    ) : (
                      <Button variant="outline" size="xs" disabled={syncing} onClick={sync}>
                        {syncing ? <Loader2 className="animate-spin" /> : <RefreshCw />}{t('Sync now')}
                      </Button>
                    )}
                    <Button variant="destructive" size="xs" onClick={() => setRemoving(it)}>{t('Remove')}</Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="py-1 text-xs text-muted-foreground">{t('No banks connected yet.')}</p>
        )}

        <div className="flex justify-end">
          <ConnectBankButton size="sm" onDone={async () => { await loadItems(); setTimeout(() => window.location.reload(), 1200) }} />
        </div>
      </Card>
      {removing && (
        <RemoveBankDialog
          institution={removing.institution || t('this bank')}
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  )
}

// Roadmap item 5 (update mode / re-auth). Shown instead of "Sync now" once an
// item's status flips to 'reauth_required' or 'revoked' (set by the webhook
// route — see app/api/plaid/webhook/route.js — on ITEM_LOGIN_REQUIRED,
// PENDING_EXPIRATION, ERROR, or USER_PERMISSION_REVOKED). Opens Plaid Link in
// update mode (link-token route accepts { item_id } for this); update mode
// never re-issues a new access_token, so on success we just PATCH the item's
// status back to 'ok' and trigger a normal sync — no exchange call needed.
//
// Settings can render one of these per connected-bank row. Only the row
// whose "Fix connection" was actually clicked holds a link_token, so it's
// the only one that mounts a <PlaidLinkRunner> (see connect-bank.jsx) — idle
// rows mount nothing, keeping the single-iframe guarantee even with several
// banks needing attention at once.
function FixConnectionButton({ item, onFixed }) {
  const toast = useToast()
  const t = useT()
  const [linkToken, setLinkToken] = useState(null)
  const [connecting, setConnecting] = useState(false)

  const handleSuccess = async () => {
    setLinkToken(null)
    try {
      const res = await fetch('/api/plaid/items', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: item.item_id, status: 'ok' }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Couldn't confirm the fix")
      toast(t('Connection fixed'))
      try {
        const syncRes = await fetch('/api/plaid/sync', { method: 'POST' })
        const syncData = await syncRes.json()
        if (syncRes.ok) toast(t('Synced: {n} new transactions', { n: syncData.added }))
      } catch { /* best effort */ }
      await onFixed()
    } catch (e) {
      toast(e.message, 'error')
    }
  }

  const handleExit = (err) => {
    setLinkToken(null)
    if (err) toast(err.display_message || err.error_message || t("Couldn't fix that connection"), 'error')
  }

  const fix = async () => {
    setConnecting(true)
    try {
      const res = await fetch('/api/plaid/link-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ item_id: item.item_id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || "Couldn't start reconnection")
      setLinkToken(data.link_token)
    } catch (e) {
      toast(e.message, 'error')
    }
    setConnecting(false)
  }

  return (
    <>
      <Button
        variant="outline"
        size="xs"
        className="border-amber-400/40 bg-amber-400/10 text-amber-400 hover:bg-amber-400/20"
        disabled={connecting}
        onClick={fix}
      >
        {connecting ? <Loader2 className="animate-spin" /> : <AlertTriangle />}{t('Fix connection')}
      </Button>
      {linkToken && <PlaidLinkRunner token={linkToken} onSuccess={handleSuccess} onExit={handleExit} />}
    </>
  )
}

function RemoveBankDialog({ institution, onConfirm, onClose }) {
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
        <DialogHeader><DialogTitle>{t('Remove {institution}?', { institution })}</DialogTitle></DialogHeader>
        <p className="text-xs text-muted-foreground">
          {t('SteerMoney stops pulling new transactions from this bank. Transactions already imported stay in your account.')}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>{t('Cancel')}</Button>
          <Button variant="destructive" disabled={removing} onClick={confirm}>{t('Remove')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function SharedSpacesSection() {
  const { user } = useAuthUser()
  const { state, space, spaces, createSpace, createInvite, renameSpace, fetchMembers, removeMember, deleteSpace, transferPersonalDataToSpace } = useApp()
  const toast = useToast()
  const centerToast = useCenterToast()
  const t = useT()
  const [showNewSpace, setShowNewSpace] = useState(false)
  const [renaming, setRenaming] = useState(null)
  const [inviteUrl, setInviteUrl] = useState(null)
  const [expanded, setExpanded] = useState(null) // id of the space whose members are shown
  const [membersBySpace, setMembersBySpace] = useState({}) // id -> 'loading' | array
  const [removing, setRemoving] = useState(null) // { space, member }
  const [deleting, setDeleting] = useState(null) // space pending owner-only permanent delete
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [moving, setMoving] = useState(null) // space the user is about to move their personal data into
  const [moveBusy, setMoveBusy] = useState(false)
  const [showConvert, setShowConvert] = useState(false) // naming dialog for "Convert my personal space into a shared space"
  const [convertBusy, setConvertBusy] = useState(false)

  // Gate for the "Convert my personal space into a shared space" banner:
  // only while Personal is the active view (a shared space can't be
  // converted into another shared space), and only if there's actually
  // something to move — an untouched brand-new account shouldn't see an
  // offer to move zero data. Deliberately doesn't check bank connections
  // here (ConnectedBanksSection owns that fetch, not this section) — a
  // user with only a connected bank and no other data is an edge case the
  // "hide otherwise" requirement doesn't need to be airtight against.
  const hasDataToMove = !!state && [state.debts, state.budgets, state.recurring, state.transactions, state.goals, state.accounts]
    .some((arr) => Array.isArray(arr) && arr.length > 0)

  const saveNewSpace = async (name) => {
    const r = await createSpace(name)
    if (r.error) toast(t("Couldn't create the space: {error}", { error: r.error }), 'error')
    else toast(t('"{name}" created. Copy the invite link to share it.', { name }))
  }

  const saveRename = async (name) => {
    if (name === renaming.name) return
    const r = await renameSpace(renaming.id, name)
    if (r.error) toast(t("Couldn't rename the space: {error}", { error: r.error }), 'error')
    else toast(t('Space renamed'))
  }

  const copyInvite = async (sp) => {
    const r = await createInvite(sp)
    if (r.error) return toast(r.error, 'error')
    try {
      await navigator.clipboard.writeText(r.url)
      toast(t('Invite link copied. It works for 7 days.'))
    } catch {
      setInviteUrl(r.url)
    }
  }

  // "Convert my personal space into a shared space" — the one-click version
  // of "create a space, then move my data into it," per Israel's verbatim
  // request. Deliberately built on top of the two existing primitives
  // (createSpace, transferPersonalDataToSpace) rather than a new store
  // method: createSpace already does everything a brand-new space needs
  // (workspaces + workspace_members insert, local `spaces` state, switches
  // the active view via setSpace), and transferPersonalDataToSpace already
  // has the full all-or-nothing move sequencing (see store.jsx) — this is
  // just those two calls back-to-back, with a naming dialog and toasts
  // wrapped around them.
  const convertToShared = async (name) => {
    setConvertBusy(true)
    const created = await createSpace(name)
    if (created.error) {
      setConvertBusy(false)
      centerToast("Couldn't create the shared space: " + created.error, 'error')
      return
    }
    const target = { id: created.id, name: created.name || name }
    const move = await transferPersonalDataToSpace(target.id)
    setConvertBusy(false)
    setShowConvert(false)
    if (move.error) {
      // Per transferPersonalDataToSpace's own guarantee: a core-table
      // failure aborts before anything is deleted, so personal data is
      // intact — the only side effect is the new (still-empty) space
      // sitting there, retryable via that space's own "Move my data here".
      centerToast(t('"{name}" was created, but moving your data failed: {error} Your personal data wasn\'t touched — use "Move my data here" on "{name}" to try again.', { name: target.name, error: move.error }), 'error')
      return
    }
    if (move.warning) centerToast(move.warning, 'error')
    else if (move.bankError) centerToast(t('"{name}" is ready — one bank connection needs manual attention ({error})', { name: target.name, error: move.bankError }), 'error')
    else centerToast(t('"{name}" is ready with all your data.', { name: target.name }))
    // Surface the invite link the same way every other invite in this
    // section does — copies to the clipboard silently, or falls back to
    // the InviteLinkDialog if the clipboard isn't available.
    await copyInvite(target)
  }

  const loadMembers = async (spaceId) => {
    setMembersBySpace((m) => ({ ...m, [spaceId]: 'loading' }))
    const r = await fetchMembers(spaceId)
    if (r.error) { toast(t("Couldn't load members: {error}", { error: r.error }), 'error'); setMembersBySpace((m) => ({ ...m, [spaceId]: [] })) }
    else setMembersBySpace((m) => ({ ...m, [spaceId]: r.members }))
  }

  const toggleExpand = (sp) => {
    if (expanded === sp.id) { setExpanded(null); return }
    setExpanded(sp.id)
    if (!membersBySpace[sp.id]) loadMembers(sp.id)
  }

  const confirmRemove = async () => {
    const { space: sp, member } = removing
    const label = member.name || t('Member')
    const r = await removeMember(sp.id, member.user_id)
    if (r.error) toast(t("Couldn't remove {name}: {error}", { name: label, error: r.error }), 'error')
    else { toast(t('{name} removed', { name: label })); loadMembers(sp.id) }
    setRemoving(null)
  }

  // Owner-only, permanent — see store.jsx's deleteSpace() for the full
  // sweep (every data table scoped to the space, its bank connections, then
  // the workspace row itself). DeleteSpaceDialog already gates this behind
  // typing the space's exact name, so by the time this runs the user has
  // confirmed deliberately.
  const confirmDeleteSpace = async () => {
    const sp = deleting
    setDeleteBusy(true)
    const r = await deleteSpace(sp.id)
    setDeleteBusy(false)
    setDeleting(null)
    if (r.error) centerToast(t('Couldn\'t delete "{name}": {error}', { name: sp.name, error: r.error }), 'error')
    else if (r.bankError) centerToast(t('"{name}" was deleted — one bank connection needs manual removal ({error})', { name: sp.name, error: r.bankError }), 'error')
    else centerToast(t('"{name}" was deleted.', { name: sp.name }))
  }

  // "Move my data here" — brings this person's personal debts, accounts,
  // budgets, recurring bills, transactions, goals, tags, and connected banks
  // into the shared space, then clears them out of Personal (see
  // store.jsx's transferPersonalDataToSpace for the full sequencing/safety
  // guarantees — nothing is cleared unless every write into the space
  // already succeeded).
  const confirmMove = async () => {
    const sp = moving
    setMoveBusy(true)
    const r = await transferPersonalDataToSpace(sp.id)
    setMoveBusy(false)
    setMoving(null)
    if (r.error) centerToast(r.error, 'error')
    else if (r.warning) centerToast(r.warning, 'error')
    else if (r.bankError) centerToast(t('Your data moved into "{name}" — one bank connection needs manual attention ({error})', { name: sp.name, error: r.bankError }), 'error')
    else centerToast(t('Your data moved into "{name}"', { name: sp.name }))
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title={t('Shared spaces')} />
      <Card className="space-y-4 p-5">
        <p className="text-[0.78125rem] leading-relaxed text-muted-foreground">
          {t('1. Create a shared space. 2. Copy the invite link and send it to your partner. 3. They open the link, create an account, and the space shows up for both of you. Use the switcher in the header to flip between Personal and the shared space. The person who created a space owns it and can remove members.')}
        </p>

        {!space && hasDataToMove && (
          <div className="flex flex-col items-start gap-2 rounded-lg border border-dashed border-primary/30 bg-primary/[0.04] px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between">
            <p className="min-w-0 flex-1 text-[0.75rem] leading-relaxed text-muted-foreground">
              {t('Splitting finances with a partner? Turn your Personal space into a shared one — everything you already have moves with you.')}
            </p>
            <Button size="sm" variant="outline" className="w-full max-w-full whitespace-normal text-center sm:w-auto" onClick={() => setShowConvert(true)}>
              <Users className="shrink-0" />
              <span className="sm:hidden">{t('Convert to shared space')}</span>
              <span className="hidden sm:inline">{t('Convert my personal space into a shared space')}</span>
            </Button>
          </div>
        )}

        {spaces.length > 0 && (
          <div className="divide-y divide-border/60 overflow-hidden rounded-lg border">
            {spaces.map((sp) => {
              const isOwner = sp.ownerId === user?.id
              const members = membersBySpace[sp.id]
              return (
                <div key={sp.id}>
                  <div className="flex flex-col gap-1.5 px-3 py-2.5">
                    <button
                      type="button"
                      className="-mx-1 flex w-full items-center gap-2 rounded-md px-1 py-0.5 text-left transition hover:bg-secondary/30"
                      onClick={() => toggleExpand(sp)}
                    >
                      <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${expanded === sp.id ? 'rotate-90' : ''}`} />
                      <Users className="h-4 w-4 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold">{sp.name}</span>
                      {isOwner ? (
                        <>
                          <span
                            role="button"
                            title={t('Rename space')}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md hover:bg-accent [&_svg]:h-3.5 [&_svg]:w-3.5"
                            onClick={(e) => { e.stopPropagation(); setRenaming(sp) }}
                          >
                            <Pencil />
                          </span>
                          <span
                            role="button"
                            title={t('Delete space')}
                            className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-red-400 hover:bg-red-400/10 [&_svg]:h-3.5 [&_svg]:w-3.5"
                            onClick={(e) => { e.stopPropagation(); setDeleting(sp) }}
                          >
                            <Trash2 />
                          </span>
                        </>
                      ) : null}
                    </button>
                    <div className="flex flex-wrap items-center gap-2 pl-[22px]">
                      <span
                        role="button"
                        title={t('Copy an invite link for this shared space')}
                        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-xs font-medium shadow-sm transition-colors hover:bg-accent [&_svg]:h-3.5 [&_svg]:w-3.5"
                        onClick={() => copyInvite(sp)}
                      >
                        <Link2 />{t('Copy invite link')}
                      </span>
                      <span
                        role="button"
                        title={t('Move your personal accounts, debts, budgets, transactions and bank connections into this space')}
                        className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-xs font-medium shadow-sm transition-colors hover:bg-accent [&_svg]:h-3.5 [&_svg]:w-3.5"
                        onClick={() => setMoving(sp)}
                      >
                        <ArrowRightLeft />{t('Move my data here')}
                      </span>
                    </div>
                  </div>

                  {expanded === sp.id && (
                    <div className="fade-in space-y-2.5 border-t border-border/60 bg-secondary/20 px-3 py-3">
                      {members === 'loading' ? (
                        <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />{t('Loading members…')}
                        </div>
                      ) : (members || []).length === 0 ? (
                        <p className="py-1 text-xs text-muted-foreground">{t('No members found.')}</p>
                      ) : (
                        members.map((m) => (
                          <div key={m.user_id} className="flex items-center gap-2.5">
                            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[0.6875rem] font-bold">
                              {(m.name || 'M').slice(0, 1).toUpperCase()}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-[0.8125rem] font-medium">{m.name || t('Member')}</span>
                                {m.user_id === sp.ownerId && <Badge variant="info">{t('Owner')}</Badge>}
                              </div>
                              <div className="truncate text-[0.6875rem] text-muted-foreground">{m.email || ''}</div>
                            </div>
                            {isOwner && m.user_id !== sp.ownerId && (
                              <Button variant="outline" size="xs" onClick={() => setRemoving({ space: sp, member: m })}>
                                <UserMinus />{t('Remove')}
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
          <Button size="sm" onClick={() => setShowNewSpace(true)}><Plus />{t('New shared space')}</Button>
        </div>
      </Card>
      {showNewSpace && (
        <SpaceNameDialog
          title={t('New shared space')}
          placeholder={t('Our finances')}
          onSave={saveNewSpace}
          onClose={() => setShowNewSpace(false)}
        />
      )}
      {renaming && (
        <SpaceNameDialog
          title={t('Rename space')}
          initial={renaming.name}
          onSave={saveRename}
          onClose={() => setRenaming(null)}
        />
      )}
      {showConvert && (
        <ConvertToSharedSpaceDialog
          initial={user?.firstName ? t('{name} & partner', { name: user.firstName }) : t('Our finances')}
          placeholder={t('Our finances')}
          desc={t('This creates a shared space, moves all your current data into it — accounts, debts, budgets, transactions, bank connections — and gives you an invite link for your partner. Your Personal space will be empty afterward.')}
          busy={convertBusy}
          onSave={convertToShared}
          onClose={() => !convertBusy && setShowConvert(false)}
        />
      )}
      {inviteUrl && <InviteLinkDialog url={inviteUrl} onClose={() => setInviteUrl(null)} />}
      {removing && (
        <RemoveMemberDialog
          name={removing.member.name || t('Member')}
          spaceName={removing.space.name}
          onConfirm={confirmRemove}
          onClose={() => setRemoving(null)}
        />
      )}
      {deleting && (
        <DeleteSpaceDialog
          space={deleting}
          busy={deleteBusy}
          onConfirm={confirmDeleteSpace}
          onClose={() => !deleteBusy && setDeleting(null)}
        />
      )}
      {moving && (
        <ConfirmDialog
          title={t('Move your data into "{name}"?', { name: moving.name })}
          desc={t('Your accounts, debts, budgets, recurring bills, transactions, goals, and bank connections will move into "{name}". Everyone in the space will be able to see them, and they\'ll no longer show up in your Personal space. This can take a few seconds — don\'t close this page.', { name: moving.name })}
          confirmLabel={t('Move my data')}
          busy={moveBusy}
          onConfirm={confirmMove}
          onClose={() => !moveBusy && setMoving(null)}
        />
      )}
    </div>
  )
}

// Roadmap-adjacent, user-requested: a hard reset. Clears every user-data
// slice through the single store `update(fn)` mutator (debts, budgets,
// recurring, transactions, goals, accounts — payments aren't a separate
// slice, they live inside each debt's `payments` array and get diffed away
// automatically once `s.debts = []`) and disconnects any connected banks.
// Deliberately does NOT touch `settings` (sim/mSim) or workspaces/spaces —
// those are configuration, not the "data" this button promises to erase.
function DangerZoneSection() {
  const { update } = useApp()
  const centerToast = useCenterToast()
  const t = useT()
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const eraseAll = async () => {
    setBusy(true)
    let bankError = null
    try {
      const res = await fetch('/api/plaid/items')
      const data = await res.json()
      const items = res.ok ? (data.items || []) : []
      for (const it of items) {
        try {
          const r = await fetch('/api/plaid/items', {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ item_id: it.item_id }),
          })
          if (!r.ok) { const d = await r.json().catch(() => ({})); bankError = bankError || d.error || t('Failed to disconnect a bank') }
        } catch (e) {
          bankError = bankError || e.message
        }
      }
    } catch (e) {
      // couldn't even list connections — proceed with the local data wipe anyway
      bankError = bankError || e.message
    }

    try {
      // The diff-sync in store.jsx (see the debounced effect there) diffs each
      // slice's rows by id between the last-synced state and this one — an
      // emptied array has no ids left, so every previously-synced row for
      // debts/payments/budgets/recurring/transactions/goals/accounts gets a
      // real `DELETE ... WHERE user_id = ? AND id IN (...)` against Supabase,
      // not just a local/cache clear.
      update((s) => {
        s.debts = []
        s.budgets = []
        s.recurring = []
        s.transactions = []
        s.goals = []
        s.accounts = []
      })
      centerToast(bankError ? t('Data erased — one bank connection needs manual removal') : t('All data erased'))
    } catch (e) {
      centerToast(e?.message || t("Couldn't erase your data"), 'error')
    }
    setBusy(false)
    setConfirming(false)
  }

  return (
    <div className="space-y-2.5">
      <SectionLabel title={t('Danger zone')} />
      <Card className="space-y-3 border-destructive/40 bg-destructive/[0.04] p-5">
        <div>
          <div className="text-[0.84375rem] font-bold text-red-400">{t('Erase all data')}</div>
          <p className="mt-1 text-[0.78125rem] leading-relaxed text-muted-foreground">
            {t('Permanently deletes every debt, budget, goal, recurring bill, transaction, and account in this space, and disconnects any connected banks. This can\'t be undone.')}
          </p>
        </div>
        <div className="flex justify-end">
          <Button variant="destructive" size="sm" onClick={() => setConfirming(true)}>
            <Trash2 />{t('Erase all data')}
          </Button>
        </div>
      </Card>
      {confirming && (
        <ConfirmDialog
          title={t('Erase all data?')}
          desc={t('This permanently deletes ALL your data in this space — accounts, debts, budgets, goals, recurring, transactions, payment history. Bank connections are also removed.')}
          confirmLabel={t('Erase everything')}
          busy={busy}
          onConfirm={eraseAll}
          onClose={() => setConfirming(false)}
        />
      )}
    </div>
  )
}
