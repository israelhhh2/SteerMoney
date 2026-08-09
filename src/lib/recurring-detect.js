// Client-side subscription/recurring-charge detector — pure functions, no
// store/network access, called on demand from views/Recurring.jsx against
// state.transactions. No cron/background job: this is a "find bills you
// already have" screen the user opens, not a scheduled sync (the app's only
// other scheduled-ish work is Plaid's own webhook/backfill — see
// lib/plaid-sync.js — which is unrelated).
import { isoDate } from './utils'
import { cleanDisplayName } from './tx-display'

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

// General-purpose merchant-name cleanup — first runs the same bank-statement
// cleanup Transactions.jsx's mobile rows use (lib/tx-display.js's
// cleanDisplayName: strips "Check Card:"/"POS Debit:"/ACH prefixes, masked
// card runs like "XXXXXXXX1234", trailing "Ref# 12345"/post dates), THEN
// lowercases and strips remaining domain suffixes/punctuation/long numeric
// tails. Running cleanDisplayName first is what makes the grouping key
// consistent ACROSS DIFFERENT BANKS/CARDS — Wells Fargo, Capital One, and
// Wescom each format the same merchant's statement line differently (one
// might prefix "PURCHASE AUTHORIZED ON 4/12 NETFLIX.COM", another just
// "NETFLIX.COM 8*3XXXX1234"), and without a shared cleanup pass first those
// produced two different merchantKeys — meaning the same subscription never
// reached the >=2-occurrences threshold if it happened to be split across
// two accounts. Used both as the grouping key fallback (when no
// known-subscription hint matches) and to build a friendly display name for
// merchants not in the known list.
export function normalizeMerchant(desc) {
  let s = cleanDisplayName(desc).toLowerCase()
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
// back to the cleaned merchant string. Deliberately NOT scoped to an
// account — callers pass every transaction across every linked account in
// one list (see detectRecurring below), so a subscription charged to a
// Wells Fargo card one month and a Capital One card the next still groups
// into a single suggestion instead of two never-qualifying halves.
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

// ---- non-subscription exclusions ----
// Interest charges, credit-card bill payments/autopay, transfers, cash
// advances, and fees are real, recurring-looking transactions (same amount,
// roughly monthly) — but they're never "subscriptions": a user paying down
// their card balance every month, or eating a monthly interest charge,
// shouldn't be suggested as a bill to add. Matched case-insensitively
// against the raw description (same field cadence detection already groups
// on), as a net ON TOP OF (not instead of) the existing category-based
// filter in detectRecurring below (that filter already drops rows Plaid/the
// user filed under 'transfer' or 'debt' — this list catches the same kinds
// of rows when they land under 'other' instead, which is what
// mapPlaidCategory does for BANK_FEES and some LOAN_PAYMENTS sub-types).
// Deliberately conservative and keyword-based (no ML/heuristics) so it's
// easy to reason about and extend. UNCHANGED from the previous detector —
// kept exactly as-is per the "don't remove these" instruction.
const EXCLUDE_PATTERNS = [
  /interest\s*charge/i,          // "Interest Charge On Cash Advances/Purchases"
  /finance\s*charge/i,
  /cash\s*advance/i,             // cash-advance fees/transactions
  /crcardpmt/i,                  // "Capital One Type Crcardpmt Co..."
  /cr\s*crd\s*pmt/i,
  /credit\s*card\s*pay(ment)?/i,
  /card\s*pmt/i,
  /payment\s*thank\s*you/i,      // "AMEX Payment Thank You"-style CC autopay
  /\bautopay\b/i,
  /\bepay\b/i,
  /\bpymt\b/i,
  /\btransfer\b/i,
  /\bxfer\b/i,
  /\bfee\b/i,                    // late/overdraft/annual/maintenance/NSF/ATM fees
]

function isExcludedMerchant(desc) {
  return EXCLUDE_PATTERNS.some((re) => re.test(String(desc || '')))
}

// ---- cadence classification ----
const DAY_MS = 86400000

// [name, loGap, hiGap] — a single-period consecutive-gap band, in days.
// Order matters: gapCadence (below) tries these in order and returns the
// first (shortest-period) cadence whose band explains every gap in the
// group, so a genuinely weekly merchant doesn't get mis-classified as
// "biweekly with one missed week."
const CADENCE_RANGES = [
  ['weekly', 6, 8],
  ['biweekly', 13, 16],
  ['monthly', 28, 33],
  ['quarterly', 88, 95],
  ['yearly', 360, 372],
]
export const CADENCE_LABEL = { weekly: 'weekly', biweekly: 'every 2 weeks', monthly: 'monthly', quarterly: 'every 3 months', yearly: 'yearly' }
const CADENCE_STEP_DAYS = { weekly: 7, biweekly: 14, monthly: 30, quarterly: 91, yearly: 365 }
// Once a group's most recent charge is older than this many days for its
// matched cadence, stop suggesting it — it's very likely been cancelled
// rather than still "recurring." Roughly 2x the cadence step + slack.
const MAX_STALE_DAYS = { weekly: 21, biweekly: 35, monthly: 70, quarterly: 200, yearly: 420 }

function median(nums) {
  const s = [...nums].sort((a, b) => a - b)
  const n = s.length
  if (!n) return 0
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2
}

function dateOf(t) {
  return new Date(t.date + 'T00:00:00').getTime()
}

// A gap fits a cadence's "missed period" band at roughly double the normal
// band ("allowing one missed period" — a subscription that skipped a single
// billing cycle, e.g. a declined card retried the next month, still reads
// as that cadence rather than getting dropped for one irregular gap). The
// missed-period band is widened a few days past a clean 2x to absorb
// month-length drift (28 vs 31-day months compounding across two cycles).
function inMissedBand(gapDays, lo, hi) {
  const missedLo = lo * 2 - 3
  const missedHi = hi * 2 + 5
  return gapDays >= missedLo && gapDays <= missedHi
}

// Rule (a) — interval-based: every consecutive gap between sorted charges
// fits one cadence's band. Two passes, both trying cadences shortest-period
// first:
//   1. Strict pass — every gap lands in the cadence's normal [lo,hi] band,
//      no missed-period slack. Runs first and wins outright when it
//      matches, because a "missed period" band and the NEXT cadence's
//      normal band can overlap (biweekly-missed = ~23-37d, which swallows
//      an ordinary ~30d monthly gap) — without this strict-first pass, a
//      clean monthly-every-month merchant could get mis-read as "biweekly
//      with one missed period" purely because biweekly sorts first.
//   2. Missed-period pass — only reached if nothing matched strictly; every
//      gap must land in the cadence's normal band OR its missed-period
//      band (inMissedBand), so a merchant that actually skipped a cycle
//      still classifies correctly.
function gapCadence(sortedTxs) {
  if (sortedTxs.length < 2) return null
  const gaps = []
  for (let i = 1; i < sortedTxs.length; i++) gaps.push(Math.round((dateOf(sortedTxs[i]) - dateOf(sortedTxs[i - 1])) / DAY_MS))
  if (gaps.some((g) => g <= 0)) return null // same-day/out-of-order noise, shouldn't happen post-dedupe

  for (const [name, lo, hi] of CADENCE_RANGES) {
    if (gaps.every((g) => g >= lo && g <= hi)) return name
  }
  for (const [name, lo, hi] of CADENCE_RANGES) {
    if (gaps.every((g) => (g >= lo && g <= hi) || inMissedBand(g, lo, hi))) return name
  }
  return null
}

// Rule (b) — day-of-month based: every charge's day-of-month falls within
// ±2 of the group's median day-of-month, regardless of exact interval.
// Catches cases rule (a) misses — e.g. a bill that lands on the 1st most
// months but the 3rd when the 1st is a Sunday, combined with one skipped
// month, can produce a gap outside even the "missed period" band, while the
// day-of-month itself stayed rock-steady. The group's own median gap then
// picks which "same day, N months apart" cadence it actually is (monthly/
// quarterly/yearly — weekly/biweekly dates don't share a day-of-month by
// construction, so this rule naturally doesn't fire for them).
function domCadence(sortedTxs) {
  if (sortedTxs.length < 2) return null
  const doms = sortedTxs.map((t) => new Date(t.date + 'T00:00:00').getDate())
  const med = median(doms)
  if (!doms.every((d) => Math.abs(d - med) <= 2)) return null
  const gaps = []
  for (let i = 1; i < sortedTxs.length; i++) gaps.push(Math.round((dateOf(sortedTxs[i]) - dateOf(sortedTxs[i - 1])) / DAY_MS))
  if (gaps.some((g) => g <= 0)) return null
  const medGap = median(gaps)
  if (medGap >= 20 && medGap <= 45) return 'monthly'
  if (medGap >= 75 && medGap <= 105) return 'quarterly'
  if (medGap >= 320 && medGap <= 410) return 'yearly'
  return null
}

// "Same amount" — within max($2, 15%) of the group median. Loosened from
// the previous ~10%/$0.50 floor: subscriptions routinely carry a price bump
// (e.g. $9.99 -> $11.99) or tax that a tight 10% band rejected outright,
// which was silently dropping otherwise-obvious matches.
function amountsAreConsistent(amounts, medAmount) {
  return amounts.every((a) => Math.abs(a - medAmount) <= Math.max(medAmount * 0.15, 2))
}

// Consecutive same-date entries (already date-sorted, so dupes are
// adjacent) collapse to one — guards gapCadence/domCadence's gap math
// against a 0-day gap, which would otherwise fail every cadence band. This
// is what "dedupe if the same subscription shows on two accounts" means in
// practice for a rare same-day double-post; the later entry in the sorted
// list wins, which combined with sorting by date (not a secondary account
// tiebreak) simply keeps one representative — see the accountId comment on
// the group's `last` transaction below for the actual "prefer most recent
// account" behavior that matters for the common case (a subscription that
// moved from one card to another over time, not same-day duplicates).
function dedupeSameDay(sorted) {
  const out = []
  for (const t of sorted) {
    if (out.length && out[out.length - 1].date === t.date) out[out.length - 1] = t
    else out.push(t)
  }
  return out
}

function estimateNextDate(lastDateIso, cadence) {
  const d = new Date(lastDateIso + 'T00:00:00')
  if (cadence === 'monthly') d.setMonth(d.getMonth() + 1)
  else if (cadence === 'quarterly') d.setMonth(d.getMonth() + 3)
  else if (cadence === 'yearly') d.setFullYear(d.getFullYear() + 1)
  else d.setDate(d.getDate() + (CADENCE_STEP_DAYS[cadence] || 30))
  return isoDate(d)
}

// Confidence is a rough 0–1 signal for sort order only (higher shown first)
// — not surfaced as a hard cutoff, so nothing gets silently hidden. Per the
// brief, 2 occurrences is the minimum signal (weakest), 3+ is high
// confidence; a known-subscription-list hit adds a little more certainty.
function confidenceFor(count, known) {
  let score = 0.45
  if (count >= 4) score += 0.3
  else if (count >= 3) score += 0.2
  else score += 0.05
  if (known) score += 0.2
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
// {key, displayName, cadence, avgAmount, amount, lastDate, nextEstDate,
//  typicalDay, count, accountId, cat, confidence, confidenceLabel}
//
// Only considers expense transactions (excludes income/transfer/debt, which
// aren't spending, and interest charges/CC payments/cash advances/fees per
// EXCLUDE_PATTERNS above, which are spending but never subscriptions),
// grouped by merchant key ACROSS EVERY ACCOUNT AT ONCE — `transactions` is
// the caller's full list (every linked Wells Fargo/Capital One/Wescom
// account combined, plus manual/CSV rows), never filtered or grouped
// per-account first, so a subscription that happens to post to more than
// one card over its lifetime still accumulates enough occurrences in a
// single bucket to qualify (previously a real risk if per-account grouping
// had ever been introduced — it hasn't, but this is now explicit and
// commented so it stays that way).
//
// A group qualifies with >=2 occurrences (>=3 is "high" confidence) once
// same-date duplicates are collapsed (dedupeSameDay) AND amounts are within
// max($2, 15%) of the group median AND EITHER gapCadence (rule a — interval
// bands, one missed period tolerated) or domCadence (rule b — same
// day-of-month within ±2, independent of exact interval) returns a cadence.
// A group whose most recent charge is older than MAX_STALE_DAYS for its
// matched cadence is dropped (very likely cancelled, not "still recurring").
// Groups fuzzy-matching an existing recurring bill are dropped too — the
// point is bills the user hasn't already added.
//
// `accountId`/`cat`/`amount` all come from the group's most recent charge
// (`last`, after sorting) — so when the same subscription shows on two
// accounts, the more recently-charged account naturally wins, per the
// "prefer the most recent account" requirement, with zero extra bookkeeping
// needed beyond sorting by date.
//
// Runs entirely client-side against state.transactions/state.recurring
// (views/Recurring.jsx's useMemo) — no AI, no network call, no user prompt;
// it just re-runs automatically whenever those change.
export function detectRecurring(transactions, existingRecurring = []) {
  const expenses = (transactions || []).filter((t) => t.type === 'expense' && t.cat !== 'income' && t.cat !== 'transfer' && t.cat !== 'debt' && t.desc && !isExcludedMerchant(t.desc))

  const groups = new Map() // key -> tx[], spans every account
  for (const t of expenses) {
    const key = merchantKey(t.desc)
    if (!key) continue
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(t)
  }

  const now = Date.now()
  const out = []
  for (const [key, txs] of groups) {
    if (txs.length < 2) continue
    const sorted = dedupeSameDay(txs.slice().sort((a, b) => a.date.localeCompare(b.date)))
    if (sorted.length < 2) continue

    const amounts = sorted.map((t) => t.amount)
    const medAmount = median(amounts)
    if (!amountsAreConsistent(amounts, medAmount)) continue

    const cadence = gapCadence(sorted) || domCadence(sorted)
    if (!cadence) continue

    const last = sorted[sorted.length - 1]
    const staleDays = (now - dateOf(last)) / DAY_MS
    if (staleDays > (MAX_STALE_DAYS[cadence] || 90)) continue

    const disp = displayName(last.desc)
    if (alreadyTracked(disp.toLowerCase(), existingRecurring)) continue

    const doms = sorted.map((t) => new Date(t.date + 'T00:00:00').getDate())
    const typicalDay = ['monthly', 'quarterly', 'yearly'].includes(cadence) ? Math.round(median(doms)) : null
    const known = !!knownSubMatch(String(last.desc || '').toLowerCase())

    out.push({
      key,
      displayName: disp,
      cadence,
      // `amount` is the most recent charge per the spec ("amount (most
      // recent)"); `avgAmount` is kept as the same value under its old name
      // so views/Recurring.jsx's existing `s.avgAmount` reads keep working
      // unchanged — it's simply no longer an average across history, which
      // is a better number to prefill "Add" with anyway (price bumps mean
      // the average trails what's actually being charged now).
      amount: last.amount,
      avgAmount: last.amount,
      lastDate: last.date,
      nextEstDate: estimateNextDate(last.date, cadence),
      typicalDay,
      count: sorted.length,
      accountId: last.accountId || null,
      cat: last.cat || 'other',
      confidence: confidenceFor(sorted.length, known),
      confidenceLabel: sorted.length >= 3 ? 'high' : 'medium',
    })
  }

  return out.sort((a, b) => b.confidence - a.confidence || a.displayName.localeCompare(b.displayName))
}
