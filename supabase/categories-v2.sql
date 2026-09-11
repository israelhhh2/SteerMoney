-- Phase 2A categorization foundation (2026-09).
--
-- PRODUCTION CONTEXT: 491 of 883 transactions (56%) sat in category 'other' —
-- not because Plaid lacked data (personal_finance_category is on nearly
-- every transaction) but because this app's old 6-category default set and
-- lib/plaid-categories.js's old conservative mapping had nowhere else to put
-- most of what Plaid actually returns. This migration adds the columns the
-- new, fuller taxonomy needs, plus a one-time upgrade of THIS user's own
-- categories so they don't have to wait on the app's own lazy "ensure
-- default categories" step (store.jsx, gated by categories_v below) to pick
-- them up on next load.
--
-- Run in the Supabase SQL Editor. Safe to re-run (every statement is
-- if-not-exists / on-conflict-do-nothing).

-- ---- 1. settings.categories_v --------------------------------------------
-- Tracks which version of lib/categories.js's CATEGORY_DEFS an account has
-- already been backfilled with (see store.jsx's "ensure default categories"
-- step) — so a default category the user deliberately deletes later doesn't
-- silently reappear on a future load. 0/null = never backfilled (every
-- account that predates this column).
alter table public.settings add column if not exists categories_v int;

-- ---- 2. transactions: store what Plaid actually told us ------------------
-- Previously dropped entirely at sync time, which meant existing history
-- could never be re-categorized as the taxonomy improved without re-pulling
-- from Plaid (see POST /api/transactions/backfill-categories, which exists
-- specifically because this data wasn't being kept). `merchant` is Plaid's
-- own clean merchant_name, or this app's own best-effort cleanup
-- (lib/merchant.js's cleanMerchant()) when Plaid didn't supply one.
-- `cat_source` records how a row's current category was set — 'plaid'
-- (lib/plaid-sync.js's classifyTx()/mapPlaidCategory()), 'rule' (the
-- keyword fallback, CATEGORY_RULES), 'manual' (a person picked it in the
-- UI), 'import' (a Wescom CSV import), or null (never touched by any of the
-- above — legacy rows from before this column existed). Every category-
-- backfill pass (lib/transactions-backfill.js) checks this before ever
-- touching a row's category, specifically so it can never clobber a
-- person's own manual recategorization.
alter table public.transactions
  add column if not exists merchant text,
  add column if not exists pfc_primary text,
  add column if not exists pfc_detailed text,
  add column if not exists cat_source text;

-- ---- 3. Upgrade this user's own categories right now ---------------------
-- The owner's account currently has only housing/groceries/auto/utilities
-- plus one custom category — this adds every id from lib/categories.js's
-- CATEGORY_DEFS that isn't already there, at limit 0 (same "no limit until
-- you set one" convention every default category already uses) and a
-- position after whatever's already there. on conflict do nothing means
-- re-running this is always safe, and never overwrites a category (name,
-- limit, position) the owner has since edited.
insert into public.budgets (user_id, id, name, monthly_limit, position) values
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'housing',       'Housing / Rent',        0, 10),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'utilities',     'Utilities & Phone',      0, 20),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'groceries',     'Groceries',              0, 30),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'dining',        'Dining Out',             0, 40),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'auto',          'Car & Gas',              0, 50),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'transport',     'Transport & Rideshare',  0, 60),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'shopping',      'Shopping',               0, 70),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'entertainment', 'Entertainment',          0, 80),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'subscriptions', 'Subscriptions',          0, 90),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'health',        'Health & Medical',       0, 100),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'personal',      'Personal Care',          0, 110),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'household',     'Household',              0, 120),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'kids',          'Kids',                   0, 130),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'family',        'Family & Gifts',         0, 140),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'travel',        'Travel',                 0, 150),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'education',     'Education',              0, 160),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'fees',          'Fees & Interest',        0, 170),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'cash',          'Cash & ATM',             0, 180),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'business',      'Business',               0, 190),
  ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 'other',         'Other',                  0, 200)
on conflict (user_id, id) do nothing;

-- Mark this user as already backfilled so store.jsx's "ensure default
-- categories" step doesn't redo this (harmlessly, but pointlessly) on their
-- next load — the number here must match lib/categories.js's CATEGORIES_V.
insert into public.settings (user_id, categories_v)
values ('3912066f-87e5-47d1-8e21-17ee8b01aea9', 2)
on conflict (user_id) do update set categories_v = excluded.categories_v;
