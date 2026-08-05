import { Configuration, PlaidApi, PlaidEnvironments } from 'plaid'
import { createClient } from '@supabase/supabase-js'

// Server-only Plaid client. Functional once PLAID_CLIENT_ID and PLAID_SECRET
// are set; routes should check plaidConfigured and degrade to a 503 note
// when they're absent instead of throwing.
export const plaidConfigured = Boolean(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET)

const configuration = new Configuration({
  basePath: PlaidEnvironments[process.env.PLAID_ENV || 'sandbox'],
  baseOptions: {
    headers: {
      'PLAID-CLIENT-ID': process.env.PLAID_CLIENT_ID || '',
      'PLAID-SECRET': process.env.PLAID_SECRET || '',
    },
  },
})

export const plaidClient = new PlaidApi(configuration)

// Service-role Supabase client: bypasses RLS entirely, so it must only ever
// be used from server routes, never imported into client components. This
// is the only client allowed to touch public.plaid_items (see
// supabase/plaid.sql, which enables RLS with no policies at all).
export const supabaseAdmin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    })
  : null
