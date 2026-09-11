// Maps Plaid's `personal_finance_category` (the modern taxonomy returned by
// transactionsSync — primary + detailed, see
// https://plaid.com/documents/pfc-taxonomy-all.csv) onto this app's own
// category ids, so a freshly synced transaction lands in a category that
// actually means something on Dashboard's "This Month by Category" donut,
// Charts, and Budgets from day one — not just "other" for everything.
//
// App category ids in play: every id in lib/categories.js's CATEGORY_DEFS
// (the full default taxonomy — housing/utilities/groceries/dining/auto/
// transport/shopping/entertainment/subscriptions/health/personal/household/
// kids/family/travel/education/fees/cash/business/other), plus the four
// fixed non-budget ids: 'debt', 'income', 'transfer', 'refund'. 'refund' is
// assigned one level up, in lib/plaid-sync.js's classifyTx(), which is also
// where the LOAN_PAYMENTS 'debt' this file returns can get overridden to
// 'transfer' for a credit-card bill payment.
//
// PRODUCTION HISTORY (2026-09): this file used to be deliberately
// conservative — it only mapped PFC values onto the 6 categories that
// existed by default at the time (housing/groceries/dining/auto/utilities/
// other), so everything else (entertainment, medical, personal care,
// general merchandise, travel, bank fees, ...) fell through to 'other' even
// though Plaid had a specific personal_finance_category for it. That's why
// 491 of 883 real transactions (56%) sat in 'other': Plaid had the data,
// this file just wasn't using it. Now that lib/categories.js's taxonomy has
// a home for nearly everything Plaid returns, this covers the full PFC
// taxonomy — see the table below for every primary/detailed value and which
// app category it lands in, plus the reasoning for the genuinely ambiguous
// ones.
//
// ---- PFC -> app category table (compact) ----
// (primary shown once; only detailed overrides that differ from the
// primary's own fallback are called out)
//   INCOME_*                                          -> income
//   TRANSFER_IN_* (deposit/account transfer/cash advance) -> transfer
//   TRANSFER_OUT_WITHDRAWAL                           -> cash
//   TRANSFER_OUT_* (everything else)                  -> transfer
//   LOAN_PAYMENTS_* (incl. CREDIT_CARD_PAYMENT)        -> debt (see
//     lib/plaid-sync.js's classifyTx() for the CREDIT_CARD_PAYMENT ->
//     'transfer' override once the paying account's type is known)
//   BANK_FEES_*                                        -> fees
//   ENTERTAINMENT_TV_AND_MOVIES                        -> subscriptions
//   ENTERTAINMENT_MUSIC_AND_AUDIO                      -> subscriptions
//   ENTERTAINMENT_* (video games, sporting events/amusement
//     parks/museums, casinos/gambling, everything else)  -> entertainment
//   FOOD_AND_DRINK_RESTAURANT/COFFEE/FAST_FOOD/
//     BEER_WINE_AND_LIQUOR/VENDING_MACHINES/other       -> dining
//   FOOD_AND_DRINK_GROCERIES (rare/legacy value)        -> groceries
//   GENERAL_MERCHANDISE_SUPERMARKETS_AND_GROCERIES      -> groceries
//   GENERAL_MERCHANDISE_CONVENIENCE_STORES              -> groceries
//   GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES              -> family
//   GENERAL_MERCHANDISE_PET_SUPPLIES                     -> household
//   GENERAL_MERCHANDISE_* (online marketplaces, superstores like
//     Target/Costco, everything else)                   -> shopping
//     NOTE: Target/Costco-style superstores are genuinely ambiguous
//     (groceries AND general shopping in one trip) — left as 'shopping'
//     per the PM brief; a user-created rule can override per-merchant.
//   HOME_IMPROVEMENT_*                                  -> household
//   MEDICAL_* (incl. VETERINARY_SERVICES, PHARMACIES_AND_SUPPLEMENTS)
//                                                        -> health
//   PERSONAL_CARE_* (incl. GYMS_AND_FITNESS_CENTERS — kept as
//     'personal', not 'subscriptions': a gym membership is personal
//     care first, recurring-bill-ness is orthogonal)      -> personal
//   GENERAL_SERVICES_EDUCATION                          -> education
//   GENERAL_SERVICES_CHILDCARE                          -> kids
//   GENERAL_SERVICES_INSURANCE                          -> household
//     (no dedicated "insurance" category; household chosen over 'fees'
//     since insurance is a recurring cost of maintaining what you own,
//     not a bank/finance fee — documented tradeoff, easy to override)
//   GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING,
//     CONSULTING_AND_LEGAL, POSTAGE_AND_SHIPPING          -> business
//   GENERAL_SERVICES_STORAGE                             -> household
//   GENERAL_SERVICES_AUTOMOTIVE                          -> auto
//   GENERAL_SERVICES_* (everything else, e.g. "OTHER_GENERAL_SERVICES")
//                                                        -> other
//   GOVERNMENT_AND_NON_PROFIT_DONATIONS                  -> family
//   GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT,
//     GOVERNMENT_DEPARTMENTS_AND_AGENCIES                -> fees
//   GOVERNMENT_AND_NON_PROFIT_* (everything else)        -> other
//   TRANSPORTATION_GAS/PARKING/TOLLS                     -> auto
//   TRANSPORTATION_TAXIS_AND_RIDE_SHARES/
//     PUBLIC_TRANSIT_SERVICES/BIKES_AND_SCOOTERS         -> transport
//   TRANSPORTATION_* (everything else)                   -> auto
//   TRAVEL_*                                             -> travel
//   RENT_AND_UTILITIES_RENT/MORTGAGE                     -> housing
//   RENT_AND_UTILITIES_* (gas & electricity, internet & cable,
//     telephone, water, sewage/waste, everything else)    -> utilities
//   HOME_IMPROVEMENT_*                                   -> household
//   (anything with no personal_finance_category at all)  -> keyword
//     fallback (see lib/plaid-sync.js's guessCategory/CATEGORY_RULES),
//     else 'other'

