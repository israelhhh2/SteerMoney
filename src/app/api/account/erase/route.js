import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { plaidConfigured, supabaseAdmin, revokePlaidItem } from '@/lib/plaid-server'

// Danger zone "Erase all data" (views/Settings.jsx) — the AUTHORITATIVE wipe.
//
// Why this exists: the original implementation (store.jsx's resetAllData())
// only ever emptied local state and let the debounced diff-sync effect turn
// that into `DELETE ... WHERE id IN (...)` calls, one per table. Two things
// made that silently strand rows in Supabase forever:
//   1. A user with hundreds/thousands of transactions blows the `.in(...)`
//      call up into a querystring PostgREST rejects — that single table's
//      delete fails.
//   2. That effect `throw`s on the first non-optional table's error, which
//      aborts every table queued after it in the same pass — and 'debts'
//      sits near the END of that loop, so a transactions-table failure means
//      debts (i.e. the credit cards the owner saw come back after "erasing
//      everything") never get deleted at all. `synced.current` also never
//      advances on a thrown pass, so the empty local state and the
//      still-full database diverge forever — a reload always shows the DB's
//      version, which is exactly the reported bug.
// This route sidesteps both: no id lists (a plain `.eq('user_id', ...)`
// deletes every row in one request, however many there are), and a
// try/catch PER TABLE so one table's failure can never block another's.
//
// Scope: erases the space the caller is actually looking at, not blindly
// every space they belong to (mirrors store.jsx's deleteSpace() and the
// items route's workspace_id branch, both owner-only). No `space_id` in the
// body -> wipes the caller's own personal rows (`user_id = caller`) only.
// A `space_id` -> wipes that shared space's rows, but ONLY if the caller is
// its owner (checked against public.workspaces, same restriction
// deleteSpace() and app/api/plaid/items' DELETE workspace_id branch already
// enforce) — a member who isn't the owner gets 403, never a wipe of an id
// they don't own.
//
// Table list/order mirrors store.jsx's DELETE_SPACE_TABLES (deleteSpace())
// plus `settings` (sim/mSim — deleteSpace deletes that too, just as its own
// best-effort step) and this app's full stateRows()/mappers table set.
// Children before parents so the payments -> debts FK (schema.sql) is never
// in the way: payments/transactions/etc. first, debts near the end, settings
// last (single row keyed by user_id alone, no FK relationship to anything).
// account_tags/account_colors are OPTIONAL_TABLES (see store.jsx) — may not
// be migrated on an older project, so their failure is collected as a
// warning, never allowed to abort the pass or flip `ok` to false.
const OPTIONAL_TABLES = new Set(['account_tags', 'account_colors'])
const ERASE_TABLES = ['payments', 'transactions', 'budgets', 'recurring', 'goals', 'accounts', 'account_tags', 'account_colors', 'debts', 'settings']

export async function POST(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })
    const userId = user.id

    const body = await req.json().catch(() => ({}))
    const spaceId = body?.space_id || null

    let targetId = userId
    if (spaceId) {
      // Ownership check via the RLS-scoped client (not supabaseAdmin) —
      // workspaces' "member read" policy (collab.sql) already means a
      // non-member gets back no row at all here, and the owner_id equality
      // check below is the same owner-only restriction deleteSpace() and
      // the plaid items route's workspace_id branch enforce. Deliberately
      // NOT "any member" even though is_member() would let a member's own
      // client delete these rows directly — erasing an entire shared
      // space's data is exactly as destructive as deleting the space, so it
      // gets the same "owner only" bar.
      const { data: ws, error: wsErr } = await supabase.from('workspaces').select('owner_id').eq('id', spaceId).maybeSingle()
      if (wsErr) return Response.json({ error: wsErr.message }, { status: 500 })
      if (!ws || ws.owner_id !== userId) return Response.json({ error: 'Only the space owner can erase this space' }, { status: 403 })
      targetId = spaceId
    }

    const deleted = []
    const failed = []   // non-optional tables — any entry here flips `ok` to false
    const warnings = [] // optional tables / non-fatal plaid cleanup notes

    // 1. Every data table this app syncs, scoped to targetId alone — never
    //    touches workspaces/workspace_members (that's deleteSpace()'s job,
    //    a different and much more destructive action) and never touches
    //    the auth user itself.
    for (const table of ERASE_TABLES) {
      try {
        // `count: 'exact'` matters here, it isn't decoration: a DELETE that RLS
        // silently filters to zero rows comes back with NO error, which is
        // exactly how the old client-side wipe convinced the UI everything was
        // gone while every row was still in the table. Reporting the row count
        // back to the caller makes a no-op wipe visible instead of silent.
        const { error, count } = await supabase.from(table).delete({ count: 'exact' }).eq('user_id', targetId)
        if (error) throw error
        deleted.push({ table, rows: count ?? null })
      } catch (e) {
        const message = e?.message || String(e)
        if (OPTIONAL_TABLES.has(table)) { warnings.push(`${table}: ${message}`); continue }
        failed.push({ table, error: message })
      }
    }

    // 2. Bank connections backstop. The client (Settings.jsx's eraseAll)
    //    already disconnects every bank one-by-one BEFORE calling this route
    //    — that path is what actually revokes access with Plaid, and this
    //    route deliberately doesn't bypass it (revoking is a real, billable
    //    side effect with Plaid, not just row bookkeeping). This is only a
    //    safety net for whatever the client's loop missed (a request that
    //    failed partway, a tab closed mid-loop, a connection that got moved
    //    into this space after the client's list was fetched, etc.) — same
    //    "revoke first, then delete the row" order as the items route's own
    //    DELETE handler, reusing its exact revoke helper so a leftover item
    //    is never left revoked-but-present (row lingers, cosmetic only) or
    //    present-but-unrevoked (row gone, Plaid still thinks it's live —
    //    the bad outcome) without at least being logged.
    if (plaidConfigured && supabaseAdmin) {
      try {
        const { data: rows, error: findErr } = await supabaseAdmin
          .from('plaid_items').select('id, access_token').eq('user_id', targetId)
        if (findErr) throw findErr
        if (rows && rows.length) {
          for (const row of rows) {
            await revokePlaidItem(row.access_token) // best-effort — see lib/plaid-server.js
          }
          const { error: delErr } = await supabaseAdmin.from('plaid_items').delete().eq('user_id', targetId)
          if (delErr) throw delErr
          deleted.push({ table: 'plaid_items', rows: rows.length })
        }
      } catch (e) {
        const message = e?.message || String(e)
        console.error('[account/erase] leftover plaid_items cleanup failed — items may be revoked but still present in the DB, or vice versa:', message)
        failed.push({ table: 'plaid_items', error: message })
      }
    }

    return Response.json({ ok: failed.length === 0, deleted, failed, warnings })
  } catch (e) {
    return Response.json({ ok: false, error: e?.message || 'Failed to erase your data' }, { status: 500 })
  }
}
