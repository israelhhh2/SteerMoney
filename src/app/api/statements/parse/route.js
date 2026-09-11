import { createSupabaseServerClient } from '@/lib/supabase-clients'
import { askJson, claudeConfigured, NOT_CONFIGURED_MESSAGE } from '@/lib/claude'

// POST /api/statements/parse — the "read a statement" half of the statement-
// upload feature (see components/statement-upload.jsx for the preview/
// confirm UI). Accepts a PDF or CSV/text statement, hands it to Claude with
// a strict extraction schema, validates what comes back, and returns it for
// the CLIENT to review and confirm — this route NEVER writes to the
// database itself (no supabaseAdmin import at all), same reasoning
// lib/transactions-backfill.js's dry-run mode exists for: the owner should
// see exactly what would be imported before anything lands in
// public.transactions/public.debts.
//
// Server-only — a route handler is never bundled into client JS regardless,
// but this file also never imports anything client-unsafe the other
// direction (no 'use client' component imports this).
const MAX_BYTES = 10 * 1024 * 1024 // ~10MB cap, per the feature brief
const MAX_OUTPUT_TOKENS = 8192 // a dense multi-page statement can run 100-200+ transaction rows

const SYSTEM_PROMPT = `You are extracting structured data from a credit card, loan, or bank account statement (a PDF scan/export, or a CSV/plain-text export). Return ONLY valid JSON — no prose, no markdown code fences, no explanation — matching EXACTLY this schema:

{
  "institution": string|null,
  "account_name": string|null,
  "account_last4": string|null,
  "statement_period": { "start": "YYYY-MM-DD"|null, "end": "YYYY-MM-DD"|null },
  "closing_date": "YYYY-MM-DD"|null,
  "due_date": "YYYY-MM-DD"|null,
  "new_balance": number|null,
  "minimum_payment": number|null,
  "credit_limit": number|null,
  "apr_purchase": number|null,
  "totals": { "payments": number|null, "purchases": number|null, "fees": number|null, "interest": number|null, "credits": number|null },
  "transactions": [
    { "date": "YYYY-MM-DD", "description": string, "amount": number, "type": "expense"|"payment"|"refund"|"fee"|"interest"|"income"|"transfer" }
  ]
}

Rules:
- Include EVERY transaction row that appears on the statement, including interest charges and fee lines — never skip, merge, or summarize rows.
- Every date is ISO format (YYYY-MM-DD), inferring the year from the statement period when a row only shows month/day.
- "amount" is ALWAYS a positive number — direction/sign is carried entirely by "type" (a payment or refund is still a positive amount), never a negative number.
- Use null for any field that isn't actually present on the statement — never invent or estimate a value.
- "apr_purchase" is the purchase APR as a plain number (e.g. 24.99 for 24.99%), not a string and not a fraction.
- "totals" are the statement's OWN printed subtotals for this billing period, when shown — used only to sanity-check the transaction rows you extracted, so report exactly what the statement prints, not a total you compute yourself.
- Never invent transaction rows that aren't actually on the statement, and never fabricate account facts (balance, APR, limit, dates) that aren't printed.`

function numOrNull(v) {
  const n = Number(v)
  return v == null || !Number.isFinite(n) ? null : n
}

