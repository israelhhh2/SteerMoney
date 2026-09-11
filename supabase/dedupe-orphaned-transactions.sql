-- One-time cleanup: dedupe transactions doubled by a disconnect + reconnect
-- of the same bank (confirmed live for this user's three Capital One
-- accounts — 56 exact duplicates, same counts/date ranges, filed under
-- account_ids that no longer exist in any plaid_items row).
--
-- WHY THIS HAPPENED: disconnecting a bank keeps its already-imported
-- transactions on purpose (see app/api/account/erase's "Transactions
-- already imported stay in your account" comment) — but reconnecting the
-- SAME bank makes Plaid issue brand-new account_ids AND transaction_ids for
-- the new item, with nothing linking them back to the old ones. Every
-- historical transaction then gets re-imported under the new ids, on top of
-- the old rows that were never deleted — inflating every total this app
-- computes from `transactions`.
--
-- This is the exact matching rule POST /api/transactions/dedupe (and
-- lib/transactions-dedupe.js) apply through the app for any user; this file
-- exists only so THIS user's already-duplicated backlog can be cleaned up
-- directly, without waiting on their next sync/reconnect to trigger it.
-- lib/plaid-sync.js was also changed (see its classifyTx()/re-point-guard
-- comments) so this can't recur going forward.
--
-- Column names below are exactly public.transactions'/public.plaid_items'
-- from supabase/schema.sql + supabase/plaid.sql: transactions(user_id, id,
-- date, description, amount, type, category, account_id),
-- plaid_items(user_id, accounts jsonb — each element an object with its own
-- account_id key, see lib/plaid-server.js/app/api/plaid/exchange).
--
-- Run in the Supabase SQL Editor. Run the SELECT preview first (uncomment
-- it) and sanity-check the counts before running the DELETE below it.

-- ---- 1. Preview only — uncomment and run first, nothing is deleted ------
-- with live_accounts as (
--   select distinct (acct ->> 'account_id') as account_id
--   from public.plaid_items, jsonb_array_elements(accounts) as acct
--   where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9'
--     and acct ->> 'account_id' is not null
-- ),
-- orphaned as (
--   select *
--   from public.transactions t
--   where t.user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9'
--     and t.account_id is not null
--     and t.account_id not in (select account_id from live_accounts)
-- ),
-- live_keys as (
--   select distinct t.date, t.amount, lower(trim(t.description)) as desc_key
--   from public.transactions t
--   where t.user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9'
--     and t.account_id in (select account_id from live_accounts)
-- )
-- select o.account_id, count(*) as duplicates_to_remove
-- from orphaned o
-- join live_keys k
--   on k.date = o.date
--  and k.amount = o.amount
--  and k.desc_key = lower(trim(o.description))
-- group by o.account_id
-- order by duplicates_to_remove desc;

-- ---- 2. Delete the duplicates --------------------------------------------
-- Deletes ONLY an orphaned row (account_id not in any current plaid_items
-- row for this user) that has an exact (date, amount, trimmed/lower
-- description) twin under a LIVE account — keeping the live twin. An
-- orphaned transaction with no live twin is left completely untouched:
-- that's real history from a bank that's simply not connected anymore, not
-- a duplicate, matching this app's own "disconnect keeps your data" rule.
with live_accounts as (
  select distinct (acct ->> 'account_id') as account_id
  from public.plaid_items, jsonb_array_elements(accounts) as acct
  where user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9'
    and acct ->> 'account_id' is not null
),
orphaned as (
  select *
  from public.transactions t
  where t.user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9'
    and t.account_id is not null
    and t.account_id not in (select account_id from live_accounts)
),
live_keys as (
  select distinct t.date, t.amount, lower(trim(t.description)) as desc_key
  from public.transactions t
  where t.user_id = '3912066f-87e5-47d1-8e21-17ee8b01aea9'
    and t.account_id in (select account_id from live_accounts)
)
delete from public.transactions t
using orphaned o
join live_keys k
  on k.date = o.date
 and k.amount = o.amount
 and k.desc_key = lower(trim(o.description))
where t.id = o.id
  and t.user_id = o.user_id;
