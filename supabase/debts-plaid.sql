-- Links a debt row to the Plaid credit-card account it was auto-created (or
-- auto-matched) from. Lets app/api/plaid/exchange + lib/plaid-sync.js's
-- syncDebtsFromPlaid() (src/lib/plaid-debts.js) find and UPDATE the same
-- debts row on every subsequent sync (balance/min payment/due day) instead
-- of inserting a duplicate each time, and lets the UI show a "Synced from
-- Plaid" badge (views/Debts.jsx) instead of relying only on fuzzy name
-- matching (lib/finance.js's matchesBankAccount). Run in Supabase SQL Editor
-- after schema.sql and plaid.sql.
--
-- Plain text column, no foreign key to plaid_items: debts.user_id can be
-- either a Clerk user id or a shared workspace id (see collab.sql, "Move my
-- data into this space"), the same dual-purpose id plaid_items.user_id
-- already uses — a bare column avoids re-deriving that ownership join here,
-- same tradeoff this app already made for transactions.account_id and
-- recurring.account_id.

alter table public.debts add column if not exists plaid_account_id text;
alter table public.debts add column if not exists plaid_item_id text;

-- Not unique — debts.id is already the natural per-row key (auto-created
-- rows use a deterministic `pl_<account_id>` id, see lib/plaid-debts.js) —
-- this index just makes "find the debt(s) linked to this Plaid account"
-- lookups and the manual-debt dedupe check fast.
create index if not exists debts_plaid_account_idx on public.debts (user_id, plaid_account_id) where plaid_account_id is not null;
