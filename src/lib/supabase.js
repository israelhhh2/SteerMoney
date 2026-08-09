'use client'
import { createSupabaseBrowserClient } from '@/lib/supabase-clients'

// SUPABASE AUTH MIGRATION (see supabase-clients.js + components/auth-provider.jsx):
// the app no longer bridges a third-party JWT into Supabase — the browser
// client's own cookie-backed session IS the auth, since users sign in
// directly against Supabase Auth now. Prefer this (or useSupabaseClient()
// from components/auth-provider.jsx) everywhere a client-side authed
// Supabase client is needed.
export function createAuthedSupabaseClient() {
  return createSupabaseBrowserClient()
}
