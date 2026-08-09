'use client'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useAuthUser } from '@/components/auth-provider'
import { ChevronRight, CreditCard, Eye, Loader2, MessageCircle, Receipt, ShieldCheck, TrendingUp, Users } from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Kpi } from '@/components/shared'
import { createAuthedSupabaseClient } from '@/lib/supabase'
import { useIsAdmin } from '@/lib/useIsAdmin'
import { useApp } from '@/store'
import { fmt, fmt0, prettyDate } from '@/lib/utils'

// average monthly income from a user's transactions (transfers excluded)
function avgIncome(tx) {
  const byM = {}
  tx.forEach((t) => { if (t.type === 'income' && t.category !== 'transfer') byM[t.date.slice(0, 7)] = (byM[t.date.slice(0, 7)] || 0) + Number(t.amount) })
  const months = Object.values(byM)
  return months.length ? months.reduce((a, b) => a + b, 0) / months.length : 0
}

export default function Admin() {
  const { user } = useAuthUser()
  const router = useRouter()
  const isAdmin = useIsAdmin()
  const { setViewAs } = useApp()
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [open, setOpen] = useState(null)
  const [feedback, setFeedback] = useState(null)
  const [feedbackErr, setFeedbackErr] = useState(null)

  const viewAsCustomer = (c) => {
    setViewAs({ id: c.id, name: c.info?.name || c.info?.email || c.id.slice(0, 12) })
    router.push('/')
  }

  useEffect(() => {
    if (!user || !isAdmin) return
    let on = true
    ;(async () => {
      try {
        const sb = createAuthedSupabaseClient()
        const [de, bu, re, tx, dir, ws] = await Promise.all([
          sb.from('debts').select('user_id,name,balance,min_payment,credit_limit'),
          sb.from('budgets').select('user_id,name,monthly_limit'),
          sb.from('recurring').select('user_id,description,amount,active,every_n_months'),
          sb.from('transactions').select('user_id,date,description,amount,type,category').order('date', { ascending: false }),
          fetch('/api/admin/users').then((r) => (r.ok ? r.json() : { users: [] })),
          sb.from('workspaces').select('id,name'), // tolerated if collab.sql isn't applied yet
        ])
        const bad = [de, bu, re, tx].find((r) => r.error)
        if (bad) throw new Error(bad.error.message)
        if (on) setData({ debts: de.data, budgets: bu.data, recurring: re.data, transactions: tx.data, dir: dir.users || [], workspaces: ws.data || [] })
      } catch (e) { if (on) setErr(String(e?.message || e)) }
    })()
    return () => { on = false }
  }, [user?.id, isAdmin])

  // Read-only feedback/bug inbox — separate fetch since it's server-gated
  // (public.feedback has RLS with no policies at all, so only the
  // service-role-backed /api/feedback/list route can read it, not the
  // client Supabase call above).
  useEffect(() => {
    if (!isAdmin) return
    let on = true
    ;(async () => {
      try {
        const res = await fetch('/api/feedback/list')
        const d = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(d?.error || 'Failed to load feedback')
        if (on) setFeedback(d.feedback || [])
      } catch (e) { if (on) setFeedbackErr(String(e?.message || e)) }
    })()
    return () => { on = false }
  }, [isAdmin])

  const customers = useMemo(() => {
    if (!data) return []
    const ids = new Set([
      ...data.dir.map((u) => u.id),
      ...data.debts.map((r) => r.user_id), ...data.budgets.map((r) => r.user_id),
      ...data.recurring.map((r) => r.user_id), ...data.transactions.map((r) => r.user_id),
    ])
    return [...ids].map((id) => {
      const info = data.dir.find((u) => u.id === id)
      const ws = data.workspaces.find((w) => w.id === id)
      const debts = data.debts.filter((r) => r.user_id === id)
      const budgets = data.budgets.filter((r) => r.user_id === id)
      const recurring = data.recurring.filter((r) => r.user_id === id)
      const tx = data.transactions.filter((r) => r.user_id === id)
      return {
        id, info, ws, debts, budgets, recurring, tx,
        debtTotal: debts.reduce((s, d) => s + Number(d.balance), 0),
        budgetTotal: budgets.reduce((s, b) => s + Number(b.monthly_limit), 0),
        income: avgIncome(tx),
        lastTx: tx[0]?.date || null,
      }
    }).sort((a, b) => b.debtTotal - a.debtTotal)
  }, [data])

  if (!isAdmin) {
    return (
      <Card className="p-10 text-center text-sm text-muted-foreground">
        <ShieldCheck className="mx-auto mb-2 h-6 w-6" />
        This page is for administrators only. If that's you, run <code className="text-foreground">supabase/admin.sql</code> in the Supabase SQL Editor first.
      </Card>
    )
  }
  if (err) return <Card className="p-6 text-sm text-red-400">Couldn't load admin data: {err}</Card>
  if (!data) {
    return (
      <div className="flex items-center justify-center gap-2 py-24 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading all customers…
      </div>
    )
  }

  return (
    <div className="fade-in space-y-6">
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Customers" value={customers.length} icon={Users} />
        <Kpi label="Total Debt (all)" value={fmt0(customers.reduce((s, c) => s + c.debtTotal, 0))} icon={CreditCard} tone="text-red-400" />
        <Kpi label="Income / mo (all)" value={fmt0(customers.reduce((s, c) => s + c.income, 0))} icon={TrendingUp} tone="text-emerald-400" sub="avg monthly, per transactions" />
        <Kpi label="Transactions (all)" value={data.transactions.length.toLocaleString()} icon={Receipt} />
      </div>

      <Card className="overflow-hidden">
        <div className="border-b bg-secondary/40 px-4 py-2.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground">
          Customers · tap a row for details
        </div>
        <div className="divide-y divide-border/60">
          {customers.map((c) => (
            <div key={c.id}>
              <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 text-left transition hover:bg-secondary/30" onClick={() => setOpen(open === c.id ? null : c.id)}>
                <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform ${open === c.id ? 'rotate-90' : ''}`} />
                {c.info?.image
                  ? <img src={c.info.image} alt="" className="h-7 w-7 shrink-0 rounded-full" />
                  : <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-secondary text-[0.6875rem] font-bold">{(c.info?.name || c.id).slice(0, 1).toUpperCase()}</span>}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[0.8125rem] font-medium">
                    {c.info?.name || c.ws?.name || 'Unknown user'}
                    {c.id === user?.id && <Badge className="ml-2">you</Badge>}
                    {c.ws && <Badge className="ml-2">shared space</Badge>}
                  </div>
                  <div className="truncate text-[0.6875rem] text-muted-foreground">{c.info?.email || (c.ws ? 'Collaborative finances' : c.id)}</div>
                </div>
                <span className="hidden shrink-0 text-[0.6875rem] text-muted-foreground md:inline">{c.tx.length} txns{c.lastTx ? ` · last ${prettyDate(c.lastTx)}` : ''}</span>
                <span className="shrink-0 text-right">
                  <span className="block text-[0.8125rem] font-semibold text-emerald-400">{fmt0(c.income)}<span className="text-[0.625rem] font-normal text-muted-foreground">/mo</span></span>
                  <span className="block text-[0.625rem] text-muted-foreground">income</span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[0.8125rem] font-semibold text-red-400">{fmt0(c.debtTotal)}</span>
                  <span className="block text-[0.625rem] text-muted-foreground">{c.debts.length} debts</span>
                </span>
                <span className="w-24 shrink-0 text-right">
                  <span className="block text-[0.8125rem] font-semibold">{fmt0(c.budgetTotal)}<span className="text-[0.625rem] font-normal text-muted-foreground">/mo</span></span>
                  <span className="block text-[0.625rem] text-muted-foreground">{c.budgets.length} budgets</span>
                </span>
                <span
                  role="button"
                  title="See the app exactly as this customer sees it (read-only)"
                  className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md border border-border bg-transparent px-2.5 text-xs font-medium shadow-sm transition-colors hover:bg-accent"
                  onClick={(e) => { e.stopPropagation(); viewAsCustomer(c) }}
                >
                  <Eye className="h-3.5 w-3.5" />View as
                </span>
              </button>

              {open === c.id && (
                <div className="fade-in grid gap-3 border-t border-border/60 bg-secondary/20 px-4 py-4 lg:grid-cols-3">
                  <div>
                    <div className="mb-1.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground">Budgets</div>
                    <div className="divide-y divide-border/40">
                      {c.budgets.length ? c.budgets.map((b, i) => (
                        <div key={i} className="flex justify-between gap-2 py-1 text-[0.75rem]">
                          <span className="min-w-0 flex-1 truncate text-foreground/85">{b.name}</span>
                          <span className="shrink-0 font-medium">{fmt0(Number(b.monthly_limit))}<span className="text-muted-foreground">/mo</span></span>
                        </div>
                      )) : <p className="py-1 text-[0.6875rem] text-muted-foreground">None</p>}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground">Debts</div>
                    <div className="divide-y divide-border/40">
                      {c.debts.length ? c.debts.slice().sort((a, b) => b.balance - a.balance).map((d, i) => (
                        <div key={i} className="flex justify-between gap-2 py-1 text-[0.75rem]">
                          <span className="min-w-0 flex-1 truncate text-foreground/85">{d.name}</span>
                          <span className="shrink-0 font-medium text-red-400">{fmt0(Number(d.balance))}</span>
                        </div>
                      )) : <p className="py-1 text-[0.6875rem] text-muted-foreground">None</p>}
                    </div>
                  </div>
                  <div>
                    <div className="mb-1.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground">Recent transactions</div>
                    <div className="divide-y divide-border/40">
                      {c.tx.length ? c.tx.slice(0, 8).map((t, i) => (
                        <div key={i} className="flex items-center gap-2 py-1 text-[0.75rem]">
                          <span className="w-10 shrink-0 text-[0.625rem] text-muted-foreground">{prettyDate(t.date)}</span>
                          <span className="min-w-0 flex-1 truncate text-foreground/85">{t.description}</span>
                          <span className={`shrink-0 font-medium ${t.type === 'income' ? 'text-emerald-400' : ''}`}>{t.type === 'income' ? '+' : '−'}{fmt(Number(t.amount))}</span>
                        </div>
                      )) : <p className="py-1 text-[0.6875rem] text-muted-foreground">None</p>}
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card className="overflow-hidden">
        <div className="flex items-center gap-1.5 border-b bg-secondary/40 px-4 py-2.5 text-[0.65625rem] font-semibold uppercase tracking-wider text-muted-foreground">
          <MessageCircle className="h-3 w-3" /> Feedback &amp; bug reports · newest first
        </div>
        {feedbackErr ? (
          <p className="p-4 text-[0.75rem] text-red-400">Couldn't load feedback: {feedbackErr}</p>
        ) : !feedback ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading feedback…
          </div>
        ) : feedback.length === 0 ? (
          <p className="p-4 text-[0.75rem] text-muted-foreground">Nothing submitted yet.</p>
        ) : (
          <div className="divide-y divide-border/60">
            {feedback.map((f) => (
              <div key={f.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-4 py-3 text-[0.8125rem]">
                <span className="w-20 shrink-0 text-[0.6875rem] text-muted-foreground">
                  {new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}
                  <span className="block text-[0.625rem] text-muted-foreground/70">
                    {new Date(f.created_at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}
                  </span>
                </span>
                <Badge variant={f.type === 'bug' ? 'destructive' : 'success'}>
                  {f.type === 'bug' ? 'Bug' : 'Feedback'}
                </Badge>
                <span className="min-w-0 flex-1 basis-full sm:basis-0">
                  <span className="whitespace-pre-wrap break-words text-foreground/90">{f.message}</span>
                  <span className="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">
                    {f.email || 'no email'}{f.page ? ` · ${f.page}` : ''}
                  </span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Card>

      <p className="text-[0.6875rem] text-muted-foreground/70">
        Read-only view across all accounts. Admin access is controlled by the <code>admins</code> table in Supabase. Add a row to grant, delete to revoke.
      </p>
    </div>
  )
}
