// Debt math — ported 1:1 from the original single-file dashboard.

export function parseAPR(s) {
  const n = [...String(s || '').matchAll(/\d+(?:\.\d+)?/g)].map((m) => parseFloat(m[0]))
  if (!n.length) return 0
  return n.reduce((a, b) => a + b, 0) / n.length / 100
}

export function payoffMonths(bal, aprText, pay) {
  const r = parseAPR(aprText) / 12
  if (pay <= 0 || bal <= 0) return null
  if (r === 0) return Math.ceil(bal / pay)
  if (pay <= bal * r) return null
  return Math.ceil(-Math.log(1 - (r * bal) / pay) / Math.log(1 + r))
}

export function fmtMonths(m) {
  if (m == null) return null
  const y = Math.floor(m / 12), mo = m % 12
  return (y ? y + ' yr ' : '') + (mo ? mo + ' mo' : y ? '' : '0 mo')
}

// budget = total paid toward all debts each month; extra above minimums goes to
// the focus debt (avalanche = highest APR first, snowball = smallest balance first).
export function simulatePlan(debts, budget, strategy) {
  const ds = debts.map((d) => ({ name: d.name, bal: d.balance, r: parseAPR(d.apr) / 12, min: d.min }))
  const startDate = new Date()
  let months = 0, totalInterest = 0
  const hist = [ds.reduce((s, d) => s + d.bal, 0)]
  const payoffs = {}
  while (ds.some((d) => d.bal > 0.005) && months < 600) {
    months++
    ds.forEach((d) => { if (d.bal > 0.005) { const int = d.bal * d.r; totalInterest += int; d.bal += int } })
    let avail = budget
    ds.forEach((d) => { if (d.bal > 0.005) { const p = Math.min(d.min, d.bal, avail); d.bal -= p; avail -= p } })
    const order = ds.filter((d) => d.bal > 0.005).sort((a, b) => (strategy === 'snowball' ? a.bal - b.bal : b.r - a.r))
    for (const d of order) {
      if (avail <= 0) break
      const p = Math.min(avail, d.bal)
      d.bal -= p; avail -= p
    }
    ds.forEach((d) => {
      if (d.bal <= 0.005 && !payoffs[d.name]) {
        const dt = new Date(startDate); dt.setMonth(dt.getMonth() + months); payoffs[d.name] = dt
      }
    })
    hist.push(ds.reduce((s, d) => s + d.bal, 0))
  }
  const done = ds.every((d) => d.bal <= 0.005)
  const end = new Date(startDate); end.setMonth(end.getMonth() + months)
  return { months, totalInterest, hist, payoffs, done, end }
}

// Single-debt payoff at a fixed payment.
export function simCardPlan(bal, aprText, pay) {
  const r = parseAPR(aprText) / 12
  if (bal <= 0) return { months: 0, interest: 0 }
  if (pay <= 0 || (r > 0 && pay <= bal * r)) return null
  let b = bal, interest = 0, m = 0
  while (b > 0.005 && m < 1200) { m++; const int = b * r; interest += int; b = b + int - pay }
  return m >= 1200 ? null : { months: m, interest }
}

export const recEvery = (r) => Math.max(1, r.every || 1)
export const recMonthly = (r) => r.amount / recEvery(r)

export function nextDueDate(day) {
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const dim = (y, m) => new Date(y, m + 1, 0).getDate()
  let d = new Date(now.getFullYear(), now.getMonth(), Math.min(day, dim(now.getFullYear(), now.getMonth())))
  if (d < now) d = new Date(now.getFullYear(), now.getMonth() + 1, Math.min(day, dim(now.getFullYear(), now.getMonth() + 1)))
  return d
}