export async function POST(req) {
  try {
    const supabase = await createSupabaseServerClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 })

    if (!claudeConfigured) return Response.json({ error: NOT_CONFIGURED_MESSAGE }, { status: 503 })

    let form
    try {
      form = await req.formData()
    } catch {
      return Response.json({ error: 'Expected multipart/form-data with a file field' }, { status: 400 })
    }
    const file = form.get('file')
    const hint = String(form.get('hint') || '').slice(0, 200)
    if (!file || typeof file.arrayBuffer !== 'function') {
      return Response.json({ error: 'No file provided' }, { status: 400 })
    }
    if (file.size > MAX_BYTES) {
      return Response.json({ error: 'That file is too large — statements must be under 10 MB' }, { status: 400 })
    }

    const name = String(file.name || '').toLowerCase()
    const isPdf = file.type === 'application/pdf' || name.endsWith('.pdf')
    const isText = !isPdf && (String(file.type || '').startsWith('text/') || name.endsWith('.csv') || name.endsWith('.txt') || !file.type)
    if (!isPdf && !isText) {
      return Response.json({ error: 'Upload a PDF, CSV, or plain-text statement' }, { status: 400 })
    }

    const buf = Buffer.from(await file.arrayBuffer())
    // PDF -> a document content block (Anthropic's SDK reads it natively —
    // no separate OCR/text-extraction step needed). CSV/plain text -> sent
    // inline as a text block, capped well under any model's context window
    // (a huge export would blow that budget long before it'd blow MAX_BYTES).
    const contentBlock = isPdf
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') } }
      : { type: 'text', text: buf.toString('utf-8').slice(0, 400000) }

    const userText = hint
      ? `This statement is expected to belong to the account/debt named "${hint}" in the user's tracker — use that only as context for which statement this is; report exactly what the statement itself says, never what you'd expect it to say.`
      : 'Extract this statement into the JSON schema described in the system prompt.'

    const { data: parsedRaw, usage } = await askJson({
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [contentBlock, { type: 'text', text: userText }] }],
      maxTokens: MAX_OUTPUT_TOKENS,
      label: 'statements/parse',
    })

    // ---- schema validation: reject any row missing a valid date/amount ----
    const rawRows = Array.isArray(parsedRaw?.transactions) ? parsedRaw.transactions : []
    const VALID_TYPES = new Set(['expense', 'payment', 'refund', 'fee', 'interest', 'income', 'transfer'])
    const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
    const transactions = rawRows
      .filter((r) => r && typeof r.date === 'string' && ISO_DATE.test(r.date) && typeof r.amount === 'number' && Number.isFinite(r.amount))
      .map((r) => ({
        date: r.date,
        description: String(r.description || '').slice(0, 500) || '(no description)',
        amount: Math.abs(r.amount),
        type: VALID_TYPES.has(r.type) ? r.type : 'expense',
      }))
    const droppedRows = rawRows.length - transactions.length

    const period = parsedRaw?.statement_period || {}
    const parsed = {
      institution: parsedRaw?.institution || null,
      account_name: parsedRaw?.account_name || null,
      account_last4: parsedRaw?.account_last4 || null,
      statement_period: {
        start: ISO_DATE.test(period.start) ? period.start : null,
        end: ISO_DATE.test(period.end) ? period.end : null,
      },
      closing_date: ISO_DATE.test(parsedRaw?.closing_date) ? parsedRaw.closing_date : null,
      due_date: ISO_DATE.test(parsedRaw?.due_date) ? parsedRaw.due_date : null,
      new_balance: numOrNull(parsedRaw?.new_balance),
      minimum_payment: numOrNull(parsedRaw?.minimum_payment),
      credit_limit: numOrNull(parsedRaw?.credit_limit),
      apr_purchase: numOrNull(parsedRaw?.apr_purchase),
      totals: {
        payments: numOrNull(parsedRaw?.totals?.payments),
        purchases: numOrNull(parsedRaw?.totals?.purchases),
        fees: numOrNull(parsedRaw?.totals?.fees),
        interest: numOrNull(parsedRaw?.totals?.interest),
        credits: numOrNull(parsedRaw?.totals?.credits),
      },
      transactions,
    }

    // ---- recompute sums by type, compare against the statement's own stated totals ----
    const sums = { payments: 0, purchases: 0, fees: 0, interest: 0, credits: 0 }
    for (const tx of transactions) {
      if (tx.type === 'payment') sums.payments += tx.amount
      else if (tx.type === 'expense' || tx.type === 'transfer') sums.purchases += tx.amount
      else if (tx.type === 'fee') sums.fees += tx.amount
      else if (tx.type === 'interest') sums.interest += tx.amount
      else if (tx.type === 'refund' || tx.type === 'income') sums.credits += tx.amount
    }

    // Tolerance: $1.00 or 0.5% of the stated total, whichever is larger —
    // generous enough to absorb a rounding difference or a rewards/fee line
    // Claude filed under a slightly different bucket than the statement's
    // own subtotal groups, tight enough to still catch a genuinely missed or
    // duplicated row.
    const mismatches = []
    const tolerance = (stated) => Math.max(1.0, Math.abs(stated) * 0.005)
    for (const field of ['payments', 'purchases', 'fees', 'interest', 'credits']) {
      const stated = parsed.totals[field]
      if (stated == null) continue // statement didn't print this subtotal — nothing to check
      const computed = Math.round(sums[field] * 100) / 100
      if (Math.abs(computed - stated) > tolerance(stated)) {
        mismatches.push({ field, computed, stated, diff: Math.round((computed - stated) * 100) / 100 })
      }
    }

    // Every transaction date should fall inside statement_period ± 5 days
    // when a period was actually extracted — catches the model reading a
    // stray date from an unrelated part of the document.
    if (parsed.statement_period.start && parsed.statement_period.end) {
      const startMs = Date.parse(parsed.statement_period.start) - 5 * 86400000
      const endMs = Date.parse(parsed.statement_period.end) + 5 * 86400000
      if (!isNaN(startMs) && !isNaN(endMs)) {
        for (const tx of transactions) {
          const ms = Date.parse(tx.date)
          if (!isNaN(ms) && (ms < startMs || ms > endMs)) {
            mismatches.push({ field: 'date_range', description: tx.description, date: tx.date })
          }
        }
      }
    }

    if (droppedRows > 0) {
      mismatches.push({ field: 'dropped_rows', count: droppedRows, note: 'Row(s) missing a valid date/amount were excluded' })
    }

    const validation = { reconciles: mismatches.length === 0, mismatches, rowCount: transactions.length }

    return Response.json({ ok: true, parsed, validation, usage })
  } catch (e) {
    return Response.json({ error: e?.message || "Couldn't read that statement" }, { status: 500 })
  }
}
