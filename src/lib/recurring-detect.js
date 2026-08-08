// Client-side subscription/recurring-charge detector — pure functions, no
// store/network access, called on demand from views/Recurring.jsx against
// state.transactions. No cron/background job: this is a "find bills you
// already have" screen the user opens, not a scheduled sync (the app's only
// other scheduled-ish work is Plaid's own webhook/backfill — see
// lib/plaid-sync.js — which is unrelated).
import { isoDate } from './utils'

// ---- known subscription hints ----
// [needle, canonical display name] — needle is matched as a case-insensitive
// substring against the raw transaction description (before any cleanup),
// so "NETFLIX.COM *123ABC" still matches "netflix" even though the cleanup
// pass below would also have handled it. Longest needle first so more
// specific strings ("amazon prime") win over shorter ones that could
// otherwise collide ("amazon" alone isn't listed, on purpose — too many
// false positives for a generic "Amazon" purchase that isn't Prime).
// Multiple needles intentionally collapse onto the same display name (e.g.
// "hbo max" / "hbomax" both -> "Max") so they group into one suggestion.
const KNOWN_SUBS = [
  ['netflix', 'Netflix'],
  ['spotify', 'Spotify'],
  ['hulu', 'Hulu'],
  ['disney+', 'Disney+'], ['disneyplus', 'Disney+'], ['disney plus', 'Disney+'],
  ['hbo max', 'Max'], ['hbomax', 'Max'],
  ['youtube premium', 'YouTube Premium'], ['youtubepremium', 'YouTube Premium'], ['youtube music', 'YouTube Music'],
  ['amazon prime', 'Amazon Prime'], ['prime video', 'Amazon Prime'], ['amzn prime', 'Amazon Prime'],
  ['apple.com/bill', 'Apple'], ['apple services', 'Apple'], ['apple music', 'Apple Music'], ['icloud', 'iCloud'],
  ['claude.ai', 'Claude'], ['anthropic', 'Claude'],
  ['openai', 'ChatGPT'], ['chatgpt', 'ChatGPT'],
  ['audible', 'Audible'],
  ['dropbox', 'Dropbox'],
  ['google one', 'Google One'], ['google storage', 'Google One'],
  ['planet fitness', 'Planet Fitness'], ['la fitness', 'LA Fitness'], ['equinox', 'Equinox'],
  ['crunch fitness', 'Crunch Fitness'], ['peloton', 'Peloton'], ['24 hour fitness', '24 Hour Fitness'],
  ['nytimes', 'NY Times'], ['new york times', 'NY Times'],
  ['github', 'GitHub'], ['adobe', 'Adobe'], ['microsoft 365', 'Microsoft 365'], ['xbox', 'Xbox'],
  ['playstation', 'PlayStation'], ['paramount', 'Paramount+'], ['peacock', 'Peacock'], ['sirius', 'SiriusXM'],
].sort((a, b) => b[0].length - a[0].length)

function knownSubMatch(rawDescLower) {
  return KNOWN_SUBS.find(([needle]) => rawDescLower.includes(needle)) || null
}

