'use client'
// Reports — grain-selectable (day/week/month/quarter/year) financial
// snapshots computed CLIENT-SIDE off useApp() state via lib/snapshots.js —
// the exact same pure functions app/api/reports/snapshot uses server-side,
// so the numbers here can never drift from what a Download Excel / chat
// query would show. No round trip needed for the on-screen view; Download
// Excel/Save as PDF are the only two actions that leave this page.
import { useMemo, useState } from 'react'
import { Download, Printer } from 'lucide-react'
import { BarChart, Bar as RBar, XAxis, YAxis, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { Card } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Segmented } from '@/components/ui/segmented'
import { SectionHead, Kpi, Bar } from '@/components/shared'
import { useApp } from '@/store'
import { usePlaidItems, buildAccountInventory, accountTxKey } from '@/lib/accounts'
import { periodsFor, buildSnapshot, compare, defaultRange } from '@/lib/snapshots'
import { fmt0, today, catColor, cn } from '@/lib/utils'
import { useIsMobile } from '@/lib/useMediaQuery'
import { useToast } from '@/components/toast'
import { useT } from '@/lib/i18n'

const TIP = {
  contentStyle: { background: 'hsl(221 55% 10%)', border: '1px solid hsl(220 42% 18%)', borderRadius: 12, fontSize: 12 },
  labelStyle: { color: '#dbe4f5', fontWeight: 700, marginBottom: 2 },
  itemStyle: { color: '#dbe4f5' },
}
const kfmt = (v) => '$' + (Math.abs(v) >= 1000 ? (v / 1000).toFixed(v % 1000 === 0 ? 0 : 1) + 'k' : v)

const GRAIN_LABELS = { day: 'Day', week: 'Week', month: 'Month', quarter: 'Quarter', year: 'Year' }
const PRESET_LABELS = { day: 'Last 30 days', week: 'Last 12 weeks', month: 'Last 12 months', quarter: 'Last 8 quarters', year: 'All years' }

// Small colored pill showing a period-over-period change — `invert` flips
// which direction reads as "good" (spending/debt payments going UP is bad,
// income/net going up is good). `pct` is null when the prior period was 0
// (see lib/snapshots.js's compare()) — falls back to the raw dollar amount
// so this never prints a meaningless "+Infinity%"/"+0%".
function DeltaPill({ delta, invert = false, className = '' }) {
  if (!delta) return null
  const { abs, pct } = delta
  if (Math.abs(abs) < 0.005) return null
  const positive = abs > 0
  const good = invert ? !positive : positive
  const text = pct != null ? `${positive ? '+' : ''}${pct.toFixed(1)}%` : `${positive ? '+' : ''}${fmt0(abs)}`
  return (
    <span className={cn(
      'inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[0.625rem] font-bold',
      good ? 'border-emerald-400/25 bg-emerald-400/10 text-emerald-300' : 'border-red-400/25 bg-red-400/10 text-red-300',
      className
    )}>
      {text}
    </span>
  )
}

