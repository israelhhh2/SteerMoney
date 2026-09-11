// Server-only daily per-user AI token cap for the finance chat (Step 2,
// 2026-09). Backed by supabase/ai-usage.sql's `ai_usage` table + the
// `increment_ai_usage` upsert-add RPC — writes always go through
// supabaseAdmin (RLS on ai_usage only grants SELECT to the owning row, same
// "server writes, RLS only guards reads" posture supabase/plaid.sql takes).
//
// Usage is recorded under the AUTHENTICATED caller's user id, never the
// active space's id — app/api/chat/route.js passes `user.id` here even when
// answering about a shared space's data, so a space member can't drain the
// space owner's daily cap by asking questions about the shared space.
//
// Degrades to "not enforced" (one console.warn, not one per request) when
// supabaseAdmin isn't configured — same posture lib/plaid-server.js and
// lib/claude.js take for their own missing-env-var cases: a missing key must
// never brick the feature, just this one guardrail.
import { supabaseAdmin } from './plaid-server.js'

const DEFAULT_CAP = 150000

export function dailyCap() {
  const n = Number(process.env.AI_DAILY_TOKEN_CAP)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CAP
}

function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

let warned = false
function warnOnce() {
  if (warned) return
  warned = true
  console.warn('[chat-usage] No supabaseAdmin configured — the daily AI token cap is not enforced.')
}

export async function getUsageToday(userId) {
  if (!supabaseAdmin) { warnOnce(); return { input_tokens: 0, output_tokens: 0, requests: 0 } }
  const { data, error } = await supabaseAdmin
    .from('ai_usage')
    .select('input_tokens, output_tokens, requests')
    .eq('user_id', userId)
    .eq('day', todayUTC())
    .maybeSingle()
  if (error || !data) return { input_tokens: 0, output_tokens: 0, requests: 0 }
  return data
}

// { ok, used, cap } — `ok` is false once `used` has already reached the cap
// (checked BEFORE the turn runs, so this guards against starting a request
// that's already over budget; it can't account for the tokens THIS turn is
// about to spend, which is recorded after the fact via recordUsage below).
export async function checkCap(userId) {
  const cap = dailyCap()
  if (!supabaseAdmin) { warnOnce(); return { ok: true, used: 0, cap } }
  const usage = await getUsageToday(userId)
  const used = Number(usage.input_tokens || 0) + Number(usage.output_tokens || 0)
  return { ok: used < cap, used, cap }
}

// Best-effort — a failed write here must never fail the chat turn itself
// (the reply already streamed to the user by the time this runs).
export async function recordUsage(userId, usage) {
  if (!supabaseAdmin) { warnOnce(); return }
  const input = Math.max(0, Math.round(usage?.input_tokens || 0))
  const output = Math.max(0, Math.round(usage?.output_tokens || 0))
  if (!input && !output) return
  try {
    const { error } = await supabaseAdmin.rpc('increment_ai_usage', { p_user_id: userId, p_day: todayUTC(), p_input: input, p_output: output })
    if (error) console.error('[chat-usage] increment_ai_usage failed:', error.message)
  } catch (e) {
    console.error('[chat-usage] recordUsage failed:', e?.message)
  }
}
