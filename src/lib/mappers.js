// Row <-> state mapping — extracted from store.jsx (2026-09, Reports feature)
// so a plain server module (app/api/reports/snapshot, app/api/reports/export)
// can load/shape the exact same rows store.jsx does without importing a
// 'use client' file. store.jsx still imports `mappers` from here unchanged —
// this is a pure relocation, not a behavior change; see its own comment for
// why DB column names avoid SQL keywords (desc, limit, min) while state keeps
// the original shapes so the page components are unchanged from the Vite app.
export const mappers = {
  debts: {
    toRow: (d, userId) => ({
      user_id: userId, id: d.id, name: d.name, balance: d.balance,
      apr: d.apr ?? null, min_payment: d.min ?? 0, due_day: d.dueDay ?? null,
      credit_limit: d.limit ?? null, note: d.note ?? null, position: d.position ?? 0,
      // `payeePattern`/`balanceAsOf` (lib/debt-payments.js's automatic
      // payment matching for manual debts — supabase/debt-payments-auto.sql)
      // follow the same "only include the key when already present" degrade
      // convention as transactions.accountId/recurring.accountId below:
      // omitting the key entirely (rather than sending null/'') keeps every
      // OTHER field on this row saving normally even before that migration
      // has run, as long as the owner never actually types into the new
      // "Payee match"/"Balance as of" fields (views/Debts.jsx's DebtDialog)
      // on THIS debt. The moment they do, `f.payeePattern`/`f.balanceAsOf`
      // become real strings and this key is sent — which needs the
      // migration, same tradeoff already accepted for every other
      // optional-column field in this app.
      ...(d.payeePattern !== undefined ? { payee_pattern: d.payeePattern } : {}),
      ...(d.balanceAsOf !== undefined ? { balance_as_of: d.balanceAsOf } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, name: r.name, balance: Number(r.balance), apr: r.apr ?? '—',
      min: Number(r.min_payment), dueDay: r.due_day, limit: r.credit_limit == null ? null : Number(r.credit_limit),
      note: r.note ?? '', position: r.position ?? 0, payments: [],
      // Set only when the debts-plaid.sql migration has run and this row was
      // auto-created/linked from a Plaid credit account (lib/plaid-debts.js)
      // — read-only here, never written back by toRow, so a client-side edit
      // (payment, note, etc.) can never accidentally clear the link. Drives
      // the "Synced from Plaid" badge in views/Debts.jsx.
      ...(r.plaid_account_id !== undefined ? { plaidAccountId: r.plaid_account_id } : {}),
      ...(r.plaid_item_id !== undefined ? { plaidItemId: r.plaid_item_id } : {}),
      // Editable client-side (DebtDialog, Plaid-linked debts hidden) — see
      // the toRow comment above and lib/debt-payments.js, which reads these
      // two columns server-side to decide what/when to auto-match.
      ...(r.payee_pattern !== undefined ? { payeePattern: r.payee_pattern } : {}),
      ...(r.balance_as_of !== undefined ? { balanceAsOf: r.balance_as_of } : {}),
    }),
  },
  payments: {
    toRow: (p, userId, debtId) => ({
      user_id: userId, id: p.id, debt_id: debtId, date: p.date,
      amount: p.amount, note: p.note ?? null,
      // The transactions.id this payment was auto-logged from (see
      // lib/debt-payments.js) — undefined/omitted for every manually-entered
      // payment (Debts.jsx's "Log payment"), so this round-trips fine before
      // supabase/debt-payments-auto.sql has run.
      ...(p.txId !== undefined ? { tx_id: p.txId } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, date: r.date, amount: Number(r.amount), note: r.note ?? '',
      // Present (and non-null) only for a payment lib/debt-payments.js
      // logged automatically — drives the "auto" badge in Debts.jsx's
      // payment history list.
      ...(r.tx_id !== undefined ? { txId: r.tx_id } : {}),
    }),
  },
  budgets: {
    toRow: (b, userId) => ({ user_id: userId, id: b.id, name: b.name, monthly_limit: b.limit ?? 0, position: b.position ?? 0 }),
    fromRow: (r) => ({ id: r.id, name: r.name, limit: Number(r.monthly_limit), position: r.position ?? 0 }),
  },
  recurring: {
    // `account_id`/`accountId` follow the same "only include the key when
    // already present" convention as transactions.toRow/fromRow below — a
    // recurring bill created from a Suggested Subscriptions detection (see
    // lib/recurring-detect.js, views/Recurring.jsx) carries the Plaid
    // account_id it was charged on; every manually-created bill has no such
    // key at all, so it round-trips unaffected. Needs its own migration —
    // `ALTER TABLE recurring ADD COLUMN IF NOT EXISTS account_id text;` — see
    // CLAUDE.md 2026-08-08 (11); until that runs, upserting a suggestion-
    // created bill (the only path that ever sets accountId) will fail like
    // any other not-yet-migrated column write in this app.
    toRow: (x, userId) => ({
      user_id: userId, id: x.id, description: x.desc, amount: x.amount,
      due_day: x.dueDay ?? null, category: x.cat ?? 'other', active: x.active !== false,
      every_n_months: x.every ?? 1, position: x.position ?? 0,
      ...(x.accountId !== undefined ? { account_id: x.accountId } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, desc: r.description, amount: Number(r.amount), dueDay: r.due_day,
      cat: r.category, active: r.active, position: r.position ?? 0,
      ...(r.every_n_months > 1 ? { every: r.every_n_months } : {}),
      ...(r.account_id !== undefined ? { accountId: r.account_id } : {}),
    }),
  },
  transactions: {
    // `account_id`/`accountId` (and, as of categories-v2.sql, `merchant`/
    // `pfc_primary`/`pfc_detailed`/`cat_source`) are only included when
    // already present — omitting the key entirely (rather than sending
    // null) keeps this working even if the column hasn't been migrated onto
    // public.transactions yet. merchant/pfcPrimary/pfcDetailed are written by
    // lib/plaid-sync.js's sync route and lib/transactions-backfill.js, never
    // by the client — this mapper just round-trips whatever's there.
    // catSource IS written client-side: 'manual' the moment a person picks a
    // category by hand (Transactions.jsx's TxDialog, AccountDetail's inline
    // select) — see lib/transactions-backfill.js for why that flag matters.
    toRow: (t, userId) => ({
      user_id: userId, id: t.id, date: t.date, description: t.desc,
      amount: t.amount, type: t.type, category: t.cat ?? 'other',
      ...(t.accountId !== undefined ? { account_id: t.accountId } : {}),
      ...(t.merchant !== undefined ? { merchant: t.merchant } : {}),
      ...(t.pfcPrimary !== undefined ? { pfc_primary: t.pfcPrimary } : {}),
      ...(t.pfcDetailed !== undefined ? { pfc_detailed: t.pfcDetailed } : {}),
      ...(t.catSource !== undefined ? { cat_source: t.catSource } : {}),
      // Which manual debt this transaction paid (lib/debt-payments.js sets
      // this server-side the moment it auto-matches a payment; Debts.jsx's
      // onDeletePayment sets it back to null client-side if that auto-match
      // is reversed) — same present-only convention as every other optional
      // column here, so this round-trips fine before
      // supabase/debt-payments-auto.sql has run.
      ...(t.debtId !== undefined ? { debt_id: t.debtId } : {}),
    }),
    fromRow: (r) => ({
      id: r.id, date: r.date, desc: r.description, amount: Number(r.amount), type: r.type, cat: r.category,
      ...(r.account_id !== undefined ? { accountId: r.account_id } : {}),
      ...(r.merchant !== undefined ? { merchant: r.merchant } : {}),
      ...(r.pfc_primary !== undefined ? { pfcPrimary: r.pfc_primary } : {}),
      ...(r.pfc_detailed !== undefined ? { pfcDetailed: r.pfc_detailed } : {}),
      ...(r.cat_source !== undefined ? { catSource: r.cat_source } : {}),
      ...(r.debt_id !== undefined ? { debtId: r.debt_id } : {}),
    }),
  },
  goals: {
    toRow: (g, userId) => ({
      user_id: userId, id: g.id, name: g.name, icon: g.icon ?? null, target: g.target ?? 0,
      target_date: g.targetDate ?? null, status: g.status || 'active', txs: g.txs || [], position: g.position ?? 0,
    }),
    fromRow: (r) => ({
      id: r.id, name: r.name, icon: r.icon, target: Number(r.target), targetDate: r.target_date,
      status: r.status, txs: r.txs || [], position: r.position ?? 0,
    }),
  },
  accounts: {
    toRow: (a, userId) => ({
      user_id: userId, id: a.id, name: a.name, type: a.type || 'depository', institution: a.institution ?? null,
      mask: a.mask ?? null, balance: a.balance ?? 0, history: a.history || [], position: a.position ?? 0,
    }),
    fromRow: (r) => ({
      id: r.id, name: r.name, type: r.type, institution: r.institution ?? '', mask: r.mask ?? '',
      balance: Number(r.balance), history: r.history || [], position: r.position ?? 0,
    }),
  },
  // One row per {account, tag} — `accountKey` is the same canonical URL id
  // lib/accounts.js's accountUrlId() produces for every account type (manual
  // acc_<id>, debt debt_<id>, or a Plaid account_id), so tags need no
  // per-account-type branching anywhere. See CLAUDE.md 2026-08-08 (10) for
  // the account_tags table's migration SQL — this table is newer than every
  // other slice, so it's read/written defensively (see store.jsx's
  // initial-load and diff-sync effects) in case the migration hasn't run yet.
  accountTags: {
    toRow: (t, userId) => ({ user_id: userId, id: t.id, account_key: t.accountKey, tag: t.tag }),
    fromRow: (r) => ({ id: r.id, accountKey: r.account_key, tag: r.tag }),
  },
  // One row per account (at most one — unlike accountTags, which is many
  // rows per account) — a card either has a custom color or it doesn't, so
  // "reset to Auto" (see lib/accounts.js's setAccountColor) is just deleting
  // the row rather than needing a separate flag. `accountKey` is the same
  // canonical accountUrlId() every other per-account slice already uses.
  // Same "newer table, defensive everywhere" treatment as account_tags.
  accountColors: {
    toRow: (c, userId) => ({ user_id: userId, id: c.id, account_key: c.accountKey, color: c.color }),
    fromRow: (r) => ({ id: r.id, accountKey: r.account_key, color: r.color }),
  },
}
