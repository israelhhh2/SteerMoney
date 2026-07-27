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
    toRow: (x, userId) => ({
      user_id: userId, id: x.id, description: x.desc, amount: x.amount,
      due_day: x.dueDay ?? null, category: x.cat ?? 'other', active: x.active !== false,
      every_n_months: x.every ?? 1, position: x.position ?? 0,
    }),
    fromRow: (r) => ({
      id: r.id, desc: r.description, amount: Number(r.amount), dueDay: r.due_day,
      cat: r.category, active: r.active, position: r.position ?? 0,
      ...(r.every_n_months > 1 ? { every: r.every_n_months } : {}),
    }),
  },
  transactions: {
    toRow: (t, userId) => ({
      user_id: userId, id: t.id, date: t.date, description: t.desc,
      amount: t.amount, type: t.type, category: t.cat ?? 'other',
    }),
    fromRow: (r) => ({ id: r.id, date: r.date, desc: r.description, amount: Number(r.amount), type: r.type, cat: r.category }),
  },
}

// Every new account starts fresh: no data, just the default category list
// (0 = no limit) so transaction categorization and imports work out of the box.
const DEFAULT_CATEGORIES = [
  ['housing', 'Housing / Rent'], ['auto', 'Car & Gas'], ['groceries', 'Groceries'],
  ['dining', 'Dining Out'], ['shopping', 'Shopping'], ['utilities', 'Utilities & Phone'],
  ['subscriptions', 'Subscriptions'], ['entertainment', 'Entertainment'], ['kids', 'Kids'],
  ['family', 'Family & Zelle'], ['personal', 'Personal Care'], ['household', 'House Things'],
  ['cash', 'Cash & ATM'], ['other', 'Other'],
]

function freshState() {
  return {
    debts: [],
    budgets: DEFAULT_CATEGORIES.map(([id, name], i) => ({ id, name, limit: 0, position: i })),
    transactions: [],
    recurring: [],
    sim: { budget: 0, strategy: 'avalanche', snowExtra: 0 },
    mSim: { income: '', items: [] },
  }
}

// Give every row an id so it can be diffed/synced (pages create items without ids).
function normalize(s) {
  s.debts.forEach((d, i) => {
    if (!d.id) d.id = uid('d')
    d.position = i
    if (!d.payments) d.payments = []
    d.payments.forEach((p) => { if (!p.id) p.id = uid('p') })
  })
  s.budgets.forEach((b, i) => { if (!b.id) b.id = uid('b'); b.position = i })
  s.recurring.forEach((r, i) => { if (!r.id) r.id = uid('r'); r.position = i })
  s.transactions.forEach((t) => { if (!t.id) t.id = uid('tx') })
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
  }
}

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
  const userId = viewAs?.id || user?.id

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
      const [de, pa, bu, re, tx, se] = await Promise.all([
        supabase.from('debts').select('*').eq('user_id', userId).order('position'),
        supabase.from('payments').select('*').eq('user_id', userId).order('date', { ascending: false }),
        supabase.from('budgets').select('*').eq('user_id', userId).order('position'),
        supabase.from('recurring').select('*').eq('user_id', userId).order('position'),
        supabase.from('transactions').select('*').eq('user_id', userId).order('date', { ascending: false }),
        supabase.from('settings').select('*').eq('user_id', userId).maybeSingle(),
      ])
      const err = [de, pa, bu, re, tx, se].find((r) => r.error)
      if (err) { if (!cancelled) setSyncError(err.error.message); return }

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
          // deletes first for payments (FK), debts last so payment FKs stay valid
          for (const table of ['payments', 'transactions', 'budgets', 'recurring', 'debts']) {
            const { deletes } = diffRows(prevRows[table], nextRows[table])
            if (deletes.length) {
              const { error } = await supabase.from(table).delete().eq('user_id', userId).in('id', deletes)
              if (error) throw error
            }
          }
          for (const table of ['debts', 'payments', 'budgets', 'recurring', 'transactions']) {
            const { upserts } = diffRows(prevRows[table], nextRows[table])
            if (upserts.length) {
              const { error } = await supabase.from(table).upsert(upserts, { onConflict: 'user_id,id' })
              if (error) throw error
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

  const api = useMemo(() => ({
    state,
    syncError,
    viewingAs: viewAs,                     // {id, name} while impersonating, else null
    setViewAs,
    exitViewAs: () => setViewAs(null),
    // update(fn): fn receives a deep clone, mutates freely, returns nothing
    // no-op while viewing another customer — support mode is strictly read-only
    update: viewAs
      ? () => {}
      : (fn) => { dirty.current = true; setState((s) => { const c = JSON.parse(JSON.stringify(s)); fn(c); normalize(c); return c }) },
    catInfo: (id) => state?.budgets.find((b) => b.id === id) || ({ debt: { name: 'Debt Payment' }, income: { name: 'Income' }, transfer: { name: 'Transfer' } }[id]) || { name: id || 'Other' },
    uid,
  }), [state, syncError, viewAs])

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
