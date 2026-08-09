// Conservative, display-only cleanup for raw bank transaction descriptions
// (Transactions.jsx / AccountDetail.jsx mobile rows). Never touches stored
// data — `t.desc` in the store/DB stays exactly as synced (plaid-sync.js
// already prefers Plaid's `merchant_name` over the raw `name` at write time
// when one is available; this just tidies up whatever string we end up
// with for the cases where a bank hands back its raw statement text, e.g.
// "Check Card: APPLE CASH SENT", "Hammr Payroll : PAYROLL 000123456",
// "SnapDeposit Ref# 998877", "From Share 00 REGULAR SHAREXXXX1234").
//
// Deliberately narrow: only strips well-known bank-statement noise. If the
// result would come out empty or under 3 characters (i.e. we stripped too
// aggressively, or the string didn't match our assumptions), fall back to
// the original untouched string rather than show something garbled.

// Leading boilerplate banks/processors prepend to the actual merchant name.
const PREFIX_PATTERNS = [
  /^check\s*card:?\s*/i,
  /^pos\s+debit:?\s*/i,
  /^pos\s+purchase:?\s*/i,
  /^debit\s+card\s+purchase:?\s*/i,
  /^ach\s+(debit|credit):?\s*/i,
  /^purchase\s+authorized\s+on\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*/i,
  /^recurring\s+payment\s+authorized\s+on\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*/i,
]

// Noise that can show up anywhere in the string, not just at an edge.
const NOISE_PATTERNS = [
  /\bcard\s+ending\s*#?\s*\d+\b/gi, // "Card Ending #1234"
  // Masked account/card runs, e.g. "XXXXXXXX1234" or "SHAREXXXX0015" — no
  // leading \b since banks often glue these straight onto the preceding
  // word with no space; four-plus consecutive X's essentially never shows
  // up in a real merchant/account name, so this is safe to match anywhere.
  /x{4,}\d*\b/gi,
]

// Trailing junk — reference numbers, store/terminal numbers, post dates,
// long digit runs. Anchored to the end so we only ever trim off the tail,
// never chew into the merchant name itself. Applied repeatedly since these
// can stack ("... Ref# 12345 #6789").
const SUFFIX_PATTERNS = [
  /\s*ref\s*#?\s*\d+.*$/i, // "Ref# 12345[...]"
  /\s*#\d{3,}.*$/, // trailing store/terminal number "#4821"
  /\s*\*+\d{3,}.*$/, // "****1234"
  /\s+\d{1,2}\/\d{1,2}(\/\d{2,4})?\s*$/, // trailing post date
  /\s+\d{6,}\s*$/, // long trailing digit run (store/terminal id)
]

function titleCaseIfShouting(s) {
  if (s.length > 3 && /[A-Z]/.test(s) && s === s.toUpperCase()) {
    return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase())
  }
  return s
}

// Common ACH-style "NAME : TYPE" descriptions (e.g. "Hammr Payroll : PAYROLL
// 000123", "Julia Vallejo : P2P Money Network") — keep just the name half
// when it's long enough to stand alone.
function stripColonSuffix(s) {
  const idx = s.indexOf(' : ')
  if (idx > 2) return s.slice(0, idx)
  return s
}

export function cleanDisplayName(raw) {
  const original = String(raw ?? '').trim()
  if (!original) return original

  let s = stripColonSuffix(original)
  for (const re of PREFIX_PATTERNS) s = s.replace(re, '')
  for (const re of NOISE_PATTERNS) s = s.replace(re, '')

  let prevLen
  do {
    prevLen = s.length
    for (const re of SUFFIX_PATTERNS) s = s.replace(re, '')
    s = s.trim()
  } while (s.length !== prevLen && s.length > 0)

  s = s.replace(/[:\-–—,]+$/, '').replace(/\s+/g, ' ').trim()
  s = titleCaseIfShouting(s)

  if (s.length < 3) return original
  return s
}