// Detailed (most specific) mappings checked first — these disambiguate
// primaries that straddle more than one app category.
const DETAILED_MAP = {
  // ---- groceries vs. general shopping ----
  GENERAL_MERCHANDISE_SUPERMARKETS_AND_GROCERIES: 'groceries',
  GENERAL_MERCHANDISE_CONVENIENCE_STORES: 'groceries',
  GENERAL_MERCHANDISE_GIFTS_AND_NOVELTIES: 'family',
  GENERAL_MERCHANDISE_PET_SUPPLIES: 'household',
  FOOD_AND_DRINK_GROCERIES: 'groceries', // rare/legacy PFC value, not part of the current taxonomy — mapped defensively in case Plaid ever returns it

  // ---- dining ----
  FOOD_AND_DRINK_RESTAURANT: 'dining',
  FOOD_AND_DRINK_COFFEE: 'dining',
  FOOD_AND_DRINK_FAST_FOOD: 'dining',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'dining',
  FOOD_AND_DRINK_VENDING_MACHINES: 'dining',

  // ---- rent/mortgage vs. the utility bills sharing the RENT_AND_UTILITIES primary ----
  RENT_AND_UTILITIES_RENT: 'housing',
  RENT_AND_UTILITIES_MORTGAGE: 'housing',
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'utilities',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'utilities',
  RENT_AND_UTILITIES_TELEPHONE: 'utilities',
  RENT_AND_UTILITIES_WATER: 'utilities',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: 'utilities',
  RENT_AND_UTILITIES_OTHER_UTILITIES: 'utilities',

  // ---- car & gas vs. rideshare/transit/bikes ----
  TRANSPORTATION_GAS: 'auto',
  TRANSPORTATION_PARKING: 'auto',
  TRANSPORTATION_TOLLS: 'auto',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'transport',
  TRANSPORTATION_PUBLIC_TRANSIT_SERVICES: 'transport',
  TRANSPORTATION_BIKES_AND_SCOOTERS: 'transport',

  // ---- entertainment vs. subscriptions (recurring streaming/media bills) ----
  ENTERTAINMENT_TV_AND_MOVIES: 'subscriptions',
  ENTERTAINMENT_MUSIC_AND_AUDIO: 'subscriptions',
  ENTERTAINMENT_VIDEO_GAMES: 'entertainment',
  ENTERTAINMENT_SPORTING_EVENTS_AMUSEMENT_PARKS_AND_MUSEUMS: 'entertainment',
  ENTERTAINMENT_CASINOS_AND_GAMBLING: 'entertainment',

  // ---- medical (health), incl. two easy-to-miscall subtypes ----
  MEDICAL_VETERINARY_SERVICES: 'health',
  MEDICAL_PHARMACIES_AND_SUPPLEMENTS: 'health',

  // ---- personal care: gym stays 'personal', not 'subscriptions' (see the
  // table comment above for why) ----
  PERSONAL_CARE_GYMS_AND_FITNESS_CENTERS: 'personal',

  // ---- general services: split across education/kids/household/auto/business ----
  GENERAL_SERVICES_EDUCATION: 'education',
  GENERAL_SERVICES_CHILDCARE: 'kids',
  GENERAL_SERVICES_INSURANCE: 'household',
  GENERAL_SERVICES_ACCOUNTING_AND_FINANCIAL_PLANNING: 'business',
  GENERAL_SERVICES_CONSULTING_AND_LEGAL: 'business',
  GENERAL_SERVICES_POSTAGE_AND_SHIPPING: 'business',
  GENERAL_SERVICES_STORAGE: 'household',
  GENERAL_SERVICES_AUTOMOTIVE: 'auto',

  // ---- government & non-profit ----
  GOVERNMENT_AND_NON_PROFIT_DONATIONS: 'family',
  GOVERNMENT_AND_NON_PROFIT_TAX_PAYMENT: 'fees',
  GOVERNMENT_AND_NON_PROFIT_GOVERNMENT_DEPARTMENTS_AND_AGENCIES: 'fees',

  // ---- transfers: withdrawing your own cash out of the banking system ----
  TRANSFER_OUT_WITHDRAWAL: 'cash',
  // Explicit for clarity even though PRIMARY_MAP.TRANSFER_IN already covers these.
  TRANSFER_IN_CASH_ADVANCES_AND_LOANS: 'transfer',
  TRANSFER_IN_DEPOSIT: 'transfer',
  TRANSFER_IN_ACCOUNT_TRANSFER: 'transfer',
}

