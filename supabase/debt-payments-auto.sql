-- Automatic payment matching for MANUAL (no Plaid link) debts (2026-09).
--
-- The owner has 18 debts with no bank connection behind them (Toyota lease,
-- Klarna, Affirm, two Apple Cards, the Edfinancial student loan, several
-- store cards, etc. — plaid_account_id is null, ids start with 'h_'). Their
-- balances only ever change when he edits them by hand, even though every
-- payment toward them already shows up as a transaction on whichever
-- CONNECTED account it left from (a Wescom checking withdrawal named
-- "Toyota", "Klarna*Klarna Columbus OH", "Withdrawal ACH APPLECARD GSBANK
-- ...", etc.). See lib/debt-payments.js for the matcher this migration
-- enables — it reads payee_pattern/balance_as_of below to log a payment on
-- the right manual debt automatically, the same way Debts.jsx's manual "Log
-- payment" already does by hand.
--
-- Run in the Supabase SQL Editor. Safe to re-run (every column add is
-- if-not-exists; the owner seed UPDATEs at the bottom are idempotent too —
-- re-running them just writes the same values again).

-- ---- 1. debts: what to match against, and since when ---------------------
-- `payee_pattern` — a case-insensitive regex tested against a transaction's
-- description + cleaned merchant name (lib/merchant.js's cleanMerchant()).
-- Null/absent = never auto-match this debt (also true for every Plaid-linked
-- debt, whose balance already comes from Plaid — see lib/debt-payments.js's
-- load query, which excludes plaid_account_id is not null entirely).
-- `balance_as_of` — the date the current `balance` value was entered from
-- (a statement or screenshot), NOT when the debt row was created. Only a
-- payment dated on/after this date is allowed to reduce the balance —
-- otherwise a payment that already happened before the balance was last
-- typed in would double-subtract itself.
alter table public.debts
  add column if not exists payee_pattern text,
  add column if not exists balance_as_of date;

-- ---- 2. payments: which transaction (if any) auto-logged this payment ----
-- Null for every manually-entered payment (Debts.jsx's "Log payment" never
-- sets this). Set for an auto-matched one, and the ONLY thing that makes the
-- whole feature idempotent: lib/debt-payments.js excludes any candidate
-- transaction already referenced by a tx_id here before it ever runs the
-- payee_pattern matching, so re-running the matcher (every sync, or the
-- manual "Clean up transactions" backfill) can never log the same payment
-- twice. Also what Debts.jsx's "auto" badge/reversal (deleting an
-- auto-matched payment unlinks the source transaction's debt_id, see
-- onDeletePayment) key off.
alter table public.payments add column if not exists tx_id text;
create index if not exists payments_tx_idx on public.payments (user_id, tx_id) where tx_id is not null;

-- ---- 3. transactions: which debt this transaction paid --------------------
-- Set by lib/debt-payments.js the moment a transaction is matched to a
-- manual debt — excludes it from ever being matched again (see the matcher's
-- own "debt_id is null" candidate filter) and is what Debts.jsx clears back
-- to null if the owner deletes the resulting auto-matched payment.
alter table public.transactions add column if not exists debt_id text;

-- ---- 4. owner seed: balance_as_of + payee_pattern for every manual debt ---
-- balance_as_of is set to today (2026-09-11) for every 'h_' debt — that's
-- when these balances were entered from statements/screenshots, so only a
-- payment dated on/after this actually reduces one. payee_pattern is a
-- case-insensitive regex; h_capone_549112 is deliberately left NULL —
-- "Capital One" is too ambiguous against this account's other, Plaid-linked
-- Capital One cards, so that one stays manual-only. h_apple_israel/
-- h_apple_julia and h_thd_1400/h_thd_500 deliberately share a pattern (both
-- Apple Cards, both Home Depot accounts look identical in a bank feed) —
-- lib/debt-payments.js's disambiguation (a NAME: <person> hint in the
-- description vs "(Israel)"/"(Julia)" in the debt name, then amount
-- closeness to min_payment, then a repeat of a prior auto-matched amount)
-- decides between them; if it can't, the transaction is reported in
-- `ambiguous[]` instead of being logged against the wrong card.
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'toyota'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_toyota';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'klarna'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_klarna';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'affirm'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_affirm';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'applecard|apple card|gs ?bank'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_apple_israel';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'applecard|apple card|gs ?bank'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_apple_julia';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'edfinancial|ed ?fin'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_edfin';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'wescom.*(visa|card|credit)|credit card payment|to loan 0?1'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_wescom_card';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'costco.*(citi|visa)|citi.*costco|citi card|citicard'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_citi_8064';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'best ?buy|citi retail|cbna'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_cbna_9377';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'tjx|tj ?maxx'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_tjx';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'ulta'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_ulta';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'sephora'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_sephora';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'kohl'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_kohls';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'curacao'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_curacao';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'jcp|jc ?penney|synchrony.*jcp'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_jcp';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'home ?depot|thd'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_thd_1400';
update public.debts set balance_as_of = '2026-09-11', payee_pattern = 'home ?depot|thd'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_thd_500';
-- Deliberately no payee_pattern — see note above.
update public.debts set balance_as_of = '2026-09-11'
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9' and id = 'h_capone_549112';
