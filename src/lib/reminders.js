import { nextDueDate, recEvery } from './finance'
import { isoDate, today } from './utils'

// Upcoming payments (debts + active recurring bills) due within `days`.
// Items already paid/logged this month are excluded.
// -> [{ key, name, amount, kind: 'debt'|'bill', due: 'YYYY-MM-DD', diff }]
export function upcomingPayments(state, days = 7) {
  if (!state) return []
  const out = []
  const now0 = new Date(); now0.setHours(0, 0, 0, 0)
  const ym = today().slice(0, 7)

  state.debts.forEach((d) => {
    if (d.balance <= 0 || !d.dueDay) return
    if ((d.payments || []).some((p) => p.date.startsWith(ym))) return // paid this month
    const dt = nextDueDate(d.dueDay)
    const diff = Math.round((dt - now0) / 864e5)
    if (diff >= 0 && diff <= days) out.push({ key: 'debt:' + d.id, name: d.name, amount: d.min, kind: 'debt', due: isoDate(dt), diff })
  })

  state.recurring.forEach((r) => {
    if (r.active === false) return
    if (state.transactions.some((t) => t.rid === r.id && t.date.startsWith(ym))) return // logged this month
    let dt = null
    if (recEvery(r) > 1) { if (r.nextDate) dt = new Date(r.nextDate + 'T00:00:00') } else if (r.dueDay) dt = nextDueDate(r.dueDay)
    if (!dt) return
    const diff = Math.round((dt - now0) / 864e5)
    if (diff >= 0 && diff <= days) out.push({ key: 'bill:' + r.id, name: r.desc, amount: r.amount, kind: 'bill', due: isoDate(dt), diff })
  })

  return out.sort((a, b) => a.diff - b.diff)
}
