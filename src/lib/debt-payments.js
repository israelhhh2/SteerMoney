import { supabaseAdmin } from '@/lib/plaid-server'
import { cleanMerchant } from '@/lib/merchant'
import crypto from 'crypto'

// ---------------------------------------------------------------------------
// Automatic payment matching for MANUAL (no Plaid link) debts.
//
// THE MODEL, so a future reader doesn't have to reverse-engineer it: a
// manual debt's `balance` is only ever as fresh as the last statement/
// screenshot it was typed in from (see debts.balance_as_of below) — this
// module keeps it moving in the right direction between those manual
// refreshes by watching for the PAYMENT leaving a connected account and
// logging it exactly like Debts.jsx's own manual "Log payment" would
// (push {date, amount, note} onto the debt's payments, subtract from
// balance). What it can NEVER see is a NEW PURCHASE on an unconnected card —
// there's no bank feed for a card Plaid isn't linked to, so a manual card's
// balance only ever goes down here, never back up on its own. Loans/BNPL
// (Toyota lease, Klarna, Affirm, the student loan) don't have this problem
// at all — there's no "new purchase" concept, so their balance stays fully
// accurate here modulo ordinary interest accrual the owner would otherwise
// enter by hand. Practical takeaway for the owner: keep refreshing a manual
// CARD's balance from its real statement periodically; a manual LOAN can be
// left alone once payee_pattern is set.
// ---------------------------------------------------------------------------

const MISSING_COLUMN_MSG =
  'Run supabase/debt-payments-auto.sql in the Supabase SQL editor to enable automatic payment matching for manual debts.'

// True when a Postgres/PostgREST error means "one of this feature's columns
// isn't migrated yet" — same PGRST204 / message-regex approach as
// lib/plaid-debts.js's isMissingColumnError, just naming this feature's own
// columns instead.
function isMissingColumnError(error) {
  if (!error) return false
  if (error.code === 'PGRST204') return true
  return /payee_pattern|balance_as_of|tx_id|debt_id/i.test(error.message || '')
}

const ID_CHUNK = 200
const SCAN_MONTHS = 24

function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

function monthsAgoISO(n) {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d.toISOString().slice(0, 10)
}

// Deterministic id for an auto-logged payment — 'ap_' + a short hash of the
// source transaction id, unlike lib/utils.js's random uid(). Deterministic on
// purpose: re-matching the same transaction (a retried sync, running the
// manual backfill twice) always computes the exact same payments.id, so the
// upsert below naturally no-ops a repeat instead of ever creating a second
// payment for the same money movement — belt-and-suspenders alongside the
// tx_id-already-used candidate filter (see matchPaymentsForUser below).
function autoPaymentId(txId) {
  return 'ap_' + crypto.createHash('sha1').update(String(txId)).digest('hex').slice(0, 12)
}

// A transaction amount counts as "close enough" to a debt's minimum payment
// during disambiguation (see rule (b) below) if it's within 15% of that
// minimum OR within a flat $5 — whichever is more forgiving (a $5 minimum
// payment on a near-zero balance needs the flat-dollar floor; a $400 minimum
// needs the percentage). Equivalent to diff <= max(minPayment*0.15, 5).
function amountNearMin(amount, minPayment) {
  if (!minPayment) return false
  const diff = Math.abs(amount - minPayment)
  return diff <= Math.max(5, minPayment * 0.15)
}