// General-purpose merchant-name cleanup — strips domain suffixes, store/POS/
// terminal/ref numbers, card processor prefixes, dates, and long numeric
// tails (card/store ids), then collapses whitespace. Used both as the
// grouping key fallback (when no known-subscription hint matches) and to
// build a friendly display name for merchants not in the known list.
export function normalizeMerchant(desc) {
  let s = String(desc || '').toLowerCase()
  s = s.replace(/\.(com|net|org|co)\b/g, ' ')            // "netflix.com" -> "netflix "
  s = s.replace(/[^a-z0-9\s]/g, ' ')                       // punctuation (*, #, /, -, etc.) -> space
  s = s.replace(/\b\d{4,}\b/g, ' ')                        // long numeric refs / store ids / card tails
  s = s.replace(/\b(pos|ref|txn|trans|store|terminal|order|no)\s*\d*\b/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  s = s.replace(/\s+\d{1,3}$/, '')                         // trailing short digit tail
  return s.trim()
}

// Grouping key for a transaction description — a known-subscription match
// collapses onto its canonical display name (lowercased, no spaces) so
// "netflix.com" and "NETFLIX*123" land in the same bucket; otherwise falls
// back to the cleaned merchant string.
export function merchantKey(desc) {
  const raw = String(desc || '').toLowerCase()
  const known = knownSubMatch(raw)
  if (known) return known[1].toLowerCase().replace(/[^a-z0-9]/g, '')
  const clean = normalizeMerchant(desc)
  if (clean) return clean
  const fallback = raw.replace(/[^a-z0-9]/g, '')
  return fallback.slice(0, 24)
}

// Friendly display name — known-subscription canonical name, else the
// cleaned merchant string title-cased, else the raw description trimmed.
export function displayName(desc) {
  const raw = String(desc || '').toLowerCase()
  const known = knownSubMatch(raw)
  if (known) return known[1]
  const clean = normalizeMerchant(desc)
  if (clean) return clean.replace(/\b\w/g, (c) => c.toUpperCase())
  return String(desc || '').trim().slice(0, 40) || 'Unknown merchant'
}

// ---- cadence classification ----
const DAY_MS = 86400000
// "Go back 4 months" per the request: weekly/biweekly/monthly are classified
// only against transactions from this recent window, so a bill that lapsed
// months ago ages out of suggestions on its own instead of being detected
// forever off old charges. Yearly obviously can't be seen inside 4 months, so
// it's handled separately (tryYearly, below) against the full history as a
// bonus path — it doesn't share this window.
const WINDOW_DAYS = 120
const CADENCE_RANGES = [
  ['weekly', 6, 8],
  ['biweekly', 12, 16],
  ['monthly', 26, 35],
]
const YEARLY_RANGE = [350, 380]
const CADENCE_DAYS = { weekly: 7, biweekly: 14 }

export const CADENCE_LABEL = { weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', yearly: 'yearly' }

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  const n = s.length
  if (!n) return 0
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

function classifyCadence(medianDays) {
  for (const [name, lo, hi] of CADENCE_RANGES) {
    if (medianDays >= lo && medianDays <= hi) return name
  }
  return null
}

// "Same amount" — within ~10% of the median (tightened from ~20%; a $0.50
// floor still covers cent-level statement noise on very small charges).
function amountsAreConsistent(amounts, medAmount) {
  return amounts.every((a) => Math.abs(a - medAmount) <= Math.max(medAmount * 0.1, 0.5))
}

// "Around the same time" for a monthly cadence — the interval-median check
// alone tolerates e.g. day 1 and day 30 landing 29 days apart (still "monthly"
// by interval), which isn't what a user means by "same time each month."
// Requires every charge's day-of-month within ±4 of the group's median day —
// wide enough to absorb weekend/holiday posting drift and short-month shift
// (Feb 28 vs Mar 2-4), tight enough to reject "same merchant, different week."
// Weekly/biweekly don't need this — their tight interval bands already imply
// consistent timing.
function domConsistent(sortedTxs) {
  const doms = sortedTxs.map((t) => new Date(t.date + 'T00:00:00').getDate())
  const med = median(doms)
  return doms.every((d) => Math.abs(d - med) <= 4)
}

// Classifies one merchant group against the recent (4-month) window —
// weekly/biweekly/monthly only. Returns { sorted, cadence } or null.
function tryClassifyRecent(txs) {
  if (txs.length < 2) return null
  const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date))
  const dates = sorted.map((t) => new Date(t.date + 'T00:00:00').getTime())
  const intervals = []
  for (let i = 1; i < dates.length; i++) intervals.push(Math.round((dates[i] - dates[i - 1]) / DAY_MS))
  const cadence = classifyCadence(median(intervals))
  if (!cadence) return null

  const amounts = sorted.map((t) => t.amount)
  if (!amountsAreConsistent(amounts, median(amounts))) return null
  if (cadence === 'monthly' && !domConsistent(sorted)) return null

  return { sorted, cadence }
}

// Yearly bonus path, against the FULL history (not the 4-month window) — per
// the request, yearly cadence "obviously can't be detected in 4 months," so
// this only requires at least two charges ~12 months apart somewhere in
// everything we have, same amount-consistency rule as the recent path.
function tryClassifyYearly(txs) {
  if (txs.length < 2) return null
  const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date))
  const dates = sorted.map((t) => new Date(t.date + 'T00:00:00').getTime())
  const intervals = []
  for (let i = 1; i < dates.length; i++) intervals.push(Math.round((dates[i] - dates[i - 1]) / DAY_MS))
  const medianInterval = median(intervals)
  if (medianInterval < YEARLY_RANGE[0] || medianInterval > YEARLY_RANGE[1]) return null

  const amounts = sorted.map((t) => t.amount)
  if (!amountsAreConsistent(amounts, median(amounts))) return null

  return { sorted, cadence: 'yearly' }
}

