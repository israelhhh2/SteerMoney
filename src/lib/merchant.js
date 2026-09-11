// Cleans a raw Plaid/bank transaction description down to a short, human
// merchant name. Used two ways:
//   1. lib/plaid-sync.js's row builder writes this as the `merchant` column
//      whenever Plaid doesn't supply its own already-clean `merchant_name`
//      (some institutions/transaction types don't get one).
//   2. lib/transactions-backfill.js's second pass (imported/manual rows with
//      no Plaid match at all) uses it the same way.
// Exported standalone (not private to either caller) for future rules/review
// features that want a normalized name to group or match on instead of the
// raw, noisy description.
//
// Deliberately a best-effort heuristic, not a parser: bank/card-processor
// descriptions have no fixed grammar, so this trims the noise patterns that
// actually show up in this app's real transaction data (card-processor
// prefixes, POS/reference boilerplate, trailing city/state, phone numbers,
// dates, "Card Ending #____") and title-cases what's left. A merchant name
// that happens to end in words matching a US state abbreviation could be
// over-trimmed — an accepted tradeoff, same "conservative but useful, user
// can always fix it by hand" spirit as lib/wescom.js's cleanDesc().
//
// Examples (real production descriptions this was built against):
//   "ZELLE GRISEL PHOTOGRAPHY EBD1RVTYD"                                    -> "Grisel Photography"
//   "Withdrawal POS #000011834618 GOOGLE *Workspace wagewat Mountain View CA -> "Google Workspace"
//    Card Ending #1001"
//   "TST* MAMA'S ON 39 - LOS ALAMITOS CA"                                    -> "Mama's On 39"
//   "APPLE.COM/BILL 866-712-7753 CA"                                         -> "APPLE.COM/BILL"
//   "TARGET T-2319 SIGNAL HILL CA"                                           -> "Target"
//   "To Share 01 WESCOM CHECKING"                                            -> "To Share 01 Wescom Checking"

const US_STATES = new Set('AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC'.split(' '))

export function cleanMerchant(description) {
  const original = String(description || '').trim()
  if (!original) return ''
  let s = original

  // ---- card-processor / POS boilerplate prefixes ----
  s = s.replace(/^(SQ|TST)\*\s*/i, '')
  s = s.replace(/^SP\s+/i, '')
  s = s.replace(/^(PAYPAL|PP)\*\s*/i, '')
  s = s.replace(/^AMZN\s*Mktp/i, 'Amazon Marketplace')
  s = s.replace(/^WWW\./i, '')
  s = s.replace(/^ZELLE\s+/i, '') // "who it's from/to" is the actual merchant, not the rail
  s = s.replace(/^Withdrawal\s+POS\s*#\d+\s*/i, '')
  s = s.replace(/\bPOS\s*#\d+\s*/i, '')
  s = s.replace(/\s*Card Ending #\d+/gi, '')
  s = s.replace(/\bPurchase authorized on \d{1,2}\/\d{1,2}\b/i, '')
  s = s.replace(/\*/g, ' ') // "GOOGLE *Workspace" -> "GOOGLE Workspace"

  // ---- phone numbers, bare dates, store numbers ----
  s = s.replace(/\b\d{3}[-.]?\d{3}[-.]?\d{4}\b/g, '')
  s = s.replace(/\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/g, '')
  s = s.replace(/\s+[A-Z]-\d{3,6}\b/i, '') // "TARGET T-2319" -> "TARGET"

  // ---- trailing all-caps reference code (contains a digit, e.g. Zelle's
  // "EBD1RVTYD") — a pure-letter all-caps word (an abbreviation like IKEA)
  // is left alone, only one mixed with digits gets dropped.
  s = s.replace(/\s+(?=[A-Z0-9]*\d)[A-Z0-9]{6,}\s*$/, '')

  s = s.replace(/\s+/g, ' ').trim()

  // ---- trailing "<up to 3 words> <STATE>" (city + state), e.g.
  // "SIGNAL HILL CA" or "Mountain View CA" — bounded so this can only ever
  // eat a handful of trailing words, never the whole merchant name.
  const words = s.split(' ').filter(Boolean)
  if (words.length > 1) {
    const last = words[words.length - 1].replace(/\.$/, '').toUpperCase()
    if (US_STATES.has(last)) {
      words.pop()
      let dropped = 0
      while (dropped < 3 && words.length > 1) { words.pop(); dropped++ }
    }
  }
  s = words.join(' ')

  // ---- trailing zip code, dangling separators ----
  s = s.replace(/\s+\d{5}(-\d{4})?\s*$/, '')
  s = s.replace(/[\s\-–—·,]+$/, '')
  s = s.replace(/\s+/g, ' ').trim()

  if (!s) return original

  // Title-case pure-alpha(+apostrophe) words only — a token containing a
  // digit, dot, or slash (a domain like "APPLE.COM/BILL", an address, an
  // account number fragment) is left exactly as Plaid/the bank sent it
  // rather than guessed at.
  return s
    .split(' ')
    .map((w) => (/^[A-Za-z]+('[A-Za-z]+)?$/.test(w) ? w.charAt(0).toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(' ')
}
