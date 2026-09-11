// Keyword-based category guesser — extracted from lib/plaid-sync.js so it
// can be imported from a 'use client' component (components/statement-
// upload.jsx) without pulling in plaid-sync.js's server-only dependencies
// (lib/plaid-server.js constructs a service-role Supabase client and the
// `plaid` SDK at module load — neither is safe, or even buildable, in a
// browser bundle). Pure, no imports beyond this file — safe on both sides.
// lib/plaid-sync.js re-exports both names from here so every existing
// server-side importer (lib/transactions-backfill.js, this file's own
// classifyTx) is unaffected.
//
// Keyword map from Plaid's merchant/transaction name to this app's category
// ids — a defensive fallback for the rare transaction Plaid doesn't enrich
// with a `personal_finance_category` at all (the primary categorization path
// is mapPlaidCategory(), which reads Plaid's actual PFC taxonomy instead of
// guessing from the name), and also the ONLY categorizer available for
// imported/manual transactions that never went through Plaid at all (see
// lib/transactions-backfill.js's second pass, and now components/statement-
// upload.jsx's row-preview default). Extended to the full lib/categories.js
// taxonomy alongside mapPlaidCategory's PFC table — order matters (first
// match wins), and borrows some vocabulary from lib/wescom.js's own
// EXPENSE_RULES (that file's rules stay merchant-name specific to Wescom's
// CSV export; these stay generic enough for any institution's Plaid
// `name`/`merchant_name`, or a statement-upload description).
export const CATEGORY_RULES = [
  ['housing', /\brent\b|mortgage|\bhoa\b/i],
  ['groceries', /grocery|market|supermarket|trader joe|whole foods|costco whse|vons|ralphs|albertsons|sprouts/i],
  ['dining', /restaurant|starbucks|coffee|pizza|mcdonald|chipotle|doordash|grubhub|\bcafe\b/i],
  ['transport', /\buber\b|\blyft\b|transit|\bmetro\b|amtrak|bike share|scooter/i],
  ['auto', /\bgas station\b|\bfuel\b|auto repair|chevron|\bshell\b|\barco\b|\bmobil\b|parking|\btoll/i],
  ['utilities', /electric|internet|\bcable\b|phone bill|utility|t-mobile|verizon|at&t|comcast/i],
  ['subscriptions', /netflix|\bhulu\b|spotify|disney\+|apple\.com\/bill|icloud|patreon|audible/i],
  ['entertainment', /cinema|movie|\bamc\b|regal |fandango|casino|amusement|museum/i],
  ['health', /pharmacy|\bcvs\b|walgreens|medical|clinic|doctor|dental|veterinary|\bvet\b/i],
  ['personal', /\bsalon\b|\bspa\b|barber|nails|beauty/i],
  ['household', /home depot|lowe.?s|\bikea\b|hardware|storage/i],
  ['kids', /daycare|childcare|toys.?r.?us/i],
  ['family', /\bgift\b|\bzelle\b|\bvenmo\b/i],
  ['travel', /airline|\bhotel\b|airbnb|expedia|\bdelta\b|united air|southwest/i],
  ['education', /tuition|\bschool\b|university|college/i],
  ['fees', /overdraft|late fee|interest charge|service fee|\birs\b|tax payment/i],
  ['cash', /\batm\b|cash withdrawal/i],
  ['business', /shipping|postage|legal services|accounting/i],
  ['shopping', /amazon|\btarget\b|walmart|\bebay\b/i],
]

export function guessCategory(tx) {
  const text = [tx.merchant_name, tx.name].filter(Boolean).join(' ')
  for (const [cat, re] of CATEGORY_RULES) if (re.test(text)) return cat
  return 'other'
}
