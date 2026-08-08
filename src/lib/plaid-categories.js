// Maps Plaid's `personal_finance_category` (the modern taxonomy returned by
// transactionsSync — primary + detailed, see
// https://plaid.com/documents/pfc-taxonomy-all.csv) onto this app's own
// category ids, so a freshly synced transaction lands in a category that
// actually means something on Dashboard's "This Month by Category" donut,
// Charts, and Budgets from day one — not just "other" for everything.
//
// App category ids in play (see store.jsx's DEFAULT_CATEGORIES for the
// budget-backed ones, and Transactions.jsx's `validCats` for the full set
// every view already knows how to render even without a matching budget
// row): 'housing', 'groceries', 'dining', 'auto', 'utilities' (budget ids),
// plus the non-budget special ids 'debt', 'income', 'transfer', 'other'.
//
// Deliberately conservative: only maps PFC values onto app ids that already
// exist by default. Anything not covered below (entertainment, medical,
// personal care, general merchandise, travel, bank fees, ...) falls through
// to 'other' — that's an existing, already-handled bucket, not a bug. Users
// can always re-categorize afterward in the Transactions view.

// Detailed (most specific) mappings checked first — these disambiguate
// primaries that straddle more than one app category (RENT_AND_UTILITIES,
// FOOD_AND_DRINK's restaurants vs. GENERAL_MERCHANDISE's groceries, and
// TRANSPORTATION's various sub-kinds).
const DETAILED_MAP = {
  // Groceries live under GENERAL_MERCHANDISE in the PFC taxonomy, not FOOD_AND_DRINK.
  GENERAL_MERCHANDISE_SUPERMARKETS_AND_GROCERIES: 'groceries',

  // Dining out.
  FOOD_AND_DRINK_RESTAURANT: 'dining',
  FOOD_AND_DRINK_COFFEE: 'dining',
  FOOD_AND_DRINK_FAST_FOOD: 'dining',
  FOOD_AND_DRINK_BEER_WINE_AND_LIQUOR: 'dining',

  // Rent/mortgage vs. the utility bills that share the RENT_AND_UTILITIES primary.
  RENT_AND_UTILITIES_RENT: 'housing',
  RENT_AND_UTILITIES_MORTGAGE: 'housing',
  RENT_AND_UTILITIES_GAS_AND_ELECTRICITY: 'utilities',
  RENT_AND_UTILITIES_INTERNET_AND_CABLE: 'utilities',
  RENT_AND_UTILITIES_TELEPHONE: 'utilities',
  RENT_AND_UTILITIES_WATER: 'utilities',
  RENT_AND_UTILITIES_SEWAGE_AND_WASTE_MANAGEMENT: 'utilities',
  RENT_AND_UTILITIES_OTHER_UTILITIES: 'utilities',

  // Car & gas specifics.
  TRANSPORTATION_GAS: 'auto',
  TRANSPORTATION_PARKING: 'auto',
  TRANSPORTATION_PUBLIC_TRANSIT_SERVICES: 'auto',
  TRANSPORTATION_TAXIS_AND_RIDE_SHARES: 'auto',
  TRANSPORTATION_TOLLS: 'auto',
}

// Primary-level fallback, used when there's no more specific `detailed`
// match above (or `detailed` itself is missing/unrecognized).
const PRIMARY_MAP = {
  INCOME: 'income',
  TRANSFER_IN: 'transfer',
  TRANSFER_OUT: 'transfer',
  LOAN_PAYMENTS: 'debt',
  RENT_AND_UTILITIES: 'housing',
  FOOD_AND_DRINK: 'dining',
  TRANSPORTATION: 'auto',
  HOME_IMPROVEMENT: 'housing',
  // Everything else Plaid returns (BANK_FEES, ENTERTAINMENT,
  // GENERAL_MERCHANDISE, MEDICAL, PERSONAL_CARE, GENERAL_SERVICES,
  // GOVERNMENT_AND_NON_PROFIT, TRAVEL, OTHER, ...) has no obvious home in
  // this app's small default category set — falls through to 'other'.
}

// tx: a Plaid transaction object from transactionsSync (added/modified).
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