export default function Reports() {
  const { state, catInfo, space } = useApp()
  const { plaidItems } = usePlaidItems()
  const isMobile = useIsMobile()
  const toast = useToast()
  const t = useT()

  const [grain, setGrain] = useState('month')
  const [preset, setPreset] = useState('default') // 'default' | 'all' | 'custom'
  const [customFrom, setCustomFrom] = useState('')
  const [customTo, setCustomTo] = useState('')
  const [selectedKey, setSelectedKey] = useState(null) // period.key clicked in the table below; null = latest period

  const changeGrain = (g) => { setGrain(g); setPreset('default'); setSelectedKey(null) }

  const range = useMemo(() => {
    if (preset === 'custom' && customFrom && customTo) {
      return customFrom <= customTo ? { from: customFrom, to: customTo } : { from: customTo, to: customFrom }
    }
    if (preset === 'all') {
      const dates = state.transactions.map((tx) => tx.date).sort()
      return { from: dates[0] || today(), to: today() }
    }
    return defaultRange(grain, state.transactions)
  }, [grain, preset, customFrom, customTo, state.transactions])

  // Resolves a transaction's accountId to a display name using the full
  // merged inventory (manual + Plaid) — the richer counterpart to
  // lib/reports-server.js's accountNameResolverFor, which only knows about
  // manual rows since the server route never loads Plaid connections.
  const accountName = useMemo(() => {
    const { all } = buildAccountInventory(state, plaidItems)
    const map = new Map()
    all.forEach((row) => { const k = accountTxKey(row); if (k) map.set(k, row.name) })
    return (key) => (key ? (map.get(key) || key) : t('Uncategorized'))
  }, [state, plaidItems])

  const opts = useMemo(() => ({ catName: (id) => catInfo(id).name, accountName }), [catInfo, accountName])
  const periods = useMemo(() => periodsFor(grain, range.from, range.to), [grain, range.from, range.to])
  const snapshots = useMemo(() => periods.map((p) => buildSnapshot(state, p, opts)), [periods, state, opts])

  const selectedIdx = useMemo(() => {
    if (selectedKey == null) return snapshots.length - 1
    const i = snapshots.findIndex((s) => s.key === selectedKey)
    return i === -1 ? snapshots.length - 1 : i
  }, [snapshots, selectedKey])
  const selected = snapshots[selectedIdx] || null
  const prevSnap = selectedIdx > 0 ? snapshots[selectedIdx - 1] : null
  const cmp = useMemo(() => (selected ? compare(selected, prevSnap) : null), [selected, prevSnap])

  const trendData = useMemo(() => snapshots.map((s) => ({ name: s.label, Income: s.income, Outflow: s.outflow })), [snapshots])
  const maxCatAmount = Math.max(1, ...(selected?.byCategory || []).map((c) => c.amount))

  const downloadExcel = async () => {
    try {
      const params = new URLSearchParams({ grain, from: range.from, to: range.to })
      if (space?.id) params.set('space_id', space.id)
      const res = await fetch('/api/reports/export?' + params.toString())
      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        toast(data.error || t("Couldn't export the report"), 'error')
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `steermoney-${grain}-${range.from}_${range.to}.xlsx`
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch {
      toast(t("Couldn't export the report"), 'error')
    }
  }

  const grainLabel = t(GRAIN_LABELS[grain])

  return (
    <div className="fade-in space-y-4">
      {/* Print-only masthead — hidden on screen (globals.css's @media print
          flips it on); the sidebar/header/nav and the controls Card below
          are hidden the same way via the `no-print` class. */}
      <div className="print-header hidden">
        {t('SteerMoney — {grain} report, {range}, generated {date}', { grain: grainLabel, range: `${range.from} – ${range.to}`, date: today() })}
      </div>

      <Card className="no-print p-4 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Segmented
            options={Object.entries(GRAIN_LABELS).map(([g, label]) => [g, t(label)])}
            value={grain}
            onChange={changeGrain}
          />
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={downloadExcel}><Download className="h-3.5 w-3.5" />{t('Download Excel')}</Button>
            <Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="h-3.5 w-3.5" />{t('Save as PDF')}</Button>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Segmented
            options={[['default', t(PRESET_LABELS[grain])], ['all', t('All')], ['custom', t('Custom')]]}
            value={preset}
            onChange={setPreset}
          />
          {preset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2">
              <Label className="!mb-0">{t('From')}</Label>
              <Input type="date" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} className="!h-8 w-40" />
              <Label className="!mb-0">{t('to')}</Label>
              <Input type="date" value={customTo} onChange={(e) => setCustomTo(e.target.value)} className="!h-8 w-40" />
            </div>
          )}
        </div>
      </Card>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi label={t('Income')} value={fmt0(selected?.income || 0)} tone="text-emerald-400" sub={<DeltaPill delta={cmp?.incomeDelta} />} />
        <Kpi label={t('Spending')} value={fmt0(selected?.spending || 0)} tone="text-red-400" sub={<DeltaPill delta={cmp?.spendingDelta} invert />} />
        <Kpi label={t('Debt Payments')} value={fmt0(selected?.debtPayments || 0)} sub={<DeltaPill delta={cmp?.debtPaymentsDelta} invert />} />
        <Kpi label={t('Net')} value={fmt0(selected?.net || 0)} tone={(selected?.net || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'} sub={<DeltaPill delta={cmp?.netDelta} />} />
      </div>

      <Card className="report-card p-5">
        <SectionHead title={t('Income vs Outflow')} desc={t('Income vs. spending + debt payments, per {grain}', { grain: grainLabel.toLowerCase() })} />
        <div className="mt-4 h-64">
          <ResponsiveContainer>
            <BarChart data={trendData} margin={{ top: 4, right: 4, left: -12, bottom: 0 }}>
              <XAxis dataKey="name" tick={{ fill: '#71717a', fontSize: 10 }} axisLine={false} tickLine={false} interval={isMobile ? 'preserveStartEnd' : 0} minTickGap={isMobile ? 24 : 5} />
              <YAxis tick={{ fill: '#52525b', fontSize: 10 }} tickFormatter={kfmt} axisLine={false} tickLine={false} width={isMobile ? 34 : 44} />
              <Tooltip {...TIP} cursor={{ fill: '#ffffff08' }} formatter={(v) => fmt0(v)} />
              {!isMobile && <Legend wrapperStyle={{ fontSize: 10 }} formatter={(v) => <span style={{ color: '#a1a1aa' }}>{v}</span>} />}
              <RBar dataKey="Income" name={t('Income')} fill="#34d399" radius={[4, 4, 0, 0]} maxBarSize={30} />
              <RBar dataKey="Outflow" name={t('Outflow')} fill="#e0655f" radius={[4, 4, 0, 0]} maxBarSize={30} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <Card className="report-card p-5">
          <SectionHead title={t('Category Breakdown')} desc={selected?.label} />
          <div className="report-scroll mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">
            {(selected?.byCategory || []).map((c) => {
              const d = cmp?.byCategoryDelta?.find((x) => x.id === c.id)
              return (
                <div key={c.id} className="flex items-center gap-2">
                  <span className="w-24 shrink-0 truncate text-xs font-semibold" title={c.name}>{c.name}</span>
                  <div className="min-w-0 flex-1"><Bar pct={(c.amount / maxCatAmount) * 100} color={catColor(c.id)} /></div>
                  <span className="w-16 shrink-0 text-right text-xs font-bold">{fmt0(c.amount)}</span>
                  <span className="w-10 shrink-0 text-right text-[0.625rem] text-muted-foreground">{c.pctOfSpending.toFixed(1)}%</span>
                  <DeltaPill delta={d} invert className="w-16 shrink-0 justify-center" />
                </div>
              )
            })}
            {!selected?.byCategory?.length && <p className="text-xs text-muted-foreground">{t('No data for this period.')}</p>}
          </div>
        </Card>

        <Card className="report-card p-5">
          <SectionHead title={t('Debts at Period End')} desc={selected?.label} />
          <div className="report-scroll mt-3 max-h-80 overflow-y-auto">
            <table className="w-full text-xs">
              <tbody>
                {(selected?.debtsEnd || []).map((d) => (
                  <tr key={d.id} className="border-b border-border/40">
                    <td className="py-1.5">{d.name}</td>
                    <td className="py-1.5 text-right font-bold">{fmt0(d.balance)}</td>
                  </tr>
                ))}
              </tbody>
              {selected?.debtsEnd?.length ? (
                <tfoot>
                  <tr>
                    <td className="pt-2 font-bold">{t('Total')}</td>
                    <td className="pt-2 text-right font-extrabold">{fmt0(selected.totalDebtEnd)}</td>
                  </tr>
                </tfoot>
              ) : null}
            </table>
            {!selected?.debtsEnd?.length && <p className="text-xs text-muted-foreground">{t('No debts tracked.')}</p>}
          </div>
        </Card>
      </div>

      <Card className="report-card p-5">
        <SectionHead title={t('Periods')} desc={t('Tap a row to see it above')} />
        <div className="report-scroll mt-3 overflow-x-auto">
          <table className="w-full min-w-[38rem] text-xs">
            <thead>
              <tr className="text-left text-muted-foreground">
                <th className="pb-2 pr-2 font-semibold">{t('Period')}</th>
                <th className="pb-2 pr-2 text-right font-semibold">{t('Income')}</th>
                <th className="pb-2 pr-2 text-right font-semibold">{t('Spending')}</th>
                <th className="pb-2 pr-2 text-right font-semibold">{t('Debt Payments')}</th>
                <th className="pb-2 pr-2 text-right font-semibold">{t('Net')}</th>
                <th className="pb-2 text-right font-semibold">{t('# Transactions')}</th>
              </tr>
            </thead>
            <tbody>
              {snapshots.map((s) => (
                <tr
                  key={s.key}
                  onClick={() => setSelectedKey(s.key)}
                  className={cn('cursor-pointer border-t border-border/40 transition hover:bg-secondary/40', s.key === selected?.key && 'bg-primary/[0.08]')}
                >
                  <td className="py-1.5 pr-2 font-semibold">{s.label}</td>
                  <td className="py-1.5 pr-2 text-right">{fmt0(s.income)}</td>
                  <td className="py-1.5 pr-2 text-right">{fmt0(s.spending)}</td>
                  <td className="py-1.5 pr-2 text-right">{fmt0(s.debtPayments)}</td>
                  <td className={cn('py-1.5 pr-2 text-right font-bold', s.net >= 0 ? 'text-emerald-400' : 'text-red-400')}>{fmt0(s.net)}</td>
                  <td className="py-1.5 text-right">{s.transactionCount}</td>
                </tr>
              ))}
              {!snapshots.length && (
                <tr><td colSpan={6} className="py-4 text-center text-muted-foreground">{t('No data for this period.')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