// Primary-level fallback, used when there's no more specific `detailed`
// match above (or `detailed` itself is missing/unrecognized).
const PRIMARY_MAP = {
  INCOME: 'income',
  TRANSFER_IN: 'transfer',
  TRANSFER_OUT: 'transfer',
  LOAN_PAYMENTS: 'debt',
  BANK_FEES: 'fees',
  ENTERTAINMENT: 'entertainment',
  FOOD_AND_DRINK: 'dining',
  GENERAL_MERCHANDISE: 'shopping',
  HOME_IMPROVEMENT: 'household',
  MEDICAL: 'health',
  PERSONAL_CARE: 'personal',
  // Most GENERAL_SERVICES subtypes are handled by DETAILED_MAP above; an
  // unlisted one (e.g. "OTHER_GENERAL_SERVICES") has no obvious single home,
  // so it falls to 'other' rather than guessing.
  GENERAL_SERVICES: 'other',
  GOVERNMENT_AND_NON_PROFIT: 'other',
  TRANSPORTATION: 'auto',
  TRAVEL: 'travel',
  RENT_AND_UTILITIES: 'utilities',
}

// tx: a Plaid transaction object from transactionsSync/transactionsGet
// (added/modified, or a historical row from a backfill pass — see
// lib/transactions-backfill.js).
// fallback(tx): optional legacy keyword-matcher, tried only if Plaid didn't
// supply a personal_finance_category at all (defensive — some institutions
// don't enrich every transaction, and it costs nothing to try).
export function mapPlaidCategory(tx, fallback) {
  const pfc = tx?.personal_finance_category
  if (pfc?.detailed && DETAILED_MAP[pfc.detailed]) return DETAILED_MAP[pfc.detailed]
  if (pfc?.primary && PRIMARY_MAP[pfc.primary]) return PRIMARY_MAP[pfc.primary]
  if (pfc?.primary) return 'other'
  return (fallback && fallback(tx)) || 'other'
}