// Runs the matcher for one user (or shared space — `userId` is whichever id
// owns the debts/transactions/payments rows, same dual-purpose id every
// other Plaid-adjacent table in this app already uses).
//
// `transactions` (optional): the batch of transaction ROWS just upserted by
// a Plaid sync pass (see lib/plaid-sync.js's syncPlaidItem) — only their
// `id`s are actually used, to re-query the authoritative, currently-stored
// version of each row (debt_id/cat_source included) rather than trusting the
// caller's own copy. Passing this avoids re-scanning the user's entire
// transaction history on every single sync; omit it (as the manual
// "Clean up transactions" backfill route does) to scan the last 24 months
// instead.
//
// `dryRun`: computes and returns the exact same matched/ambiguous/overpaid
// results without writing anything — used by Settings' cleanup preview.
export async function matchPaymentsForUser({ userId, transactions, dryRun = false }) {
  if (!supabaseAdmin || !userId) return { ok: false, error: 'Not configured' }

  // ---- 1. manual debts only — plaid_account_id is null AND a pattern is set ----
  // A Plaid-linked debt is excluded entirely, not just skipped for lack of a
  // pattern: its balance already comes from Plaid (lib/plaid-debts.js), and
  // classifyTx() (lib/plaid-sync.js) already files its own payments as
  // 'transfer' — this module has nothing to add there and must never touch it.
  let allManualDebts
  {
    const { data, error } = await supabaseAdmin
      .from('debts')
      .select('id, name, balance, min_payment, payee_pattern, balance_as_of, created_at, plaid_account_id')
      .eq('user_id', userId)
      .is('plaid_account_id', null)
    if (error) return { ok: false, error: isMissingColumnError(error) ? MISSING_COLUMN_MSG : error.message }
    allManualDebts = data || []
  }
  const debts = allManualDebts.filter((d) => d.payee_pattern)
  const skippedNoPattern = allManualDebts.length - debts.length
  if (!debts.length) return { ok: true, scanned: 0, matched: [], ambiguous: [], overpaid: [], skippedNoPattern, errors: [] }

  // ---- 2. live Plaid accounts (depository/credit only) — candidate transactions
  // must have left one of these; also doubles as the account_id -> {name,
  // institution} lookup for the "Auto-matched from <source>" payment note. ----
  const { data: items, error: itemsErr } = await supabaseAdmin.from('plaid_items').select('institution, accounts').eq('user_id', userId)
  if (itemsErr) return { ok: false, error: itemsErr.message }
  const liveAccounts = new Map() // account_id -> { name, institution }
  for (const row of items || []) {
    for (const a of (row.accounts || [])) {
      if (!a?.account_id) continue
      if (a.type !== 'depository' && a.type !== 'credit') continue
      liveAccounts.set(a.account_id, { name: a.name || null, institution: row.institution || null })
    }
  }

  // ---- 3. already-used tx_ids — the idempotency backbone ----
  const usedTxIds = new Set()
  {
    const { data, error } = await supabaseAdmin.from('payments').select('tx_id').eq('user_id', userId).not('tx_id', 'is', null)
    if (error) return { ok: false, error: isMissingColumnError(error) ? MISSING_COLUMN_MSG : error.message }
    for (const r of (data || [])) if (r.tx_id) usedTxIds.add(r.tx_id)
  }

  // ---- 4. amounts already auto-matched onto each debt (disambiguation rule (c)) ----
  const priorAmountsByDebt = new Map() // debt.id -> Set of amount.toFixed(2) strings
  {
    const debtIds = debts.map((d) => d.id)
    for (const idsChunk of chunk(debtIds, ID_CHUNK)) {
      const { data, error } = await supabaseAdmin.from('payments').select('debt_id, amount').eq('user_id', userId).not('tx_id', 'is', null).in('debt_id', idsChunk)
      if (error) return { ok: false, error: isMissingColumnError(error) ? MISSING_COLUMN_MSG : error.message }
      for (const r of (data || [])) {
        const set = priorAmountsByDebt.get(r.debt_id) || new Set()
        set.add(Number(r.amount).toFixed(2))
        priorAmountsByDebt.set(r.debt_id, set)
      }
    }
  }

  // ---- 5. candidate transactions ----
  // type 'expense', amount > 0, debt_id is null — pushed into the query
  // itself (not just filtered in JS after) so a missing `debt_id` column
  // surfaces as the same clear isMissingColumnError this whole function
  // reports elsewhere, and so a large account doesn't pull rows it could
  // never match anyway.
  const TX_COLUMNS = 'id, date, description, amount, type, account_id, merchant, cat_source, debt_id'
  const candidateRows = []
  if (transactions && transactions.length) {
    const ids = [...new Set(transactions.map((t) => t.id).filter(Boolean))]
    for (const idsChunk of chunk(ids, ID_CHUNK)) {
      const { data, error } = await supabaseAdmin
        .from('transactions').select(TX_COLUMNS).eq('user_id', userId)
        .eq('type', 'expense').gt('amount', 0).is('debt_id', null).in('id', idsChunk)
      if (error) return { ok: false, error: isMissingColumnError(error) ? MISSING_COLUMN_MSG : error.message }
      candidateRows.push(...(data || []))
    }
  } else {
    const cutoff = monthsAgoISO(SCAN_MONTHS)
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabaseAdmin
        .from('transactions').select(TX_COLUMNS).eq('user_id', userId)
        .eq('type', 'expense').gt('amount', 0).is('debt_id', null).gte('date', cutoff)
        .order('id', { ascending: true }).range(from, from + PAGE - 1)
      if (error) return { ok: false, error: isMissingColumnError(error) ? MISSING_COLUMN_MSG : error.message }
      candidateRows.push(...(data || []))
      if (!data || data.length < PAGE) break
    }
  }

  const candidates = candidateRows.filter((tx) =>
    tx.account_id && liveAccounts.has(tx.account_id) && !usedTxIds.has(tx.id))

  // ---- 6. match + disambiguate ----
  const matched = []
  const ambiguous = []
  const overpaid = []
  const errors = []
  const badPatternDebtIds = new Set() // dedupe: report a broken regex once, not once per transaction it's tested against
  // Running balance per debt, so several matches against the same debt
  // within one pass clamp correctly against each other instead of every
  // match reading the same stale starting balance.
  const runningBalance = new Map(debts.map((d) => [d.id, Number(d.balance) || 0]))

  for (const tx of candidates) {
    const text = String(tx.description || '') + ' ' + cleanMerchant(tx.merchant || tx.description || '')
    // Only debts whose balance_as_of (or created_at, if that's never been
    // set) is on/before this transaction's date are even eligible — a debt
    // whose balance was entered from a statement AFTER this payment already
    // happened must not have it subtracted a second time.
    const eligible = debts.filter((d) => tx.date >= (d.balance_as_of || (d.created_at ? String(d.created_at).slice(0, 10) : '0000-00-00')))

    let hits = []
    for (const d of eligible) {
      let re
      try {
        re = new RegExp(d.payee_pattern, 'i')
      } catch (e) {
        if (!badPatternDebtIds.has(d.id)) {
          badPatternDebtIds.add(d.id)
          errors.push({ debtId: d.id, debtName: d.name, error: `Invalid payee_pattern regex, skipped: ${e.message}` })
        }
        continue
      }
      if (re.test(text)) hits.push(d)
    }
    if (!hits.length) continue

    let chosen = null
    if (hits.length === 1) {
      chosen = hits[0]
    } else {
      // (a) a "NAME: <person>" hint in the description vs "(Julia)"/"(Israel)" in the debt name
      const nameMatch = text.match(/NAME:\s*([A-Za-z]+)/i)
      if (nameMatch) {
        const byName = hits.filter((d) => new RegExp(`\\(\\s*${nameMatch[1]}\\s*\\)`, 'i').test(d.name))
        if (byName.length === 1) chosen = byName[0]
      }
      // (b) closeness of amount to each candidate's min_payment
      if (!chosen) {
        const near = hits.filter((d) => amountNearMin(Number(tx.amount), Number(d.min_payment)))
        if (near.length === 1) {
          chosen = near[0]
        } else if (near.length > 1) {
          const sorted = near.slice().sort((a, b) => Math.abs(tx.amount - a.min_payment) - Math.abs(tx.amount - b.min_payment))
          if (Math.abs(tx.amount - sorted[0].min_payment) < Math.abs(tx.amount - sorted[1].min_payment)) chosen = sorted[0]
          else hits = near // still tied — narrow the field for rule (c) below rather than the full original hit list
        }
      }
      // (c) this exact amount already auto-matched onto one of the candidates before
      if (!chosen) {
        const amtKey = Number(tx.amount).toFixed(2)
        const byPrior = hits.filter((d) => priorAmountsByDebt.get(d.id)?.has(amtKey))
        if (byPrior.length === 1) chosen = byPrior[0]
      }
    }

    if (!chosen) {
      ambiguous.push({ txId: tx.id, date: tx.date, amount: Number(tx.amount), description: tx.description, candidates: hits.map((d) => ({ id: d.id, name: d.name })) })
      continue
    }

    const balanceBefore = runningBalance.get(chosen.id) ?? (Number(chosen.balance) || 0)
    const amount = Number(tx.amount)
    const isOverpaid = amount > balanceBefore
    const balanceAfter = Math.max(0, +(balanceBefore - amount).toFixed(2))
    runningBalance.set(chosen.id, balanceAfter)

    matched.push({ txId: tx.id, debtId: chosen.id, debtName: chosen.name, amount, date: tx.date })
    if (isOverpaid) overpaid.push({ txId: tx.id, debtId: chosen.id, debtName: chosen.name, amount, balanceBefore })
    // Feed rule (c) for a LATER transaction in this same pass too, even
    // before this one is actually written below (also correct in dryRun,
    // where nothing gets written at all).
    const seen = priorAmountsByDebt.get(chosen.id) || new Set()
    seen.add(amount.toFixed(2))
    priorAmountsByDebt.set(chosen.id, seen)

    if (dryRun) continue

    const acct = liveAccounts.get(tx.account_id)
    const source = [acct?.institution, acct?.name].filter(Boolean).join(' ') || 'connected account'
    const paymentId = autoPaymentId(tx.id)
    const { error: payErr } = await supabaseAdmin.from('payments').upsert({
      user_id: userId, id: paymentId, debt_id: chosen.id, date: tx.date, amount,
      note: `Auto-matched from ${source}`, tx_id: tx.id,
    }, { onConflict: 'user_id,id' })
    if (payErr) {
      if (isMissingColumnError(payErr)) return { ok: false, error: MISSING_COLUMN_MSG }
      errors.push({ txId: tx.id, debtId: chosen.id, error: payErr.message })
      continue
    }

    const { error: debtErr } = await supabaseAdmin.from('debts').update({ balance: balanceAfter }).eq('user_id', userId).eq('id', chosen.id)
    if (debtErr) errors.push({ txId: tx.id, debtId: chosen.id, error: `payment logged but balance update failed: ${debtErr.message}` })

    // debt_id always gets set; category/cat_source only when the owner
    // hasn't already hand-picked a category for this row — same
    // never-clobber-a-manual-pick posture as lib/plaid-sync.js's own
    // cat_source protection.
    const txPatch = { debt_id: chosen.id }
    if (tx.cat_source !== 'manual') { txPatch.category = 'debt'; txPatch.cat_source = 'rule' }
    const { error: txErr } = await supabaseAdmin.from('transactions').update(txPatch).eq('user_id', userId).eq('id', tx.id)
    if (txErr) errors.push({ txId: tx.id, debtId: chosen.id, error: `payment logged but linking the transaction failed: ${txErr.message}` })
  }

  return { ok: true, scanned: candidates.length, matched, ambiguous, overpaid, skippedNoPattern, errors }
}
