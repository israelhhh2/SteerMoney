// Wescom Credit Union checking-history CSV parser.
// Format (no header row):  MM/DD/YYYY,"Description",-$43.17,$balance,$balance
// Negative amount = expense, positive = income/refund. Balance columns are ignored.

// Strip the noise Wescom adds: "Check Card: " prefix, trailing post date, card suffix.
export function cleanDesc(raw) {
  return String(raw)
    .replace(/^Check Card:\s*/i, '')
    .replace(/\s*Card Ending #\d+/gi, '')
    .replace(/\s+\d{2}\/\d{2}\/\d{2}$/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

const LINE = /^(\d{2})\/(\d{2})\/(\d{4}),"((?:[^"]|"")*)",(-?)\$([\d,]+\.\d{2})/

// -> [{ date:'2026-07-25', desc, amount, type }] · unparseable lines are skipped
export function parseWescomCSV(text) {
  const out = []
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(LINE)
    if (!m) continue
    const [, mm, dd, yyyy, rawDesc, neg, amt] = m
    out.push({
      date: `${yyyy}-${mm}-${dd}`,
      desc: cleanDesc(rawDesc.replace(/""/g, '"')),
      amount: parseFloat(amt.replace(/,/g, '')),
      type: neg ? 'expense' : 'income',
    })
  }
  return out
}

// Keyword rules derived from how the statement data was hand-categorized.
// Order matters: ACH bill-pay strings (TYPE:) are checked before merchant names.
const EXPENSE_RULES = [
  ['debt', /CAPITAL ONE|WELLS FARGO CARD|APPLECARD|CHASE CREDIT|CITI AUTOPAY|NORDSTROM PYMT|TJX REWARDS|AMZ_STORECRD|TARGET CARD SRVC|BEST BUY TYPE|KLARNA TYPE|AFFIRM\.COM|To CC |Credit Card Payment|To Loan|WESCOM CU/i],
  ['transfer', /To Share \d|From Share \d/i],
  ['housing', /Sonnocco|AppFolio/i],
  ['utilities', /T-MOBILE|FRONTIER|SO CAL EDISON|SOCALGAS|LB WATER/i],
  ['auto', /ARCO|COSTCO GAS|CHEVRON|SHELL OIL|AAA CA INSURANCE|CAR WASH|PAYBYPHONE|AUTOZONE|TOYOTA.*LEASE|76 -|MOBIL/i],
  ['cash', /Cash Withdrawal|APPLE CASH|SAN YSIDRO/i],
  ['subscriptions', /SPOTIFY|DISNEY PLUS|AUDIBLE|ANTHROPIC|NETFLIX|HULU|OURARING|UBER \*ONE|MYFREESCORENOW|GOOGLE \*Workspace|FANDANGOCLUB|BRANDCROWD|PATREON|ICLOUD|APPLE\.COM\/BILL/i],
  ['kids', /CHUCK E CHEESE|FIVE BELOW|BLUESOMB|AYSO|KIDS/i],
  ['entertainment', /^DLR |Cinemark|REGAL |FANDANGO|NAYAX|KALSHI|AMC #|DISNEYLAND/i],
  ['groceries', /NORTHGATE|ALBERTSONS|TRADER JOE|SPROUTS|GROCERY OUTLET|COSTCO WHSE|VONS|RALPHS|FOOD 4 LESS|SUPERIOR GROCERS/i],
  ['dining', /IN-N-OUT|MCDONALD|STARBUCKS|CHICK-FIL-A|CHIPOTLE|^TST\*?\s|^DD \*|DOORDASH|SUBWAY|CARLS JR|DIN ?TAI ?FUNG|TIERRA MIA|KING'S HAWAIIAN|BOILING CRAB|WINGSTOP|TACO|BURGER|PIZZA|COFFEE|CAFE|RESTAURANT|THAI|SUSHI|CHILI'S|COLD STONE|BUNDT|CRAB|SEAFOOD|CHINA EXPRESS|SQ \*/i],
  ['personal', /CVS|WALGREENS|SEPHORA|NAILS|SALON|BEAUTY|BARBER|Squire|ULTA/i],
  ['household', /HOME DEPOT|LOWE'?S|IKEA/i],
  ['family', /^ZELLE /i],
  ['shopping', /AMAZON|TARGET|KOHL|ROSS |TJ ?MAXX|MARSHALLS|BEST BUY|SHEIN|ETSY|CHEWY|Afterpay|Klarna\*|MICHAELS|SHOWPO|NORDSTROM RACK|OLD NAVY|H&M|ZARA|WALMART|EBAY/i],
]

const INCOME_RULES = [
  ['transfer', /From Share \d|To Share \d/i],
  ['income', /PAYROLL|: P2P|^ZELLE |DIRECT DEP/i],
]

// Guess a category: reuse what an identical past transaction used (learns from
// your edits), otherwise fall back to the keyword rules above.
export function guessCat(desc, type, transactions, validCats) {
  const seen = transactions.find((t) => t.type === type && t.desc === desc)
  if (seen && validCats.has(seen.cat)) return seen.cat
  for (const [cat, re] of type === 'income' ? INCOME_RULES : EXPENSE_RULES) {
    if (re.test(desc) && validCats.has(cat)) return cat
  }
  if (type === 'income') {
    // positive merchant charge = refund -> keep the merchant's expense category
    for (const [cat, re] of EXPENSE_RULES) if (re.test(desc) && validCats.has(cat)) return cat
    return 'income'
  }
  return 'other'
}