function estimateNextDate(lastDateIso, cadence) {
  const d = new Date(lastDateIso + 'T00:00:00')
  if (cadence === 'monthly') d.setMonth(d.getMonth() + 1)
  else if (cadence === 'yearly') d.setFullYear(d.getFullYear() + 1)
  else d.setDate(d.getDate() + (CADENCE_DAYS[cadence] || 30))
  return isoDate(d)
}

// Confidence is a rough 0–1 signal for sort order only (higher shown first)
// — not surfaced as a hard cutoff, so nothing gets silently hidden.
function confidenceFor(count, amountsConsistent, known) {
  let score = 0.5
  if (count >= 4) score += 0.2
  else if (count >= 3) score += 0.1
  if (known) score += 0.2
  if (amountsConsistent) score += 0.1
  return Math.min(1, score)
}

// Fuzzy "is this merchant already a tracked recurring bill" check —
// substring match either direction against every existing recurring bill's
// (normalized) name, so "Netflix" suggestion is suppressed once the user
// already has a "Netflix" or "Netflix.com" recurring bill, in either
// casing/spacing.
function alreadyTracked(dispNameLower, existingRecurring) {
  return (existingRecurring || []).some((r) => {
    const n = normalizeMerchant(r.desc)
    if (!n) return false
    return dispNameLower.includes(n) || n.includes(dispNameLower)
  })
}

// detectRecurring(transactions, existingRecurring) -> suggestion[]
// {key, displayName, cadence, avgAmount, lastDate, nextEstDate, count,
//  accountId, cat, confidence}
// Only considers expense transactions (excludes income/transfer/debt, which
// aren't spending) grouped by merchant key. Weekly/biweekly/monthly are
// classified against only the last ~4 months (WINDOW_DAYS) of that group's
// charges — "go back 4 months" per the request — so a bill that stopped
// months ago stops being suggested on its own; yearly is a bonus check
// against the group's full history (tryClassifyYearly) since 4 months can't
// possibly show a yearly cadence. Either way a group needs >=2 qualifying
// charges, amounts consistent within ~10% of the median (or the $0.50 floor),
// and — for monthly specifically — day-of-month consistency (±4 days of the
// median day), i.e. "same amount, around the same time," not just a
// plausible average interval. Groups already covered by an existing
// recurring bill (fuzzy name match) are dropped — the point is to surface
// bills the user hasn't already added, not to duplicate what's tracked.
// Runs entirely client-side against state.transactions/state.recurring
// (views/Recurring.jsx's useMemo) — no AI, no network call, no user prompt;
// it just re-runs automatically whenever those change.
export function detectRecurring(transactions, existingRecurring = []) {
  const expenses = (transactions || []).filter((t) => t.type === 'expense' && t.cat !== 'income' && t.cat !== 'transfer' && t.cat !== 'debt' && t.desc)

  const groups = new Map() // key -> tx[] (full history)
  for (const t of expenses) {
    const key = merchantKey(t.desc)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }

  const cutoff = Date.now() - WINDOW_DAYS * DAY_MS
  const out = []
  for (const [key, allTxs] of groups) {
    const recentTxs = allTxs.filter((t) => new Date(t.date + 'T00:00:00').getTime() >= cutoff)
    const match = tryClassifyRecent(recentTxs) || tryClassifyYearly(allTxs)
    if (!match) continue
    const { sorted, cadence } = match

    const disp = displayName(sorted[sorted.length - 1].desc)
    if (alreadyTracked(disp.toLowerCase(), existingRecurring)) continue

    const last = sorted[sorted.length - 1]
    const amounts = sorted.map((t) => t.amount)
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length
    const known = !!knownSubMatch(String(last.desc || '').toLowerCase())

    out.push({
      key,
      displayName: disp,
      cadence,
      avgAmount,
      lastDate: last.date,
      nextEstDate: estimateNextDate(last.date, cadence),
      count: sorted.length,
      accountId: last.accountId || null,
      cat: last.cat || 'other',
      confidence: confidenceFor(sorted.length, true, known),
    })
  }

  return out.sort((a, b) => b.confidence - a.confidence || a.displayName.localeCompare(b.displayName))
}
