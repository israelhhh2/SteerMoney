'use client'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useSession, useUser } from '@clerk/nextjs'
import { createClerkSupabaseClient } from '@/lib/supabase'
import { uid } from './lib/utils'

// ---------------- row <-> state mapping ----------------
// DB column names avoid SQL keywords (desc, limit, min); state keeps the
// original shapes so the page components are unchanged from the Vite app.

const mappers = {
  debts: {
    toRow: (d, userId) => ({
      user_id: userId, id: d.id, name: d.name, balance: d.balance,
      apr: d.apr ?? null, min_payment: d.min ?? 0, due_day: d.dueDay ?? null,
      credit_limit: d.limit ?? null, note: d.note ?? null, position: d.position ?? 0,
    }),
    fromRow: (r) => ({
      id: r.id, name: r.name, balance: Number(r.balance), apr: r.apr ?? '—',
      min: Number(r.min_payment), dueDay: r.due_day, limit: r.credit_limit == null ? null : Number(r.credit_limit),
      note: r.note ?? '', position: r.position ?? 0, payments: [],
    }),
  },
  payments: {
    toRow: (p, userId, debtId) => ({
      user_id: userId, id: p.id, debt_id: debtId, date: p.date,
      amount: p.amount, note: p.note ?? null,
    }),
    fromRow: (r) => ({ id: r.id, date: r.date, amount: Number(r.amount), note: r.note ?? '' }),
  },
  budgets: {
    toRow: (b, userId) => ({ user_id: userId, id: b.id, name: b.name, monthly_limit: b.limit ?? 0, position: b.position ?? 0 }),
    fromRow: (r) => ({ id: r.id, name: r.name, limit: Number(r.monthly_limit), position: r.position ?? 0 }),
  },
  recurring: {
    // `account_id`/`accountId` follow the same "only include the key when
    // already present" convention as transactions.toRow/fromRow below — a
    // recurring bill created from a Suggested Subscriptions detection (see
    // lib/recurring-detect.js, views/Recurring.jsx) carries the Plaid
    // account_id it was charged on; every manually-created bill has no such
    // key at all, so it round-trips unaffected. Needs its own migration —
    // `ALTER TABLE recurring ADD COLUMN IF NOT EXISTS account_id text;` — see
    // CLAUDE.md 2026-08-08 (11); until that runs, upserting a suggestion-
    // created bill (the only path that ever sets accountId) will fail like
    // any other not-yet-migrated column write in this app.
    toRow: (x, userId) => ({
      user_id: userId, id: x.id, description: x.desc, amount: x.amount,
      due_day: x.dueDay ?? null, category: x.cat ?? 'other', active: x.active !== false,
      every_n_months: x.every ?? 1, position: x.position ?? 0,
      ...(x.accountId !== undefined ? { account_id: x.accountId } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, desc: r.description, amount: Number(r.amount), dueDay: r.due_day,
      cat: r.category, active: r.active, position: r.position ?? 0,
      ...(r.every_n_months > 1 ? { every: r.every_n_months } : {}),
      ...(r.account_id !== undefined ? { accountId: r.account_id } : {}),
    }),
  },
  transactions: {
    // `account_id`/`accountId` are only included when already present — omitting
    // the key entirely (rather than sending null) keeps this working even if the
    // `account_id` column hasn't been migrated onto public.transactions yet.
    toRow: (t, userId) => ({
      user_id: userId, id: t.id, date: t.date, description: t.desc,
      amount: t.amount, type: t.type, category: t.cat ?? 'other',
      ...(t.accountId !== undefined ? { account_id: t.accountId } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, date: r.date, desc: r.description, amount: Number(r.amount), type: r.type, cat: r.category,
      ...(r.account_id !== undefined ? { accountId: r.account_id } : {}),
    }),
  },
  goals: {
    toRow: (g, userId) => ({
      user_id: userId, id: g.id, name: g.name, icon: g.icon ?? null, target: g.target ?? 0,
      target_date: g.targetDate ?? null, status: g.status || 'active', txs: g.txs || [], position: g.position ?? 0,
    }),
    fromRow: (r) => ({
      id: r.id, name: r.name, icon: r.icon, target: Number(r.target), targetDate: r.target_date,
      status: r.status, txs: r.txs || [], position: r.position ?? 0,
    }),
  },
  accounts: {
    toRow: (a, userId) => ({
      user_id: userId, id: a.id, name: a.name, type: a.type || 'depository', institution: a.institution ?? null,
      mask: a.mask ?? null, balance: a.balance ?? 0, history: a.history || [], position: a.position ?? 0,
    }),
    fromRow: (r) => ({
      id: r.id, name: r.name, type: r.type, institution: r.institution ?? '', mask: r.mask ?? '',
      balance: Number(r.balance), history: r.history || [], position: r.position ?? 0,
    }),
  },
  // One row per {account, tag} — `accountKey` is the same canonical URL id
  // lib/accounts.js's accountUrlId() produces for every account type (manual
  // acc_<id>, debt debt_<id>, or a Plaid account_id), so tags need no
  // per-account-type branching anywhere. See CLAUDE.md 2026-08-08 (10) for
  // the account_tags table's migration SQL — this table is newer than every
  // other slice, so it's read/written defensively (see the initial-load and
  // diff-sync effects below) in case the migration hasn't run yet.
  accountTags: {
    toRow: (t, userId) => ({ user_id: userId, id: t.id, account_key: t.accountKey, tag: t.tag }),
    fromRow: (r) => ({ id: r.id, accountKey: r.account_key, tag: r.tag }),
  },
  // One row per account (at most one — unlike accountTags, which is many
  // rows per account) — a card either has a custom color or it doesn't, so
  // "reset to Auto" (see lib/accounts.js's setAccountColor) is just deleting
  // the row rather than needing a separate flag. `accountKey` is the same
  // canonical accountUrlId() every other per-account slice already uses.
  // Same "newer table, defensive everywhere" treatment as account_tags
  // (2026-08-08 (10)) — see OPTIONAL_TABLES and the initial-load/diff-sync
  // effects below, and CLAUDE.md's session log for account_colors.sql.
  accountColors: {
    toRow: (c, userId) => ({ user_id: userId, id: c.id, account_key: c.accountKey, color: c.color }),
    fromRow: (r) => ({ id: r.id, accountKey: r.account_key, color: r.color }),
  },
}

// Every new account starts fresh: no data, just a small starter category list
// (0 = no limit) so new users aren't buried in categories. They add more as needed.
const DEFAULT_CATEGORIES = [
  ['housing', 'Housing / Rent'], ['groceries', 'Groceries'], ['dining', 'Dining Out'],
  ['auto', 'Car & Gas'], ['utilities', 'Utilities & Phone'], ['other', 'Other'],
]

function freshState() {
  return {
    debts: [],
    budgets: DEFAULT_CATEGORIES.map(([id, name], i) => ({ id, name, limit: 0, position: i })),
    transactions: [],
    recurring: [],
    goals: [],
    accounts: [],
    accountTags: [],
    accountColors: [],
    sim: { budget: 0, strategy: 'avalanche', snowExtra: 0 },
    mSim: { income: '', items: [] },
  }
}

// Give every row an id so it can be diffed/synced (pages create items without ids).
function normalize(s) {
  if (!s.goals) s.goals = [] // older cached states predate the goals table
  if (!s.accounts) s.accounts = [] // older cached states predate the accounts table
  if (!s.accountTags) s.accountTags = [] // older cached states predate the account_tags table
  if (!s.accountColors) s.accountColors = [] // older cached states predate the account_colors table
  s.debts.forEach((d, i) => {
    if (!d.id) d.id = uid('d')
    d.position = i
    if (!d.payments) d.payments = []
    d.payments.forEach((p) => { if (!p.id) p.id = uid('p') })
  })
  s.budgets.forEach((b, i) => { if (!b.id) b.id = uid('b'); b.position = i })
  s.recurring.forEach((r, i) => { if (!r.id) r.id = uid('r'); r.position = i })
  s.transactions.forEach((t) => { if (!t.id) t.id = uid('tx') })
  s.goals.forEach((g, i) => { if (!g.id) g.id = uid('g'); g.position = i; if (!g.txs) g.txs = [] })
  s.accounts.forEach((a, i) => { if (!a.id) a.id = uid('a'); a.position = i; if (!a.history) a.history = [] })
  s.accountTags.forEach((t) => { if (!t.id) t.id = uid('at') })
  s.accountColors.forEach((c) => { if (!c.id) c.id = uid('ac') })
}

const flatPayments = (s, userId) =>
  s.debts.flatMap((d) => d.payments.map((p) => mappers.payments.toRow(p, userId, d.id)))

function stateRows(s, userId) {
  return {
    debts: s.debts.map((d) => mappers.debts.toRow(d, userId)),
    payments: flatPayments(s, userId),
    budgets: s.budgets.map((b) => mappers.budgets.toRow(b, userId)),
    recurring: s.recurring.map((r) => mappers.recurring.toRow(r, userId)),
    transactions: s.transactions.map((t) => mappers.transactions.toRow(t, userId)),
    goals: s.goals.map((g) => mappers.goals.toRow(g, userId)),
    accounts: s.accounts.map((a) => mappers.accounts.toRow(a, userId)),
    accountTags: s.accountTags.map((t) => mappers.accountTags.toRow(t, userId)),
    accountColors: s.accountColors.map((c) => mappers.accountColors.toRow(c, userId)),
  }
}

// Tables that might not exist yet in an older Supabase project (their
// migration shipped after the table was first introduced) — a sync failure
// against one of these is swallowed (logged, not surfaced as `syncError`)
// instead of aborting every other table's sync for the rest of this pass.
// `account_tags` (2026-08-08 (10)) and `account_colors` (this session) — both
// are per-account niceties, not core data.
const OPTIONAL_TABLES = new Set(['account_tags', 'account_colors'])

// Diff two row arrays by id -> {upserts, deletes}
function diffRows(prev, next) {
  const prevMap = new Map(prev.map((r) => [r.id, JSON.stringify(r)]))
  const nextIds = new Set(next.map((r) => r.id))
  const upserts = next.filter((r) => prevMap.get(r.id) !== JSON.stringify(r))
  const deletes = prev.filter((r) => !nextIds.has(r.id)).map((r) => r.id)
  return { upserts, deletes }
}

const Ctx = createContext(null)

const VIEW_AS_KEY = 'fin-view-as'

export function AppProvider({ children }) {
  const { session } = useSession()
  const { user } = useUser()
  const supabase = useMemo(() => (session ? createClerkSupabaseClient(session) : null), [session?.id])

  // Admin "view as customer" mode — loads someone else's rows, read-only.
  // The stored value is bound to the admin who started it (`by`) — if a
  // different account signs in on this tab, it is discarded, never restored.
  const [viewAs, setViewAsState] = useState(null)
  useEffect(() => {
    if (!user?.id) return
    try {
      const v = JSON.parse(sessionStorage.getItem(VIEW_AS_KEY))
      if (v?.by === user.id) { synced.current = null; setState(null); setViewAsState(v) }
      else if (v) sessionStorage.removeItem(VIEW_AS_KEY)
    } catch {}
  }, [user?.id])

  // Shared spaces (collab): when a space is active, its ws_... id is the
  // effective owner id — load, sync, and cache all point at the shared rows.
  const SPACE_KEY = (uid) => 'fin-space-' + uid
  const [space, setSpaceState] = useState(null)
  const [spaces, setSpaces] = useState([])
  useEffect(() => {
    if (!user?.id) return
    try { const s = JSON.parse(localStorage.getItem(SPACE_KEY(user.id))); if (s?.id) setSpaceState(s) } catch {}
  }, [user?.id])
  useEffect(() => {
    if (!supabase || !user?.id) return
    let on = true
    supabase.from('workspace_members').select('workspace_id, workspaces(name, owner_id)').eq('user_id', user.id)
      .then(({ data }) => {
        if (!on || !data) return
        const list = data.map((r) => ({ id: r.workspace_id, name: r.workspaces?.name || 'Shared finances', ownerId: r.workspaces?.owner_id }))
        setSpaces(list)
        // the currently selected space is gone (the user was removed from it): fall back to personal
        if (space?.id && !list.some((s) => s.id === space.id)) {
          try { localStorage.removeItem(SPACE_KEY(user.id)) } catch {}
          setSpaceState(null)
        }
        // backfill name/email on this user's own membership rows, fire and forget
        // (covers rows created before this feature existed, and keeps them fresh)
        const fullName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || null
        const email = user.primaryEmailAddress?.emailAddress || null
        supabase.from('workspace_members').update({ name: fullName, email }).eq('user_id', user.id)
      })
    return () => { on = false }
  }, [supabase, user?.id, space?.id])

  const userId = viewAs?.id || space?.id || user?.id

  const [state, setState] = useState(null)
  const [syncError, setSyncError] = useState(null)
  const synced = useRef(null)   // last state persisted to Supabase
  const syncing = useRef(Promise.resolve())
  const dirty = useRef(false)   // user edited since the cache was hydrated
  const freshFor = useRef(null) // userId whose data was fetched from Supabase this session
  const loadingFor = useRef(null)

  const CACHE = (id) => 'fin-cache-' + id
  const writeCache = (id, s) => { try { localStorage.setItem(CACHE(id), JSON.stringify(s)) } catch {} }

  // ---- instant hydration from the local cache ----
  // New browser tabs and refreshes render the last known data immediately;
  // the load effect below still fetches fresh rows in the background.
  useEffect(() => {
    if (!userId || viewAs || state || freshFor.current === userId) return
    try {
      const c = JSON.parse(localStorage.getItem(CACHE(userId)))
      if (c?.sim && c.debts) { synced.current = c; dirty.current = false; setState(c) }
    } catch {}
  }, [userId, viewAs, state])

  // ---- initial load (seeds the DB on first sign-in) ----
  // user_id filters matter: admins can SELECT every user's rows, so without
  // them an admin's own dashboard would merge all customers together.
  useEffect(() => {
    if (!supabase || !userId) return
    if (freshFor.current === userId || loadingFor.current === userId) return
    loadingFor.current = userId
    let cancelled = false
    ;(async () => {
      const [de, pa, bu, re, go, tx, se, acc, tg, cl] = await Promise.all([
        supabase.from('debts').select('*').eq('user_id', userId).order('position'),
        supabase.from('payments').select('*').eq('user_id', userId).order('date', { ascending: false }),
        supabase.from('budgets').select('*').eq('user_id', userId).order('position'),
        supabase.from('recurring').select('*').eq('user_id', userId).order('position'),
        supabase.from('goals').select('*').eq('user_id', userId).order('position'),
        supabase.from('transactions').select('*').eq('user_id', userId).order('date', { ascending: false }),
        supabase.from('settings').select('*').eq('user_id', userId).maybeSingle(),
        supabase.from('accounts').select('*').eq('user_id', userId).order('position'),
        supabase.from('account_tags').select('*').eq('user_id', userId),
        supabase.from('account_colors').select('*').eq('user_id', userId),
      ])
      const err = [de, pa, bu, re, tx, se].find((r) => r.error)
      if (err) { if (!cancelled) setSyncError(err.error.message); return }
      // goals shipped after the other tables — if goals.sql hasn't been run yet, keep the app usable
      if (go.error && !cancelled) setSyncError('Goals need setup: run supabase/goals.sql in the Supabase SQL editor (' + go.error.message + ')')
      // accounts shipped after the other tables — if accounts.sql hasn't been run yet, keep the app usable
      if (acc.error && !cancelled) setSyncError('Accounts need setup: run supabase/accounts.sql in the Supabase SQL editor (' + acc.error.message + ')')
      // account_tags is the newest table (see CLAUDE.md 2026-08-08 (10)) — never blocks the app,
      // and deliberately doesn't even set syncError (tags are a nicety, not core data; a
      // console warning is enough until the migration is run).
      if (tg.error) console.warn('[store] account_tags table not available yet:', tg.error.message)
      // account_colors is the same shape/vintage as account_tags — same treatment.
      if (cl.error) console.warn('[store] account_colors table not available yet:', cl.error.message)

      let s
      if (!de.data.length && !bu.data.length && !tx.data.length && !re.data.length) {
        if (viewAs) {
          // never write while impersonating — just show the customer's (empty) account
          s = { ...freshState(), budgets: [] }
          freshFor.current = userId
          if (!cancelled) { synced.current = s; setState(s) }
          return
        }
        // brand-new user: start fresh (default categories only, no data)
        s = freshState()
        const { error } = await supabase.from('budgets').insert(s.budgets.map((b) => mappers.budgets.toRow(b, userId)))
        if (error) { if (!cancelled) setSyncError(error.message); return }
        await supabase.from('settings').upsert({ user_id: userId, sim: s.sim, m_sim: s.mSim })
      } else {
        const byDebt = {}
        pa.data.forEach((r) => (byDebt[r.debt_id] = byDebt[r.debt_id] || []).push(mappers.payments.fromRow(r)))
        s = {
          debts: de.data.map((r) => ({ ...mappers.debts.fromRow(r), payments: byDebt[r.id] || [] })),
          budgets: bu.data.map(mappers.budgets.fromRow),
          recurring: re.data.map(mappers.recurring.fromRow),
          transactions: tx.data.map(mappers.transactions.fromRow),
          goals: go.error ? [] : go.data.map(mappers.goals.fromRow),
          accounts: acc.error ? [] : acc.data.map(mappers.accounts.fromRow),
          accountTags: tg.error ? [] : tg.data.map(mappers.accountTags.fromRow),
          accountColors: cl.error ? [] : cl.data.map(mappers.accountColors.fromRow),
          sim: se.data?.sim || { budget: 2100, strategy: 'avalanche', snowExtra: 0 },
          mSim: se.data?.m_sim || { income: '', items: [] },
        }
      }
      freshFor.current = userId
      if (!viewAs) writeCache(userId, s)
      // don't clobber edits the user made on top of the cached copy while we fetched
      if (!cancelled && !dirty.current) { synced.current = s; setState(s) }
    })().catch((e) => { if (!cancelled) setSyncError(String(e?.message || e)) })
      .finally(() => { if (loadingFor.current === userId) loadingFor.current = null })
    return () => { cancelled = true }
  }, [supabase, userId, state])

  // ---- debounced diff sync ----
  useEffect(() => {
    if (viewAs) return // read-only while viewing another customer
    if (!state || !synced.current || state === synced.current || !supabase) return
    const t = setTimeout(() => {
      const prev = synced.current
      const next = state
      // chain syncs so they never interleave
      syncing.current = syncing.current.then(async () => {
        try {
          const prevRows = stateRows(prev, userId)
          const nextRows = stateRows(next, userId)
          // deletes first for payments (FK), debts last so payment FKs stay valid.
          // account_tags/account_colors have no FK relationship to anything else in
          // this list, so their position doesn't matter — they're last purely for
          // readability.
          for (const table of ['payments', 'transactions', 'budgets', 'recurring', 'goals', 'accounts', 'debts', 'account_tags', 'account_colors']) {
            const { deletes } = diffRows(prevRows[table], nextRows[table])
            if (!deletes.length) continue
            const { error } = await supabase.from(table).delete().eq('user_id', userId).in('id', deletes)
            if (error) {
              // account_tags may not be migrated yet — don't let that abort every
              // other table's sync this pass (see OPTIONAL_TABLES above).
              if (OPTIONAL_TABLES.has(table)) { console.warn(`[store] ${table} delete skipped:`, error.message); continue }
              throw error
            }
          }
          for (const table of ['debts', 'payments', 'budgets', 'recurring', 'transactions', 'goals', 'accounts', 'account_tags', 'account_colors']) {
            const { upserts } = diffRows(prevRows[table], nextRows[table])
            if (!upserts.length) continue
            const { error } = await supabase.from(table).upsert(upserts, { onConflict: 'user_id,id' })
            if (error) {
              if (OPTIONAL_TABLES.has(table)) { console.warn(`[store] ${table} upsert skipped:`, error.message); continue }
              throw error
            }
          }
          if (JSON.stringify(prev.sim) !== JSON.stringify(next.sim) || JSON.stringify(prev.mSim) !== JSON.stringify(next.mSim)) {
            const { error } = await supabase.from('settings').upsert({ user_id: userId, sim: next.sim, m_sim: next.mSim })
            if (error) throw error
          }
          synced.current = next
          writeCache(userId, next)
          setSyncError(null)
        } catch (e) {
          setSyncError(String(e?.message || e))
        }
      })
    }, 400)
    return () => clearTimeout(t)
  }, [state, supabase, userId])

  const setViewAs = (info) => {
    const v = info ? { ...info, by: user?.id } : null
    try { v ? sessionStorage.setItem(VIEW_AS_KEY, JSON.stringify(v)) : sessionStorage.removeItem(VIEW_AS_KEY) } catch {}
    synced.current = null
    freshFor.current = null
    dirty.current = false
    setState(null)
    setSyncError(null)
    setViewAsState(v)
  }

  // switch between personal (null) and a shared space ({id, name})
  const setSpace = (info) => {
    try { info ? localStorage.setItem(SPACE_KEY(user.id), JSON.stringify(info)) : localStorage.removeItem(SPACE_KEY(user.id)) } catch {}
    synced.current = null
    freshFor.current = null
    dirty.current = false
    setState(null)
    setSyncError(null)
    setSpaceState(info)
  }

  const createSpace = async (name) => {
    const id = 'ws_' + Math.random().toString(36).slice(2, 12)
    const { error } = await supabase.from('workspaces').insert({ id, name, owner_id: user.id })
    if (error) return { error: error.message }
    const fullName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || null
    const email = user.primaryEmailAddress?.emailAddress || null
    const { error: e2 } = await supabase.from('workspace_members').insert({ workspace_id: id, user_id: user.id, name: fullName, email })
    if (e2) return { error: e2.message }
    const info = { id, name }
    setSpaces((s) => [...s, { ...info, ownerId: user.id }])
    setSpace(info)
    return { ok: true }
  }

  // sp defaults to the currently selected space so the header's Invite button
  // keeps working unchanged; Settings passes a specific space to invite to.
  const createInvite = async (sp = space) => {
    if (!sp) return { error: 'Open a shared space first' }
    // crypto.randomUUID only exists on secure origins; phones hitting the LAN IP over http need the fallback
    const token = 'inv' + (typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID().replaceAll('-', '')
      : Array.from({ length: 4 }, () => Math.random().toString(36).slice(2)).join(''))
    const { error } = await supabase.from('workspace_invites').insert({ token, workspace_id: sp.id, created_by: user.id })
    if (error) return { error: error.message }
    return { url: `${window.location.origin}/join/${token}` }
  }

  // Owner-only rename. Updates the local spaces list (and the active space,
  // if it's the one renamed) without resetting/refetching the app's data.
  const renameSpace = async (id, name) => {
    const { error } = await supabase.from('workspaces').update({ name }).eq('id', id)
    if (error) return { error: error.message }
    setSpaces((s) => s.map((x) => (x.id === id ? { ...x, name } : x)))
    if (space?.id === id) {
      const info = { id, name }
      try { localStorage.setItem(SPACE_KEY(user.id), JSON.stringify(info)) } catch {}
      setSpaceState(info)
    }
    return { ok: true }
  }

  const joinSpace = async (token) => {
    const fullName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || null
    const email = user.primaryEmailAddress?.emailAddress || null
    let { data, error } = await supabase.rpc('join_workspace', { invite_token: token, p_name: fullName, p_email: email })
    // members.sql not applied yet: only the old 1-arg function exists, so retry without the profile args
    if (error && /function|parameter|schema cache/i.test(error.message)) {
      ;({ data, error } = await supabase.rpc('join_workspace', { invite_token: token }))
    }
    if (error || !data) return { error: error?.message || 'This invite link is invalid or expired.' }
    const [id, ...rest] = data.split('|')
    const info = { id, name: rest.join('|') || 'Shared finances' }
    setSpaces((s) => (s.some((x) => x.id === id) ? s : [...s, info]))
    setSpace(info)
    return { ok: true }
  }

  // { user_id, name, email }[] for everyone in a space, or { error }
  const fetchMembers = async (spaceId) => {
    const { data, error } = await supabase.from('workspace_members').select('user_id, name, email').eq('workspace_id', spaceId)
    if (error) return { error: error.message }
    return { members: data }
  }

  // Owner-only in practice (RLS also allows removing yourself, i.e. leaving).
  const removeMember = async (spaceId, memberUserId) => {
    const { error } = await supabase.from('workspace_members').delete().eq('workspace_id', spaceId).eq('user_id', memberUserId)
    if (error) return { error: error.message }
    return { ok: true }
  }

  // "Move my data into this space" (Settings → Shared spaces → per-space
  // "Move my data here"). A brand-new shared space starts empty (see
  // freshState()'s brand-new-user branch above) — this is what lets Israel
  // start a space WITH his existing personal data instead of re-entering
  // everything by hand.
  //
  // Deliberately bypasses the reactive `state`/debounced diff-sync entirely
  // and does its own direct Supabase reads/writes: relying on `update(fn)`
  // + waiting for the debounced sync effect to settle would mean either
  // guessing a delay or plumbing a new "is the sync effect idle" signal out
  // of this closure, and it would only work at all while Personal happens to
  // be the active view. Doing it directly means it works correctly no
  // matter what's currently on screen (Personal, the target space, a third
  // space, or admin view-as — blocked outright, see the guard below), and
  // the two tables/spaces this actually touches are still refreshed
  // immediately after via the same freshFor/synced reset setSpace() already
  // uses when switching contexts.
  //
  // All tables get the exact same 'user_id,id' composite primary key as
  // every other slice's upsert (see stateRows()/the diff-sync effect above)
  // — copying a row from personal to a space's user_id is never a
  // collision with anything the space already has (different user_id
  // partition), so no id-remapping is needed anywhere in this function.
  //
  // Sequencing is deliberately all-or-nothing and irreversible-safety-first,
  // per the explicit requirement: write everything into the space FIRST; a
  // failure at that stage clears nothing from personal and can be retried.
  // Only once every table's write into the space has succeeded do personal
  // rows get deleted — and if *that* step partially fails, the data is
  // already safely duplicated in the space (worst case: it shows up in both
  // places until cleared by hand), never lost.
  const CORE_TRANSFER_TABLES = ['debts', 'payments', 'budgets', 'recurring', 'transactions', 'goals']
  const OPTIONAL_TRANSFER_TABLES = ['accounts', 'account_tags', 'account_colors'] // may not be migrated yet on an older project
  // debts before payments (FK) going in; payments/transactions/etc. before
  // debts coming out — same ordering convention as the diff-sync effect.
  const TRANSFER_DELETE_ORDER = ['payments', 'transactions', 'budgets', 'recurring', 'goals', 'accounts', 'debts', 'account_tags', 'account_colors']

  const transferPersonalDataToSpace = async (targetSpaceId) => {
    if (viewAs) return { error: "Not available while viewing another customer" }
    if (!supabase || !user?.id) return { error: 'Not signed in' }
    if (!targetSpaceId || targetSpaceId === user.id) return { error: 'Invalid target space' }
    if (!spaces.some((s) => s.id === targetSpaceId)) return { error: "You're not a member of that space" }

    const sourceId = user.id
    const allTables = [...CORE_TRANSFER_TABLES, ...OPTIONAL_TRANSFER_TABLES]

    try {
      // 1. Read every personal row for every table up front.
      const results = await Promise.all(allTables.map((t) => supabase.from(t).select('*').eq('user_id', sourceId)))
      const byTable = {}
      for (let i = 0; i < allTables.length; i++) {
        const table = allTables[i]
        const { data, error } = results[i]
        if (error) {
          if (OPTIONAL_TRANSFER_TABLES.includes(table)) {
            console.warn(`[transfer] ${table} not available yet, skipping:`, error.message)
            byTable[table] = []
            continue
          }
          return { error: `Couldn't read your ${table}: ${error.message}` }
        }
        byTable[table] = data || []
      }

      // 2. Write everything into the target space. Nothing is deleted from
      //    personal until this step succeeds for that table — tracked in
      //    `moved` so step 4 only ever clears personal rows that are
      //    actually, confirmedly sitting in the space now.
      //    CORE_TRANSFER_TABLES (real financial data) hard-abort the whole
      //    operation on failure — "nothing cleared if the space write
      //    failed." OPTIONAL_TRANSFER_TABLES (account_tags/account_colors —
      //    per-account niceties, already treated leniently everywhere else
      //    in this app; see OPTIONAL_TABLES above) instead skip-and-warn: a
      //    color-picker table lagging a migration shouldn't block moving
      //    someone's actual debts/transactions/budgets.
      const moved = {}
      let optionalWarning = null
      for (const table of allTables) {
        const rows = byTable[table]
        if (!rows.length) { moved[table] = true; continue }
        const movedRows = rows.map((r) => ({ ...r, user_id: targetSpaceId }))
        const { error } = await supabase.from(table).upsert(movedRows, { onConflict: 'user_id,id' })
        if (error) {
          if (OPTIONAL_TRANSFER_TABLES.includes(table)) {
            console.warn(`[transfer] ${table} failed to move, skipping (left in personal):`, error.message)
            optionalWarning = optionalWarning || `Moved, but couldn't move your ${table}: ${error.message}`
            moved[table] = false
            continue
          }
          return { error: `Couldn't move your ${table} into that space: ${error.message}. Nothing was cleared.` }
        }
        moved[table] = true
      }

      // 3. Bank connections (plaid_items) are service-role only (RLS, no
      //    policies — see lib/plaid-server.js) — hand off to the dedicated
      //    API route instead of touching that table from the client.
      let bankError = null
      try {
        const res = await fetch('/api/plaid/transfer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ to_space_id: targetSpaceId }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) bankError = data.error || 'Failed to move bank connections'
      } catch (e) {
        bankError = e?.message || 'Failed to move bank connections'
      }

      // 4. Clear personal, but only for tables that actually landed in the
      //    space (step 2) — a skipped optional table keeps its personal
      //    rows untouched rather than being deleted with nowhere to go.
      for (const table of TRANSFER_DELETE_ORDER) {
        const rows = byTable[table]
        if (!rows || !rows.length || !moved[table]) continue
        const ids = rows.map((r) => r.id)
        const { error } = await supabase.from(table).delete().eq('user_id', sourceId).in('id', ids)
        if (error) {
          // The copy already succeeded — worst case is duplicated data, not
          // lost data. Surface it distinctly rather than claiming failure.
          return { ok: true, warning: `Moved, but couldn't fully clear your personal ${table}: ${error.message}`, bankError }
        }
      }

      // 5. Force a refetch of whichever side is the currently active view
      //    (Personal or the space just filled) — same reset shape
      //    setSpace()/setViewAs() already use when switching contexts.
      if (userId === sourceId || userId === targetSpaceId) {
        synced.current = null
        freshFor.current = null
        loadingFor.current = null
        dirty.current = false
        setState(null)
      }
      try { localStorage.removeItem(CACHE(sourceId)) } catch {}

      return { ok: true, bankError, warning: optionalWarning }
    } catch (e) {
      return { error: e?.message || 'Failed to move your data' }
    }
  }

  const api = useMemo(() => ({
    state,
    syncError,
    viewingAs: viewAs,                     // {id, name} while impersonating, else null
    setViewAs,
    exitViewAs: () => setViewAs(null),
    space,                                 // {id, name} while in a shared space, else null
    spaces,                                // shared spaces this user belongs to
    setSpace,
    createSpace,
    createInvite,
    renameSpace,
    joinSpace,
    fetchMembers,
    removeMember,
    transferPersonalDataToSpace, // "Move my data into this space" — see definition above
    // update(fn): fn receives a deep clone, mutates freely, returns nothing
    // no-op while viewing another customer — support mode is strictly read-only
    update: viewAs
      ? () => {}
      : (fn) => { dirty.current = true; setState((s) => { const c = JSON.parse(JSON.stringify(s)); if (!c.goals) c.goals = []; if (!c.accounts) c.accounts = []; if (!c.accountTags) c.accountTags = []; if (!c.accountColors) c.accountColors = []; fn(c); normalize(c); return c }) },
    catInfo: (id) => state?.budgets.find((b) => b.id === id) || ({ debt: { name: 'Debt Payment' }, income: { name: 'Income' }, transfer: { name: 'Transfer' } }[id]) || { name: id || 'Other' },
    uid,
  }), [state, syncError, viewAs, space, spaces])

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export const useApp = () => useContext(Ctx)

// ---- shared selectors ----
export const monthTx = (state, ym) => state.transactions.filter((t) => t.date.startsWith(ym))
export const rangeTx = (state, from, to) => state.transactions.filter((t) => t.date >= from && t.date <= to)
export const incomeIn = (state, ym) => monthTx(state, ym).filter((t) => t.type === 'income' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
export const expensesIn = (state, ym) => monthTx(state, ym).filter((t) => t.type === 'expense' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
export const spentIn = (state, ym, cat) => monthTx(state, ym).filter((t) => t.type === 'expense' && t.cat === cat).reduce((s, t) => s + t.amount, 0)
export const dataMonths = (state) => [...new Set(state.transactions.filter((t) => t.cat !== 'transfer').map((t) => t.date.slice(0, 7)))].sort().reverse()
