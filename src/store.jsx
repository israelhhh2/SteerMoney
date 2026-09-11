'use client'
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useAuthUser } from '@/components/auth-provider'
import { createAuthedSupabaseClient } from '@/lib/supabase'
import { uid } from './lib/utils'
import { CATEGORY_DEFS, CATEGORIES_V } from './lib/categories'

// ---------------- row <-> state mapping ----------------
// DB column names avoid SQL keywords (desc, limit, min); state keeps the
// original shapes so the page components are unchanged from the Vite app.

const mappers = {
  debts: {
    toRow: (d, userId) => ({
      user_id: userId, id: d.id, name: d.name, balance: d.balance,
      apr: d.apr ?? null, min_payment: d.min ?? 0, due_day: d.dueDay ?? null,
      credit_limit: d.limit ?? null, note: d.note ?? null, position: d.position ?? 0,
      // `payeePattern`/`balanceAsOf` (lib/debt-payments.js's automatic
      // payment matching for manual debts — supabase/debt-payments-auto.sql)
      // follow the same "only include the key when already present" degrade
      // convention as transactions.accountId/recurring.accountId below:
      // omitting the key entirely (rather than sending null/'') keeps every
      // OTHER field on this row saving normally even before that migration
      // has run, as long as the owner never actually types into the new
      // "Payee match"/"Balance as of" fields (views/Debts.jsx's DebtDialog)
      // on THIS debt. The moment they do, `f.payeePattern`/`f.balanceAsOf`
      // become real strings and this key is sent — which needs the
      // migration, same tradeoff already accepted for every other
      // optional-column field in this app.
      ...(d.payeePattern !== undefined ? { payee_pattern: d.payeePattern } : {}),
      ...(d.balanceAsOf !== undefined ? { balance_as_of: d.balanceAsOf } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, name: r.name, balance: Number(r.balance), apr: r.apr ?? '—',
      min: Number(r.min_payment), dueDay: r.due_day, limit: r.credit_limit == null ? null : Number(r.credit_limit),
      note: r.note ?? '', position: r.position ?? 0, payments: [],
      // Set only when the debts-plaid.sql migration has run and this row was
      // auto-created/linked from a Plaid credit account (lib/plaid-debts.js)
      // — read-only here, never written back by toRow, so a client-side edit
      // (payment, note, etc.) can never accidentally clear the link. Drives
      // the "Synced from Plaid" badge in views/Debts.jsx.
      ...(r.plaid_account_id !== undefined ? { plaidAccountId: r.plaid_account_id } : {}),
      ...(r.plaid_item_id !== undefined ? { plaidItemId: r.plaid_item_id } : {}),
      // Editable client-side (DebtDialog, Plaid-linked debts hidden) — see
      // the toRow comment above and lib/debt-payments.js, which reads these
      // two columns server-side to decide what/when to auto-match.
      ...(r.payee_pattern !== undefined ? { payeePattern: r.payee_pattern } : {}),
      ...(r.balance_as_of !== undefined ? { balanceAsOf: r.balance_as_of } : {}),
    }),
  },
  payments: {
    toRow: (p, userId, debtId) => ({
      user_id: userId, id: p.id, debt_id: debtId, date: p.date,
      amount: p.amount, note: p.note ?? null,
      // The transactions.id this payment was auto-logged from (see
      // lib/debt-payments.js) — undefined/omitted for every manually-entered
      // payment (Debts.jsx's "Log payment"), so this round-trips fine before
      // supabase/debt-payments-auto.sql has run.
      ...(p.txId !== undefined ? { tx_id: p.txId } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, date: r.date, amount: Number(r.amount), note: r.note ?? '',
      // Present (and non-null) only for a payment lib/debt-payments.js
      // logged automatically — drives the "auto" badge in Debts.jsx's
      // payment history list.
      ...(r.tx_id !== undefined ? { txId: r.tx_id } : {}),
    }),
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
    // `account_id`/`accountId` (and, as of categories-v2.sql, `merchant`/
    // `pfc_primary`/`pfc_detailed`/`cat_source`) are only included when
    // already present — omitting the key entirely (rather than sending
    // null) keeps this working even if the column hasn't been migrated onto
    // public.transactions yet. merchant/pfcPrimary/pfcDetailed are written by
    // lib/plaid-sync.js's sync route and lib/transactions-backfill.js, never
    // by the client — this mapper just round-trips whatever's there.
    // catSource IS written client-side: 'manual' the moment a person picks a
    // category by hand (Transactions.jsx's TxDialog, AccountDetail's inline
    // select) — see lib/transactions-backfill.js for why that flag matters.
    toRow: (t, userId) => ({
      user_id: userId, id: t.id, date: t.date, description: t.desc,
      amount: t.amount, type: t.type, category: t.cat ?? 'other',
      ...(t.accountId !== undefined ? { account_id: t.accountId } : {}),
      ...(t.merchant !== undefined ? { merchant: t.merchant } : {}),
      ...(t.pfcPrimary !== undefined ? { pfc_primary: t.pfcPrimary } : {}),
      ...(t.pfcDetailed !== undefined ? { pfc_detailed: t.pfcDetailed } : {}),
      ...(t.catSource !== undefined ? { cat_source: t.catSource } : {}),
      // Which manual debt this transaction paid (lib/debt-payments.js sets
      // this server-side the moment it auto-matches a payment; Debts.jsx's
      // onDeletePayment sets it back to null client-side if that auto-match
      // is reversed) — same present-only convention as every other optional
      // column here, so this round-trips fine before
      // supabase/debt-payments-auto.sql has run.
      ...(t.debtId !== undefined ? { debt_id: t.debtId } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, date: r.date, desc: r.description, amount: Number(r.amount), type: r.type, cat: r.category,
      ...(r.account_id !== undefined ? { accountId: r.account_id } : {}),
      ...(r.merchant !== undefined ? { merchant: r.merchant } : {}),
      ...(r.pfc_primary !== undefined ? { pfcPrimary: r.pfc_primary } : {}),
      ...(r.pfc_detailed !== undefined ? { pfcDetailed: r.pfc_detailed } : {}),
      ...(r.cat_source !== undefined ? { catSource: r.cat_source } : {}),
      ...(r.debt_id !== undefined ? { debtId: r.debt_id } : {}),
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

// Every new account starts fresh: no data, just the default category list
// (0 = no limit) so it's never staring at a totally empty Budgets page. They
// add more/edit/delete as needed. The actual id/name list now lives in
// lib/categories.js's CATEGORY_DEFS (imported above) — the single source
// also used by the "ensure default categories" backfill below (for existing
// accounts) and by lib/plaid-categories.js/lib/plaid-sync.js's categorizers.
const DEFAULT_CATEGORIES = CATEGORY_DEFS

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
  const { user } = useAuthUser()
  const supabase = useMemo(() => (user ? createAuthedSupabaseClient() : null), [user?.id])

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
        const email = user.email || null
        supabase.from('workspace_members').update({ name: fullName, email }).eq('user_id', user.id)
      })
    return () => { on = false }
  }, [supabase, user?.id, space?.id])

  const userId = viewAs?.id || space?.id || user?.id
  // Which user/space the UI is showing RIGHT NOW, readable from inside an
  // async fetch that started under a possibly-older render. The initial-load
  // effect below used a per-run `cancelled` flag for this, flipped by the
  // effect's cleanup — but that cleanup also fires on every unrelated
  // re-run of the effect (it depends on `state`, so the cache-hydration
  // setState, or any edit, "cancels" the in-flight fetch). The cancelled run
  // then skipped BOTH applying its data AND markLoaded(), while still having
  // committed freshFor.current — so no later run would ever fetch again and
  // the full-page loader never lifted (reproduced live: all ten Supabase
  // reads returned 200 and the app sat on "Loading your finances…" forever).
  // The only thing a finished fetch actually needs to know is whether it's
  // still for the user being shown — compare against this ref instead.
  const userIdRef = useRef(userId)
  userIdRef.current = userId

  const [state, setState] = useState(null)
  const [syncError, setSyncError] = useState(null)
  const synced = useRef(null)   // last state persisted to Supabase
  const syncing = useRef(Promise.resolve())
  const dirty = useRef(false)   // user edited since the cache was hydrated
  const freshFor = useRef(null) // userId whose data was fetched from Supabase this session
  const loadingFor = useRef(null)
  const lastLoadAt = useRef(0)  // Date.now() of the last successful initial-load pass — drives the focus/visibility refetch's staleness check below

  // ---- `loaded`: has the initial Supabase load for the CURRENT userId
  // finished (success or failure), at least once? ----
  // Drives the app shell's full-page loading gate (app/(app)/layout.jsx) so
  // the user never sees last-session's cached numbers before this session's
  // real ones land. Deliberately its own ref (everLoadedFor), not reused
  // from freshFor/loadingFor:
  //   - freshFor.current is nulled out by refetch() (Sync now / balance
  //     Refresh / the focus-staleness check) so the initial-load effect's
  //     guard lets it re-run — that's by design (it's how a background
  //     refresh happens without a page reload). If `loaded` were derived
  //     from freshFor, every one of those routine refetches would flip it
  //     back to false and re-show the full-screen loader over a page the
  //     user is actively looking at.
  //   - loadingFor.current is a similarly short-lived "fetch in flight"
  //     marker, reset to null in the same places.
  // `everLoadedFor` instead only ever records "have we, at some point,
  // finished a first load for this exact userId" and is reset to null in
  // exactly the two places that load a genuinely different dataset:
  // setSpace() and setViewAs() (both already null out `state`/synced.current
  // for the same reason). A plain refetch() never touches it, so `loaded`
  // goes true exactly once per user/space/view-as context and stays true.
  const everLoadedFor = useRef(null)
  const [loaded, setLoaded] = useState(false)
  // Marks the initial load for `id` as finished (success OR failure) —
  // called from every exit path of the initial-load effect below so a
  // failed fetch (bad network, RLS hiccup, missing migration) still flips
  // `loaded` instead of leaving the app stuck behind a spinner forever; the
  // existing syncError/cached-fallback handling in that effect is untouched.
  const markLoaded = (id) => {
    if (everLoadedFor.current !== id) { everLoadedFor.current = id; setLoaded(true) }
  }

  const CACHE = (id) => 'fin-cache-' + id
  const writeCache = (id, s) => { try { localStorage.setItem(CACHE(id), JSON.stringify(s)) } catch {} }

  // ---- instant hydration from the local cache ----
  // Still runs exactly as before — it seeds `state`/`synced.current` from
  // last session's cache immediately, before the real fetch below resolves —
  // but the app shell (app/(app)/layout.jsx) now gates what the user SEES on
  // `loaded`, not on `state` being non-null, so this hydrated copy is never
  // actually painted to the screen anymore. It's kept (rather than deferred
  // until after the load effect) because the diff-sync effect further down
  // depends on `synced.current` being populated and `dirty.current` being
  // correct the moment the user is first able to interact with the page —
  // deferring hydration would either delay that or need its own bookkeeping
  // to reproduce what this already does. It also doubles as the offline/
  // failed-fetch fallback: if the Supabase load below errors out, whatever
  // this effect already hydrated is what stays on screen once `loaded` flips
  // true (see the initial-load effect's error paths below).
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
    // true while the user/space this fetch was started for is still the one on screen
    const stillCurrent = () => userIdRef.current === userId
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
      if (err) { if (stillCurrent()) { setSyncError(err.error.message); markLoaded(userId) } return }
      // goals shipped after the other tables — if goals.sql hasn't been run yet, keep the app usable
      if (go.error && stillCurrent()) setSyncError('Goals need setup: run supabase/goals.sql in the Supabase SQL editor (' + go.error.message + ')')
      // accounts shipped after the other tables — if accounts.sql hasn't been run yet, keep the app usable
      if (acc.error && stillCurrent()) setSyncError('Accounts need setup: run supabase/accounts.sql in the Supabase SQL editor (' + acc.error.message + ')')
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
          lastLoadAt.current = Date.now()
          if (stillCurrent()) { synced.current = s; setState(s); markLoaded(userId) }
          return
        }
        // brand-new user: start fresh (default categories only, no data)
        s = freshState()
        const { error } = await supabase.from('budgets').insert(s.budgets.map((b) => mappers.budgets.toRow(b, userId)))
        if (error) { if (stillCurrent()) { setSyncError(error.message); markLoaded(userId) } return }
        // categories_v recorded up front too — a brand-new account already
        // has the full CATEGORY_DEFS set from freshState() above, so there's
        // nothing to backfill later; this just keeps the ensure-default-
        // categories step below from ever re-checking a fresh account for no
        // reason. Guarded (not just fire-and-forget like the plain sim/mSim
        // upsert this replaces) because an upsert naming a column that
        // doesn't exist yet fails as a WHOLE request in PostgREST, not just
        // for that one column — without the retry, a project that hasn't run
        // supabase/categories-v2.sql yet would silently stop writing sim/
        // mSim for every brand-new signup too.
        {
          const { error: setErr } = await supabase.from('settings').upsert({ user_id: userId, sim: s.sim, m_sim: s.mSim, categories_v: CATEGORIES_V })
          if (setErr && /categories_v/i.test(setErr.message || '')) {
            await supabase.from('settings').upsert({ user_id: userId, sim: s.sim, m_sim: s.mSim })
          }
        }
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

        // ---- ensure default categories (Phase 2A taxonomy expansion) ----
        // Existing accounts predate lib/categories.js's expanded taxonomy —
        // the owner's real data, for instance, only ever had housing/
        // groceries/auto/utilities plus one custom category. Rather than
        // leave them stuck with the old 6-category default forever, append
        // any CATEGORY_DEFS id missing from this account's budgets, with
        // limit 0 (same "no limit yet, user sets it" convention every
        // default category already uses) — but only ONCE per account,
        // gated by settings.categories_v, so a default category the user
        // later deletes on purpose doesn't silently reappear on the next
        // load. viewAs (impersonating) already returned early above and
        // never reaches here — support mode stays strictly read-only.
        //
        // TRADEOFF while supabase/categories-v2.sql hasn't been run yet:
        // settings.categories_v doesn't exist, so `currentV` below reads as
        // 0 forever and this block re-runs every load — harmless on its own
        // (missing ids are only inserted once; re-running finds nothing
        // missing the second time), but a category a user deletes in that
        // window WOULD come back on the next load, since there's no flag to
        // remember the deletion was deliberate. This is called out here and
        // in the SQL file's own comment rather than silently accepted.
        const currentV = se.data?.categories_v || 0
        if (currentV < CATEGORIES_V) {
          const haveIds = new Set(s.budgets.map((b) => b.id))
          const missing = CATEGORY_DEFS.filter(([id]) => !haveIds.has(id))
          if (missing.length) {
            const newBudgets = missing.map(([id, name], i) => ({ id, name, limit: 0, position: s.budgets.length + i }))
            s.budgets = [...s.budgets, ...newBudgets]
            const { error: insErr } = await supabase.from('budgets').insert(newBudgets.map((b) => mappers.budgets.toRow(b, userId)))
            if (insErr) console.warn('[store] ensure-default-categories: inserting missing default categories failed:', insErr.message)
          }
          const { error: vErr } = await supabase.from('settings').upsert({ user_id: userId, categories_v: CATEGORIES_V })
          if (vErr && /categories_v/i.test(vErr.message || '')) {
            console.warn('[store] settings.categories_v column missing — run supabase/categories-v2.sql. New default categories will keep re-checking on every load until then.')
          } else if (vErr) {
            console.warn('[store] ensure-default-categories: recording categories_v failed:', vErr.message)
          }
        }
      }
      freshFor.current = userId
      lastLoadAt.current = Date.now()
      if (!viewAs) writeCache(userId, s)
      // don't clobber edits the user made on top of the cached copy while we fetched
      if (stillCurrent()) {
        if (!dirty.current) { synced.current = s; setState(s) }
        markLoaded(userId) // the load itself succeeded regardless of the dirty-edit guard above
      }
    })().catch((e) => { if (stillCurrent()) { setSyncError(String(e?.message || e)); markLoaded(userId) } })
      .finally(() => { if (loadingFor.current === userId) loadingFor.current = null })
    // No cleanup: this effect re-runs on every `state` change and a cleanup
    // here used to "cancel" the in-flight fetch for reasons that had nothing
    // to do with the user changing (see userIdRef above). The fetch guards
    // itself with stillCurrent() instead.
  }, [supabase, userId, state])

  // ---- manual refetch (Sync now / balance Refresh / focus-staleness below) ----
  // Re-runs the initial-load effect above without clearing anything the user
  // already sees — unlike setSpace()/setViewAs(), this deliberately leaves
  // `state` and `synced.current` alone (no flash to a blank/loading screen)
  // and, crucially, does NOT null out `synced.current`. Nulling it would make
  // the debounced diff-sync effect below go quiet (its `!synced.current`
  // guard bails out) until the fetch below resolves — and if the user has an
  // unsynced edit in flight (dirty.current), that resolution deliberately
  // skips overwriting `synced.current` (see the initial-load effect's own
  // "don't clobber edits" guard), which would leave `synced.current` null
  // forever and silently stop that edit (and everything after it) from ever
  // reaching Supabase. Only resetting freshFor/loadingFor — and nudging
  // `state` to a new (but content-identical) reference so the initial-load
  // effect's dependency array actually re-fires — sidesteps that: the
  // debounced diff-sync effect still runs off the *same* synced.current
  // baseline it always did, so a genuine pending edit keeps syncing normally
  // while a fresh pull replaces `state` once it lands (or is skipped
  // entirely if `dirty.current` is true, exactly like a page-load race).
  const refetch = () => {
    if (!supabase || !userId) return
    freshFor.current = null
    loadingFor.current = null
    setState((s) => (s ? { ...s } : s))
  }

  // ---- auto-refresh on tab focus/visibility ----
  // Nothing else in this file ever refetches once loaded (no polling, no
  // realtime) — a tab left open for hours shows hours-stale data. When the
  // tab regains focus/visibility and the last successful load is stale
  // (>60s), nudge a refetch. Throttled two ways: the staleness check itself
  // (a tab that's been visible/focused the whole time won't re-trigger), and
  // loadingFor.current (won't stack a second refetch on top of one already
  // in flight).
  useEffect(() => {
    if (!userId) return
    const STALE_MS = 60000
    const maybeRefetch = () => {
      if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
      if (loadingFor.current === userId) return
      if (Date.now() - lastLoadAt.current < STALE_MS) return
      refetch()
    }
    document.addEventListener('visibilitychange', maybeRefetch)
    window.addEventListener('focus', maybeRefetch)
    return () => {
      document.removeEventListener('visibilitychange', maybeRefetch)
      window.removeEventListener('focus', maybeRefetch)
    }
  }, [userId])

  // ---- debounced diff sync ----
  // Chunk size for delete id lists (see DELETE_CHUNK below) — this used to be
  // one giant `.in('id', [...allIds])` per table. Fine for a handful of rows,
  // but a real account's transactions table can run into the hundreds or
  // thousands: that turns into a querystring PostgREST/the underlying fetch
  // rejects outright, so the delete for that table fails every single pass.
  // Chunking keeps every request's id list small and bounded regardless of
  // how much history an account has.
  const DELETE_CHUNK = 100
  useEffect(() => {
    if (viewAs) return // read-only while viewing another customer
    if (!state || !synced.current || state === synced.current || !supabase) return
    const t = setTimeout(() => {
      const prev = synced.current
      const next = state
      // chain syncs so they never interleave
      syncing.current = syncing.current.then(async () => {
        // Tables that hit a real (non-optional) error THIS pass — collected,
        // not thrown, so one table's failure (huge id list, transient
        // network blip, RLS hiccup, whatever) can never abort every table
        // queued after it. This is exactly what used to strand 'debts' rows
        // in Supabase: 'transactions' failing used to `throw`, which skipped
        // 'debts' entirely (it's near the end of the delete-order list) —
        // the local state still went empty, so the owner saw a "successful"
        // erase while the DB kept every row. See app/api/account/erase's
        // comment for the full account of that bug and its real fix (a
        // server-side wipe with no id lists at all); this hardening is the
        // second line of defense so the same failure mode can't silently
        // strand data through ordinary editing either.
        const failedTables = []
        try {
          const prevRows = stateRows(prev, userId)
          const nextRows = stateRows(next, userId)
          // DB table names (snake_case) -> stateRows keys (camelCase). Looking
          // up prevRows['account_tags'] directly returns undefined and crashes
          // the whole sync pass with "Cannot read properties of undefined
          // (reading 'map')" — every save silently dies, nothing persists.
          const rowsKey = (table) => ({ account_tags: 'accountTags', account_colors: 'accountColors' }[table] || table)
          // deletes first for payments (FK), debts last so payment FKs stay valid.
          // account_tags/account_colors have no FK relationship to anything else in
          // this list, so their position doesn't matter — they're last purely for
          // readability.
          for (const table of ['payments', 'transactions', 'budgets', 'recurring', 'goals', 'accounts', 'debts', 'account_tags', 'account_colors']) {
            const { deletes } = diffRows(prevRows[rowsKey(table)], nextRows[rowsKey(table)])
            if (!deletes.length) continue
            // Chunked: an id list of any size becomes N bounded requests
            // instead of one unbounded one. A chunk failure stops only THIS
            // table's remaining chunks this pass (`break`) — synced.current
            // won't advance below, so the next pass re-diffs from the same
            // unchanged prev/next and retries the table's FULL delete list
            // (already-deleted ids just no-op, harmless).
            for (let i = 0; i < deletes.length; i += DELETE_CHUNK) {
              const chunk = deletes.slice(i, i + DELETE_CHUNK)
              const { error } = await supabase.from(table).delete().eq('user_id', userId).in('id', chunk)
              if (error) {
                // account_tags/account_colors may not be migrated yet — don't let
                // that abort every other table's sync this pass (see
                // OPTIONAL_TABLES above).
                if (OPTIONAL_TABLES.has(table)) { console.warn(`[store] ${table} delete skipped:`, error.message); break }
                console.warn(`[store] ${table} delete failed:`, error.message)
                failedTables.push(table)
                break
              }
            }
          }
          for (const table of ['debts', 'payments', 'budgets', 'recurring', 'transactions', 'goals', 'accounts', 'account_tags', 'account_colors']) {
            const { upserts } = diffRows(prevRows[rowsKey(table)], nextRows[rowsKey(table)])
            if (!upserts.length) continue
            const { error } = await supabase.from(table).upsert(upserts, { onConflict: 'user_id,id' })
            if (error) {
              if (OPTIONAL_TABLES.has(table)) { console.warn(`[store] ${table} upsert skipped:`, error.message); continue }
              console.warn(`[store] ${table} upsert failed:`, error.message)
              failedTables.push(table)
            }
          }
          if (JSON.stringify(prev.sim) !== JSON.stringify(next.sim) || JSON.stringify(prev.mSim) !== JSON.stringify(next.mSim)) {
            const { error } = await supabase.from('settings').upsert({ user_id: userId, sim: next.sim, m_sim: next.mSim })
            if (error) { console.warn('[store] settings upsert failed:', error.message); failedTables.push('settings') }
          }
          if (failedTables.length) {
            // Partial success: leave synced.current/the cache exactly as they
            // were (do NOT advance) so the next debounced pass re-diffs from
            // the SAME prev and retries every table — including this one —
            // rather than quietly giving up on whatever didn't make it this
            // time. Naming the table(s) in syncError instead of a generic
            // message is what makes it possible to tell "still retrying X"
            // apart from "totally stuck" at a glance.
            setSyncError(`Couldn't sync ${[...new Set(failedTables)].join(', ')} — will retry`)
            return
          }
          synced.current = next
          writeCache(userId, next)
          setSyncError(null)
          // Clear the "unsynced edit" flag update() sets on every local
          // mutation — but only if nothing changed further while this write
          // was in flight (checked against the live state via the functional
          // updater, not the `next` snapshot this closure captured, since a
          // newer edit could have landed during the awaits above). Needed for
          // refetch() (Sync now / balance Refresh / focus-staleness): its
          // "don't clobber a pending edit" guard reuses this same
          // dirty.current flag, which — before this reset — never went back
          // to false once set, so any edit ever made this session would
          // silently block every future refetch from ever applying fresh
          // data. Left exactly as it was before if a newer edit did land
          // (dirty.current stays true; that edit gets its own debounced pass).
          setState((current) => { if (current === next) dirty.current = false; return current })
        } catch (e) {
          // Unexpected exception (not a `{error}` result) — same "don't
          // advance synced.current" safety as the partial-failure path above.
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
    // A genuinely different dataset is about to load (the impersonated
    // customer's, or back to the admin's own) — reset the loading gate so
    // the full-page loader (app/(app)/layout.jsx) shows again instead of
    // flashing whatever the old context's rows were. See everLoadedFor's
    // definition above for why this is the only place (besides setSpace)
    // that resets it.
    everLoadedFor.current = null
    setLoaded(false)
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
    // Same reasoning as setViewAs above: a different space's rows are about
    // to load, so show the full-page loader again instead of the previous
    // space's numbers.
    everLoadedFor.current = null
    setLoaded(false)
    setState(null)
    setSyncError(null)
    setSpaceState(info)
  }

  const createSpace = async (name) => {
    const id = 'ws_' + Math.random().toString(36).slice(2, 12)
    const { error } = await supabase.from('workspaces').insert({ id, name, owner_id: user.id })
    if (error) return { error: error.message }
    const fullName = user.fullName || [user.firstName, user.lastName].filter(Boolean).join(' ') || null
    const email = user.email || null
    const { error: e2 } = await supabase.from('workspace_members').insert({ workspace_id: id, user_id: user.id, name: fullName, email })
    if (e2) return { error: e2.message }
    const info = { id, name }
    setSpaces((s) => [...s, { ...info, ownerId: user.id }])
    setSpace(info)
    // id/name returned (not just {ok:true}) so a caller that creates a space
    // and immediately needs to act on it — e.g. Settings' "Convert my
    // personal space into a shared space" — doesn't have to guess the
    // freshly-generated id back out of local state.
    return { ok: true, id, name }
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
    const email = user.email || null
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

  // Owner-only, permanent: wipes a shared space's entire data footprint —
  // every table any slice lives in, scoped by user_id === spaceId, exactly
  // the tables stateRows()/the diff-sync effect above already know how to
  // read/write — plus its bank connections, membership rows, and the
  // workspace row itself. Settings' "Delete space" (views/Settings.jsx) is
  // the only caller; DeleteSpaceDialog (space-name-dialog.jsx) requires
  // typing the space's exact name before this ever runs.
  //
  // Table order mirrors TRANSFER_DELETE_ORDER below (payments/transactions/
  // etc. before debts, so the debts->payments FK never blocks a delete) —
  // though it barely matters here since every one of these tables' own rows
  // eventually vanish anyway once the workspace row cascades away; explicit
  // per-table deletes are still done first, while the caller is a confirmed
  // member, so the RLS "own rows"/is_member() policies (collab.sql,
  // accounts.sql, goals.sql, etc.) are guaranteed to allow it.
  const DELETE_SPACE_TABLES = ['payments', 'transactions', 'budgets', 'recurring', 'goals', 'accounts', 'debts', 'account_tags', 'account_colors']

  const deleteSpace = async (spaceId) => {
    if (viewAs) return { error: 'Not available while viewing another customer' }
    if (!supabase || !user?.id) return { error: 'Not signed in' }
    const sp = spaces.find((s) => s.id === spaceId)
    if (!sp) return { error: 'Space not found' }
    if (sp.ownerId !== user.id) return { error: 'Only the space owner can delete this space' }

    // Switch back to Personal FIRST if this space is the active view — resets
    // synced/freshFor/dirty/state (same reset shape setSpace() always uses)
    // so the debounced diff-sync effect above can't race a write against a
    // space that's about to be gone.
    if (space?.id === spaceId) setSpace(null)

    try {
      // 1. Wipe every data table scoped to this space's id. account_tags/
      //    account_colors are the newest tables (may not be migrated on an
      //    older project — see OPTIONAL_TABLES above) and skip-and-warn
      //    rather than aborting; every other table here is core data and a
      //    failure aborts the whole delete (nothing else has been removed
      //    yet, so it's safely retryable).
      for (const table of DELETE_SPACE_TABLES) {
        const { error } = await supabase.from(table).delete().eq('user_id', spaceId)
        if (error) {
          if (OPTIONAL_TABLES.has(table)) { console.warn(`[deleteSpace] ${table} skipped:`, error.message); continue }
          return { error: `Couldn't delete ${table}: ${error.message}` }
        }
      }
      // settings (sim/mSim) is a single row keyed by user_id alone — best
      // effort, not core financial data, so its own failure doesn't abort.
      const { error: settingsErr } = await supabase.from('settings').delete().eq('user_id', spaceId)
      if (settingsErr) console.warn('[deleteSpace] settings skipped:', settingsErr.message)

      // 2. Bank connections are service-role only (RLS, no policies — see
      //    plaid.sql) — hand off to the dedicated API route, same pattern as
      //    "Move my data into this space" (app/api/plaid/transfer). Reported
      //    back as a non-fatal warning: the space itself still gets deleted.
      let bankError = null
      try {
        const res = await fetch('/api/plaid/items', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workspace_id: spaceId }),
        })
        const data = await res.json().catch(() => ({}))
        if (!res.ok) bankError = data.error || 'Failed to disconnect bank connections'
      } catch (e) {
        bankError = e?.message || 'Failed to disconnect bank connections'
      }

      // 3. Delete the workspace row itself — cascades (on delete cascade,
      //    see collab.sql) to workspace_members and workspace_invites
      //    automatically; FK referential-integrity actions always bypass
      //    RLS, so no extra delete policy is needed on those two tables.
      //    Requires the "owner delete" policy from
      //    supabase/workspace-delete.sql — without it this update is
      //    silently rejected (0 rows affected, no error) by RLS, same
      //    footgun workspace-rename.sql already documented for renames.
      const { error: delErr } = await supabase.from('workspaces').delete().eq('id', spaceId)
      if (delErr) return { error: `Couldn't delete the space: ${delErr.message}`, bankError }

      // 4. Local cleanup: drop it from the spaces list and clear its cache.
      setSpaces((s) => s.filter((x) => x.id !== spaceId))
      try { localStorage.removeItem(CACHE(spaceId)) } catch {}

      return { ok: true, bankError }
    } catch (e) {
      return { error: e?.message || 'Failed to delete the space' }
    }
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

    const sourceId = user.id
    const allTables = [...CORE_TRANSFER_TABLES, ...OPTIONAL_TRANSFER_TABLES]

    try {
      // Membership check against Supabase directly, not the local `spaces`
      // state array: a caller that just created the target space (Settings'
      // "Convert my personal space into a shared space") calls this in the
      // same tick as `createSpace()`'s `setSpaces(...)` — that state update
      // hasn't re-rendered yet, so the `transferPersonalDataToSpace` closure
      // in scope at call time still holds the *old* `spaces` array without
      // the brand-new space in it. Checking real membership in the DB avoids
      // a false "you're not a member of that space" for a space the caller
      // just created (and is, in fact, a real member of).
      const { data: membership, error: memErr } = await supabase
        .from('workspace_members').select('workspace_id')
        .eq('workspace_id', targetSpaceId).eq('user_id', sourceId).maybeSingle()
      if (memErr) return { error: `Couldn't verify your membership in that space: ${memErr.message}` }
      if (!membership) return { error: "You're not a member of that space" }

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

  // "Erase all data" (views/Settings.jsx's Danger zone) — ONE store write that
  // puts every synced slice back to a brand-new account's shape. Deliberately
  // restores DEFAULT_CATEGORIES instead of an empty budgets array: those rows
  // double as the app's category list (see catInfo below and
  // Transactions.jsx's "+ Add category"), so wiping them would leave a
  // "fresh" account with no categories at all — worse off than a real new
  // signup. Also covers the slices the old inline version in Settings.jsx
  // missed (accountTags, accountColors, sim, mSim). Bank connections live in
  // plaid_items, not in `state`, so the caller disconnects those separately.
  //
  // Historically this was the ENTIRE erase: emptying every array here left
  // the debounced diff-sync effect above to notice every previously-synced
  // id was now missing and issue the real Supabase `DELETE`s. That's exactly
  // what stranded rows in production (see app/api/account/erase's comment
  // for the full postmortem: a huge `.in(id, [...])` list failing for one
  // table `throw`s and aborts every table queued after it in the same pass —
  // 'debts' sits near the end of that loop, so the owner's credit cards
  // never actually got deleted, just hidden until the next reload pulled
  // them back from Supabase). Erasing now goes through that server route
  // FIRST as the authoritative wipe; this plain form is kept around for
  // anything that still wants "just clear local state and let the normal
  // diff-sync pick up the deletes" (nothing else calls it today, but no
  // reason to force every future caller through the server round-trip too).
  // The Danger zone flow itself uses resetAllDataAlreadySynced below instead.
  const resetAllData = () => {
    if (viewAs) return // support mode is strictly read-only
    dirty.current = true
    setState(() => freshState())
  }

  // Used by Settings' Danger zone AFTER app/api/account/erase has already
  // wiped Supabase directly (no id-list diffing, so no size limit and no
  // one-table-failure-aborts-everything problem — see that route's comment).
  // Unlike resetAllData() above, this marks the fresh state as if it were
  // already the last-synced snapshot: sets `synced.current` to it (not just
  // local `state`), clears `dirty.current`, and overwrites the localStorage
  // cache directly, instead of leaving that to the diff-sync effect's own
  // `writeCache` call.
  //
  // Why that matters: resetAllData() alone would still leave `state !==
  // synced.current` (synced.current is still the OLD, full pre-erase
  // snapshot), so the debounced diff-sync effect fires on the very next
  // render and issues a second, now-redundant `DELETE ... WHERE id IN (...)`
  // pass for rows the server route already removed. Harmless on its own
  // (deleting an already-gone row is a no-op), but noisy, and — more
  // importantly — it means `synced.current`/the cache only become
  // consistent with the empty state once that debounced pass finishes a few
  // hundred milliseconds later; a reload (or this same tab losing network)
  // in that window would hydrate from the STALE cache via the instant-
  // hydration effect above and briefly show the old rows again. Setting
  // `synced.current`/the cache to the fresh state right here, synchronously,
  // closes that window entirely: state === synced.current on the very next
  // render, so the diff-sync effect's own `state === synced.current` guard
  // skips it outright — no diff generated at all, nothing left to strand.
  const resetAllDataAlreadySynced = () => {
    if (viewAs) return // support mode is strictly read-only
    const fresh = freshState()
    dirty.current = false
    synced.current = fresh
    if (userId) writeCache(userId, fresh)
    setState(fresh)
  }

  const api = useMemo(() => ({
    state,
    loaded, // true once the initial Supabase load for the current userId has finished (success or failure) — see everLoadedFor above
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
    deleteSpace, // owner-only permanent space delete — see definition above
    transferPersonalDataToSpace, // "Move my data into this space" — see definition above
    refetch, // force a fresh pull from Supabase without a page reload — see definition above
    resetAllData, // generic "clear local state, let the diff-sync delete" — see definition above
    resetAllDataAlreadySynced, // Danger zone "Erase all data", used AFTER the server wipe — see definition above
    // update(fn): fn receives a deep clone, mutates freely, returns nothing
    // no-op while viewing another customer — support mode is strictly read-only
    update: viewAs
      ? () => {}
      : (fn) => { dirty.current = true; setState((s) => { const c = JSON.parse(JSON.stringify(s)); if (!c.goals) c.goals = []; if (!c.accounts) c.accounts = []; if (!c.accountTags) c.accountTags = []; if (!c.accountColors) c.accountColors = []; fn(c); normalize(c); return c }) },
    catInfo: (id) => state?.budgets.find((b) => b.id === id) || ({ debt: { name: 'Debt Payment' }, income: { name: 'Income' }, transfer: { name: 'Transfer' }, refund: { name: 'Refund' } }[id]) || { name: id || 'Other' },
    uid,
  }), [state, loaded, syncError, viewAs, space, spaces])

  return <Ctx.Provider value={api}>{children}</Ctx.Provider>
}

export const useApp = () => useContext(Ctx)

// ---- shared selectors ----
export const monthTx = (state, ym) => state.transactions.filter((t) => t.date.startsWith(ym))
export const rangeTx = (state, from, to) => state.transactions.filter((t) => t.date >= from && t.date <= to)
// 'refund' (merchant refund/return credited to a credit card — see
// lib/plaid-sync.js's classifyTx()) is type:'income' but, like 'transfer',
// isn't real income — excluded from every income total the same way
// 'transfer' already was. Every other `cat !== 'transfer'` filter across
// Dashboard/Charts/Simulator/Recurring/Admin/Transactions got the same
// 'refund' exclusion added alongside it.
export const incomeIn = (state, ym) => monthTx(state, ym).filter((t) => t.type === 'income' && t.cat !== 'transfer' && t.cat !== 'refund').reduce((s, t) => s + t.amount, 0)
export const expensesIn = (state, ym) => monthTx(state, ym).filter((t) => t.type === 'expense' && t.cat !== 'transfer').reduce((s, t) => s + t.amount, 0)
export const spentIn = (state, ym, cat) => monthTx(state, ym).filter((t) => t.type === 'expense' && t.cat === cat).reduce((s, t) => s + t.amount, 0)
export const dataMonths = (state) => [...new Set(state.transactions.filter((t) => t.cat !== 'transfer' && t.cat !== 'refund').map((t) => t.date.slice(0, 7)))].sort().reverse()
