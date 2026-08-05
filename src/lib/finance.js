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

// normalize a description for fuzzy matching: lowercase, strip non-alphanumerics, collapse whitespace
export function normDesc(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ')
}
export const GENERIC_TOKENS = new Set(['payment', 'card', 'check', 'debit', 'online', 'autopay', 'recurring', 'bill', 'com', 'www', 'inc', 'llc'])

// significant tokens for fuzzy matching: same rule findPaidTx uses (len >= 4, not generic)
const sigTokens = (s) => normDesc(s).split(' ').filter((w) => w.length >= 4 && !GENERIC_TOKENS.has(w))

// Match a recurring bill against a set of transactions from the same month.
// (a) an explicit rid link (created via "Log this month") always wins.
// (b) otherwise, an expense within tolerance of the bill's amount whose
// description overlaps enough to be confident it's the same charge.
// Callers matching several bills against the same pool should remove a
// transaction once it's matched so two similar bills can't both claim it.
export function findPaidTx(r, txs) {
  const byRid = txs.find((t) => t.rid === r.id)
  if (byRid) return byRid

  const tol = Math.max(3, r.amount * 0.12)
  const rNorm = normDesc(r.desc)
  const rTokens = rNorm.split(' ').filter((w) => w.length >= 4 && !GENERIC_TOKENS.has(w))
  for (const t of txs) {
    if (t.type !== 'expense') continue
    if (Math.abs(t.amount - r.amount) > tol) continue
    const tNorm = normDesc(t.desc)
    if (!rNorm || !tNorm) continue
    if (tNorm.includes(rNorm) || rNorm.includes(tNorm)) return t
    const tTokens = new Set(tNorm.split(' ').filter((w) => w.length >= 4 && !GENERIC_TOKENS.has(w)))
    if (rTokens.some((w) => tTokens.has(w))) return t
  }
  return null
}

// Match a debt against the flat list of connected Plaid accounts (each
// {name, official_name, mask, institution}), so the Debt Tracker can badge
// "Bank connected" vs "Manual entry" without asking the user.
// (a) the account's last-4 mask shows up inside the debt name — e.g. a debt
//     named "Chase Freedom ••1234" matches an account with mask "1234".
// (b) otherwise, the same normalized-token overlap findPaidTx uses between
//     the debt name and the account's name / official name / institution.
// Words too common in account names to prove anything on their own — a lone
// "loan"/"platinum" overlap must not flag a debt as bank connected.
const ACCOUNT_FILLER = new Set([
  'loan', 'loans', 'cash', 'credit', 'bank', 'saving', 'savings', 'checking', 'money', 'market',
  'account', 'personal', 'active', 'rewards', 'standard', 'interest', 'platinum', 'gold', 'silver',
  'diamond', 'bronze', 'visa', 'mastercard', 'plaid', 'student', 'mortgage', 'auto',
])

export function matchesBankAccount(debt, plaidAccounts) {
  if (!debt || !plaidAccounts || !plaidAccounts.length) return null
  const dName = String(debt.name || '')

  for (const a of plaidAccounts) {
    if (a.mask && dName.includes(a.mask)) return a
  }

  const dTokens = new Set(sigTokens(dName))
  if (!dTokens.size) return null
  for (const a of plaidAccounts) {
    const candidates = [a.name, a.official_name, a.institution].filter(Boolean)
    const overlap = new Set()
    candidates.forEach((c) => sigTokens(c).forEach((w) => { if (dTokens.has(w)) overlap.add(w) }))
    const distinctive = [...overlap].filter((w) => !ACCOUNT_FILLER.has(w))
    // confident only on a brand-like token (e.g. "wescom") or two overlapping words
    if (distinctive.length >= 1 || overlap.size >= 2) return a
  }
  return null
}

export function nextDueDate(day) {
  const now = new Date(); now.setHours(0, 0, 0, 0)
  const dim = (y, m) => new Date(y, m + 1, 0).getDate()
  let d = new Date(now.getFullYear(), now.getMonth(), Math.min(day, dim(now.getFullYear(), now.getMonth())))
  if (d < now) d = new Date(now.getFullYear(), now.getMonth() + 1, Math.min(day, dim(now.getFullYear(), now.getMonth() + 1)))
  return d
}
