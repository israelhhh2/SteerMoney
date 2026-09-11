// Server-only briefing builder for the finance chat (Step 2, 2026-09). Turns
// a loadReportState() state into a compact plain-text summary (aim: ~1,200
// tokens / under ~6,000 chars) that goes into the system prompt alongside
// the static grounding rules (see app/api/chat/route.js) — this is what lets
// the model answer "how am I doing" without a tool round-trip, and it's also
// where the model learns which category ids/account keys are valid to pass
// into lib/chat-tools.js's tools.
//
// Pure function, same posture as lib/snapshots.js: no React/Supabase/window.
import { buildSnapshot, compare, round2 } from './snapshots.js'
import { catNameResolverFor, accountNameResolverFor } from './reports-server.js'

function toISO(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

// Same reference-date-parameterized due-date math as lib/chat-tools.js's own
// copy (see that file's comment for why this isn't finance.js's
// nextDueDate — that one always reads the real system clock).
function nextDueDateFrom(day, fromISO) {
  const from = new Date(fromISO + 'T00:00:00')
  const dim = (y, m) => new Date(y, m + 1, 0).getDate()
  let d = new Date(from.getFullYear(), from.getMonth(), Math.min(day, dim(from.getFullYear(), from.getMonth())))
  if (d < from) d = new Date(from.getFullYear(), from.getMonth() + 1, Math.min(day, dim(from.getFullYear(), from.getMonth() + 1)))
  return d
}

function fmtMoney(n) {
  const v = round2(n || 0)
  const sign = v < 0 ? '-' : ''
  return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function monthBounds(ym) {
  const [y, m] = ym.split('-').map(Number)
  return { key: ym, start: `${ym}-01`, end: toISO(new Date(y, m, 0)) }
}
function prevMonthKey(ym) {
  const [y, m] = ym.split('-').map(Number)
  const py = m === 1 ? y - 1 : y, pm = m === 1 ? 12 : m - 1
  return `${py}-${String(pm).padStart(2, '0')}`
}

// buildBriefing(state, ctx) -> string. `ctx = { now, plaidAccountNames }` —
// same shape lib/chat-tools.js's runChatTool takes (state is threaded
// through separately here since this is called once per chat turn, before
// any tool call).
export function buildBriefing(state, ctx) {
  const now = ctx?.now || new Date().toISOString().slice(0, 10)
  const plaidAccountNames = ctx?.plaidAccountNames
  const catName = catNameResolverFor(state)
  const acctFallback = accountNameResolverFor(state)
  const acctName = (key) => (key && plaidAccountNames instanceof Map && plaidAccountNames.get(key)) || acctFallback(key)

  const lines = []
  lines.push(`Today's date: ${now}.`)

  const debts = state.debts || []
  const totalDebt = round2(debts.reduce((s, d) => s + d.balance, 0))
  lines.push('')
  lines.push(`Debts: ${debts.length} account(s), total balance ${fmtMoney(totalDebt)}.`)
  debts.slice(0, 20).forEach((d) => {
    lines.push(`- ${d.name}: ${fmtMoney(d.balance)} balance, ${d.apr || '—'} APR, ${fmtMoney(d.min || 0)} min payment, due day ${d.dueDay ?? '—'}`)
  })

  const curKey = now.slice(0, 7)
  const prevKey = prevMonthKey(curKey)
  const curM = monthBounds(curKey), prevM = monthBounds(prevKey)
  const opts = { catName, accountName: acctName, now }
  const curSnap = buildSnapshot(state, { key: curM.key, label: curM.key, start: curM.start, end: curM.end }, opts)
  const prevSnap = buildSnapshot(state, { key: prevM.key, label: prevM.key, start: prevM.start, end: prevM.end }, opts)
  const cmp = compare(curSnap, prevSnap)

  lines.push('')
  lines.push(`This month (${curKey}) so far: income ${fmtMoney(curSnap.income)}, spending ${fmtMoney(curSnap.spending)}, net ${fmtMoney(curSnap.net)}.`)
  lines.push(`Last month (${prevKey}): income ${fmtMoney(prevSnap.income)}, spending ${fmtMoney(prevSnap.spending)}, net ${fmtMoney(prevSnap.net)}.`)
  if (cmp) {
    const spendChange = cmp.spendingDelta.pct != null ? `${cmp.spendingDelta.pct > 0 ? '+' : ''}${cmp.spendingDelta.pct}%` : fmtMoney(cmp.spendingDelta.abs)
    const incomeChange = cmp.incomeDelta.pct != null ? `${cmp.incomeDelta.pct > 0 ? '+' : ''}${cmp.incomeDelta.pct}%` : fmtMoney(cmp.incomeDelta.abs)
    lines.push(`Change vs last month: spending ${spendChange}, income ${incomeChange}.`)
  }

  lines.push('')
  lines.push('Top categories this month:')
  if (curSnap.byCategory.length) {
    curSnap.byCategory.slice(0, 6).forEach((c) => {
      const budget = (state.budgets || []).find((b) => b.id === c.id && b.limit > 0)
      lines.push(`- ${c.name} (id: ${c.id}): ${fmtMoney(c.amount)}, ${c.count} tx${budget ? `, budget ${fmtMoney(budget.limit)}` : ''}`)
    })
  } else {
    lines.push('- No spending recorded yet this month.')
  }

  const nowDate = new Date(now + 'T00:00:00')
  const cutoff = new Date(nowDate); cutoff.setDate(cutoff.getDate() + 14)
  const upcoming = (state.recurring || [])
    .filter((r) => r.active !== false && r.dueDay)
    .map((r) => ({ desc: r.desc, amount: r.amount, due: nextDueDateFrom(r.dueDay, now) }))
    .filter((b) => b.due >= nowDate && b.due <= cutoff)
    .sort((a, b) => a.due - b.due)

  lines.push('')
  if (upcoming.length) {
    lines.push('Bills due in the next 14 days:')
    upcoming.slice(0, 10).forEach((b) => lines.push(`- ${b.desc}: ${fmtMoney(b.amount)} due ${toISO(b.due)}`))
  } else {
    lines.push('No bills due in the next 14 days.')
  }

  lines.push('')
  const cats = (state.budgets || []).map((b) => `${b.id}=${b.name}`)
  lines.push(`Category ids available for tool calls: ${cats.length ? cats.join(', ') : 'none'}`)

  const acctKeys = new Set()
  ;(state.transactions || []).forEach((t) => { if (t.accountId) acctKeys.add(t.accountId) })
  const accountList = [...acctKeys].slice(0, 30).map((k) => `${k}=${acctName(k)}`)
  lines.push(`Account keys available for tool calls: ${accountList.length ? accountList.join(', ') : 'none'}`)

  return lines.join('\n')
}
