// Server-only Anthropic wiring for SteerMoney's AI features (statement
// upload extraction + AI categorization of the residual). Never imported
// from a 'use client' file — the API key must never reach the browser
// bundle. Every route that uses this degrades to a clear "Add
// ANTHROPIC_API_KEY in Vercel" message instead of throwing when the key is
// missing, same posture lib/plaid-server.js takes for PLAID_CLIENT_ID/
// SUPABASE_SERVICE_ROLE_KEY: a missing env var must never brick the rest of
// the app, just this one feature.
//
// Owner's own Anthropic Console account/key — nothing here depends on any
// other account. Set ANTHROPIC_API_KEY (required) and, optionally,
// ANTHROPIC_MODEL (defaults to the current Sonnet id below) as Vercel env
// vars.
import Anthropic from '@anthropic-ai/sdk'

// claude-sonnet-5 — current model id as of this writing, $2/$10 per MTok
// (input/output). Override with ANTHROPIC_MODEL if the owner wants a
// different model (e.g. a cheaper one for the categorization pass).
export const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'

export const claudeConfigured = Boolean(process.env.ANTHROPIC_API_KEY)

let _client = null
export function getClaude() {
  if (!process.env.ANTHROPIC_API_KEY) return null
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// Every route surfaces this exact message when the key is missing — one
// string, not re-typed per route, so a copy-edit only ever needs to happen
// here.
export const NOT_CONFIGURED_MESSAGE = 'Add ANTHROPIC_API_KEY in Vercel to use this feature.'

// Strips ```json ... ``` / ``` ... ``` fences a model sometimes wraps its
// JSON in despite being told not to, then trims. Safe no-op on text that's
// already bare JSON.
function stripCodeFences(text) {
  const s = String(text || '').trim()
  const fenced = s.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  return (fenced ? fenced[1] : s).trim()
}

function extractText(msg) {
  return (msg?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
}

// One-line cost/usage log per call — console.info so the owner can watch
// cost in Vercel's function logs without any extra dashboard. Deliberately
// not sent anywhere else (no DB row, no analytics) — this is a "tail the
// logs" tool, not a billing system.
function logUsage(label, usage) {
  console.info(`[claude] ${label} model=${MODEL} input_tokens=${usage?.input_tokens ?? '?'} output_tokens=${usage?.output_tokens ?? '?'}`)
}

// Calls messages.create with a system prompt + message list, expects the
// model's reply to be pure JSON, and JSON.parses it. On a parse failure,
// retries ONCE with an explicit "return ONLY valid JSON" nudge appended to
// the conversation — real models occasionally add a stray sentence before/
// after the JSON despite instructions, and a single retry catches the large
// majority of those without looping forever on a truly broken response.
// `maxTokens` is a hard cap the caller must size sensibly for its own use
// (statement parsing needs more room than a merchant-categorization batch).
export async function askJson({ system, messages, maxTokens = 4096, label = 'askJson' }) {
  const client = getClaude()
  if (!client) throw new Error(NOT_CONFIGURED_MESSAGE)

  const attempt = async (msgs) => {
    const resp = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: msgs,
    })
    logUsage(label, resp.usage)
    const text = extractText(resp)
    return { text, usage: resp.usage, raw: resp }
  }

  const first = await attempt(messages)
  try {
    return { data: JSON.parse(stripCodeFences(first.text)), usage: first.usage }
  } catch {
    // Retry once, nudging it back onto strict JSON — the model's own prior
    // (malformed) reply is included so it can see and correct its mistake.
    const nudged = [
      ...messages,
      { role: 'assistant', content: first.text },
      { role: 'user', content: 'That was not valid JSON. Return ONLY valid JSON matching the schema — no prose, no markdown code fences, no explanation.' },
    ]
    const second = await attempt(nudged)
    const data = JSON.parse(stripCodeFences(second.text)) // let a second failure throw — caller shows the error
    const usage = {
      input_tokens: (first.usage?.input_tokens || 0) + (second.usage?.input_tokens || 0),
      output_tokens: (first.usage?.output_tokens || 0) + (second.usage?.output_tokens || 0),
    }
    return { data, usage }
  }
}
