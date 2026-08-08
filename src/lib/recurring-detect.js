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
const CADENCE_RANGES = [
  ['weekly', 6, 8],
  ['biweekly', 12, 16],
  ['monthly', 26, 35],
  ['yearly', 350, 380],
]
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
// aren't spending) grouped by merchant key; a group needs >=2 charges with a
// cadence-classifiable median interval and amounts consistent within ~20% of
// the median (or exact — most subscriptions charge the same cent amount
// every cycle) before it's suggested. Groups already covered by an existing
// recurring bill (fuzzy name match) are dropped — the point is to surface
// bills the user hasn't already added, not to duplicate what's tracked.
export function detectRecurring(transactions, existingRecurring = []) {
  const expenses = (transactions || []).filter((t) => t.type === 'expense' && t.cat !== 'income' && t.cat !== 'transfer' && t.cat !== 'debt' && t.desc)

  const groups = new Map() // key -> tx[]
  for (const t of expenses) {
    const key = merchantKey(t.desc)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }

  const out = []
  for (const [key, txs] of groups) {
    if (txs.length < 2) continue
    const sorted = txs.slice().sort((a, b) => a.date.localeCompare(b.date))
    const dates = sorted.map((t) => new Date(t.date + 'T00:00:00').getTime())
    const intervals = []
    for (let i = 1; i < dates.length; i++) intervals.push(Math.round((dates[i] - dates[i - 1]) / DAY_MS))
    const medianInterval = median(intervals)
    const cadence = classifyCadence(medianInterval)
    if (!cadence) continue

    const amounts = sorted.map((t) => t.amount)
    const medAmount = median(amounts)
    const amountsConsistent = amounts.every((a) => Math.abs(a - medAmount) <= Math.max(medAmount * 0.2, 0.5))
    if (!amountsConsistent) continue

    const disp = displayName(sorted[sorted.length - 1].desc)
    if (alreadyTracked(disp.toLowerCase(), existingRecurring)) continue

    const last = sorted[sorted.length - 1]
    const avgAmount = amounts.reduce((s, a) => s + a, 0) / amounts.length
    const known = !!knownSubMatch(String(last.desc || '').toLowerCase())

    out.push({
      key,
      displayName: disp,
      cadence,
      avgAmount,
      lastDate: last.date,
      nextEstDate: estimateNextDate(last.date, cadence),
      count: txs.length,
      accountId: last.accountId || null,
      cat: last.cat || 'other',
      confidence: confidenceFor(txs.length, amountsConsistent, known),
    })
  }

  return out.sort((a, b) => b.confidence - a.confidence || a.displayName.localeCompare(b.displayName))
}
