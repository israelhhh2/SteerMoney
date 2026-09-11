'use client'
// Floating "Ask about your money" chat widget (Step 2 — Finance chat with
// Claude, 2026-09) — mirrors components/feedback-widget.jsx's FAB/panel
// pattern (z-[55], mobile scroll-shrink N/A here since this panel is a full
// sheet on mobile, Escape-to-close, useT i18n, useIsMobile), mounted once in
// app/(app)/layout.jsx alongside FeedbackWidget so it's on every authed page.
//
// Talks to POST /api/chat (lib/chat-tools.js/lib/chat-briefing.js/
// lib/chat-usage.js do the actual work server-side) and parses its
// newline-delimited JSON stream incrementally. History is session-only —
// kept in React state, mirrored into sessionStorage under
// `fin-chat-<userId>` purely as a "survive an accidental refresh" nicety,
// never as a durable record.
import { useEffect, useRef, useState } from 'react'
import { Sparkles, X, Send, Square, Loader2, RotateCcw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuthUser } from '@/components/auth-provider'
import { useApp } from '@/store'
import { useT } from '@/lib/i18n'

const SUGGESTIONS = [
  'How much did I spend on dining this month vs last?',
  'What bills are due in the next 2 weeks?',
  'Which debt should I pay off first?',
  'Where did most of my money go in August?',
  'How am I doing against my budgets?',
  'How much did I pay Capital One in the last 3 months?',
]

// Tool name -> a friendly one-line status chip while it's running — see
// lib/chat-tools.js's CHAT_TOOLS for what each one actually does.
const TOOL_LABELS = {
  get_snapshot: 'Checking your overall picture…',
  spending_by_category: 'Looking at your spending by category…',
  search_transactions: 'Looking at your transactions…',
  account_balance_history: 'Checking your account history…',
  list_debts: 'Looking at your debts…',
  debt_payoff_projection: 'Running the payoff numbers…',
  upcoming_bills: 'Checking your upcoming bills…',
  budget_status: 'Checking your budgets…',
}

// ---- markdown-lite: **bold**, line breaks, "- " bullets. No new deps — the
// system prompt keeps replies to 2-6 sentences or a short list, so this
// never needs to handle nested/complex markdown. ----
function renderInline(text, keyPrefix) {
  return String(text).split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/)
    return m ? <strong key={`${keyPrefix}-${i}`}>{m[1]}</strong> : <span key={`${keyPrefix}-${i}`}>{part}</span>
  })
}

function renderLite(text) {
  const lines = String(text || '').split('\n')
  const out = []
  let listBuf = []
  const flushList = (key) => {
    if (!listBuf.length) return
    out.push(<ul key={`ul-${key}`} className="my-1 list-disc space-y-0.5 pl-4">{listBuf}</ul>)
    listBuf = []
  }
  lines.forEach((line, i) => {
    const bullet = line.match(/^-\s+(.*)$/)
    if (bullet) {
      listBuf.push(<li key={`li-${i}`}>{renderInline(bullet[1], `li-${i}`)}</li>)
      return
    }
    flushList(i)
    if (line.trim()) out.push(<p key={`p-${i}`} className="my-1 first:mt-0 last:mb-0">{renderInline(line, `p-${i}`)}</p>)
    else out.push(<div key={`sp-${i}`} className="h-1.5" />)
  })
  flushList('end')
  return out
}

function loadHistory(userId) {
  if (!userId || typeof window === 'undefined') return []
  try {
    const raw = sessionStorage.getItem(`fin-chat-${userId}`)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function saveHistory(userId, messages) {
  if (!userId || typeof window === 'undefined') return
  try { sessionStorage.setItem(`fin-chat-${userId}`, JSON.stringify(messages.slice(-40))) } catch { /* best effort */ }
}

// `mode`: 'floating' (default — FAB + popover panel, mounted in the app
// layout) or 'page' (the /chat nav route — same conversation, same
// sessionStorage history, rendered as a full-height card with no FAB/close).
// The layout hides the floating instance while the /chat route is on screen
// so the two never show the same conversation twice.
export function FinanceChat({ mode = 'floating' }) {
  const isPage = mode === 'page'
  const t = useT()
  const { user } = useAuthUser()
  const app = useApp()
  const space = app?.space

  const [open, setOpen] = useState(isPage)
  const [messages, setMessages] = useState([]) // [{role:'user'|'assistant', content}]
  const [draft, setDraft] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [toolName, setToolName] = useState(null)
  const [error, setError] = useState('')
  const [usage, setUsage] = useState(null) // { configured, used, cap, remaining }
  const [hydrated, setHydrated] = useState(false)

  const abortRef = useRef(null)
  const listRef = useRef(null)
  const textareaRef = useRef(null)

  // Load this user's session history once we know who they are.
  useEffect(() => {
    if (!user?.id || hydrated) return
    setMessages(loadHistory(user.id))
    setHydrated(true)
  }, [user?.id, hydrated])

  useEffect(() => {
    if (hydrated) saveHistory(user?.id, messages)
  }, [messages, user?.id, hydrated])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape' && !streaming) setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, streaming])

  // Auto-scroll to the newest message as the reply streams in.
  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight
  }, [messages, toolName])

  // Auto-grow the textarea up to a sane cap.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [draft])

  const refreshUsage = () => {
    fetch('/api/chat/usage').then((r) => r.json()).then((d) => { if (!d.error) setUsage(d) }).catch(() => {})
  }
  useEffect(() => { if (open) refreshUsage() }, [open])

  async function send(text) {
    const trimmed = text.trim()
    if (!trimmed || streaming) return
    setError('')
    const history = [...messages, { role: 'user', content: trimmed }]
    setMessages([...history, { role: 'assistant', content: '' }])
    setDraft('')
    setStreaming(true)
    setToolName(null)

    const controller = new AbortController()
    abortRef.current = controller
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: history, ...(space?.id ? { space_id: space.id } : {}) }),
        signal: controller.signal,
      })

      if (!res.ok) {
        const data = await res.json().catch(() => ({}))
        setMessages(history) // drop the empty assistant placeholder — nothing streamed
        if (res.status === 503) setError(data.error || t('This needs to be configured by the site owner.'))
        else if (res.status === 429) setError(t("You've reached today's AI limit. It resets at midnight UTC."))
        else setError(data.error || t('Something went wrong. Try again.'))
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop() // keep the partial tail for the next chunk
        for (const line of lines) {
          if (!line.trim()) continue
          let evt
          try { evt = JSON.parse(line) } catch { continue }
          if (evt.type === 'text') {
            setMessages((m) => {
              const copy = m.slice()
              const last = copy[copy.length - 1]
              copy[copy.length - 1] = { ...last, content: (last?.content || '') + evt.text }
              return copy
            })
          } else if (evt.type === 'tool') {
            setToolName(evt.status === 'start' ? evt.name : null)
          } else if (evt.type === 'error') {
            setError(evt.message || t('Something went wrong. Try again.'))
          }
        }
      }
    } catch (e) {
      if (e?.name !== 'AbortError') setError(t('Something went wrong. Try again.'))
    } finally {
      setStreaming(false)
      setToolName(null)
      abortRef.current = null
      refreshUsage()
    }
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send(draft)
    }
  }

  function stop() {
    abortRef.current?.abort()
  }

  function clearChat() {
    if (streaming) return
    setMessages([])
    setError('')
  }

  if (!user) return null

  const toolLabel = toolName ? t(TOOL_LABELS[toolName] || 'Thinking…') : null

  const panelBody = (
    <>
    <div className="flex shrink-0 items-center justify-between border-b border-border/60 px-4 py-3">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-primary" />
        <h3 className="text-[0.9375rem] font-extrabold tracking-tight">{t('Ask about your money')}</h3>
      </div>
      <div className="flex items-center gap-3">
        {messages.length ? (
          <button
            type="button"
            onClick={clearChat}
            disabled={streaming}
            aria-label={t('New chat')}
            title={t('New chat')}
            className="inline-flex items-center gap-1 text-[0.75rem] font-semibold text-muted-foreground hover:text-foreground disabled:opacity-40"
          >
            <RotateCcw className="h-3.5 w-3.5" /> {t('New chat')}
          </button>
        ) : null}
        {!isPage ? (
          <button
            type="button"
            onClick={() => !streaming && setOpen(false)}
            aria-label={t('Close chat')}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>

    <div ref={listRef} className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      {messages.length === 0 ? (
        <div className="flex h-full flex-col justify-center gap-3">
          <p className="text-center text-[0.8125rem] text-muted-foreground">{t('Try asking:')}</p>
          <div className="flex flex-wrap justify-center gap-1.5">
            {SUGGESTIONS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => send(s)}
                className="rounded-full border border-border/60 bg-secondary/50 px-2.5 py-1.5 text-left text-[0.75rem] font-medium text-foreground/90 transition hover:bg-secondary"
              >
                {t(s)}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2.5">
          {messages.map((m, i) => (
            <div key={i} className={cn('flex', m.role === 'user' ? 'justify-end' : 'justify-start')}>
              <div
                className={cn(
                  'max-w-[85%] rounded-2xl px-3 py-2 text-[0.8125rem] leading-snug',
                  m.role === 'user' ? 'bg-primary text-primary-foreground' : 'bg-secondary/70 text-foreground'
                )}
              >
                {m.role === 'assistant' && !m.content && streaming && i === messages.length - 1 && !toolLabel ? (
                  <span className="inline-flex items-center gap-1 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" /> {t('Thinking…')}
                  </span>
                ) : (
                  <>
                    {renderLite(m.content)}
                    {streaming && i === messages.length - 1 && m.role === 'assistant' ? (
                      <span className="ml-0.5 inline-block h-3 w-1.5 animate-pulse bg-current align-middle" />
                    ) : null}
                  </>
                )}
              </div>
            </div>
          ))}
          {toolLabel ? (
            <div className="flex justify-start">
              <div className="inline-flex items-center gap-1.5 rounded-full border border-border/60 bg-secondary/40 px-2.5 py-1 text-[0.6875rem] font-medium text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> {toolLabel}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </div>

    {error ? <p className="shrink-0 px-4 pb-1 text-[0.75rem] font-semibold text-red-400">{error}</p> : null}

    <div className="shrink-0 border-t border-border/60 p-3" style={{ paddingBottom: 'calc(0.75rem + env(safe-area-inset-bottom))' }}>
      <div className="flex items-end gap-2">
        <textarea
          ref={textareaRef}
          rows={1}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={t('Ask about your spending, budgets, debts, or bills…')}
          disabled={streaming}
          className="max-h-40 min-h-[2.25rem] flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 [color-scheme:dark]"
        />
        {streaming ? (
          <button
            type="button"
            onClick={stop}
            aria-label={t('Stop')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-border/60 bg-secondary text-foreground transition hover:opacity-90"
          >
            <Square className="h-3.5 w-3.5 fill-current" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => send(draft)}
            disabled={!draft.trim()}
            aria-label={t('Send')}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition hover:opacity-90 disabled:opacity-40"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      {usage && Number.isFinite(usage.remaining) ? (
        <p className="mt-1.5 text-center text-[0.625rem] text-muted-foreground">
          {t('Answers use only your SteerMoney data · {remaining} tokens left today', { remaining: usage.remaining.toLocaleString() })}
        </p>
      ) : null}
    </div>
    </>
  )

  if (isPage) {
    return (
      <div
        role="region"
        aria-label={t('Ask about your money')}
        className="fade-in flex h-[calc(100dvh-13.5rem)] min-h-[24rem] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card shadow-sm md:h-[calc(100dvh-8.5rem)]"
      >
        {panelBody}
      </div>
    )
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? t('Close chat') : t('Open finance chat')}
        className={cn(
          'no-print fixed right-3 z-[55] flex h-10 w-10 items-center justify-center rounded-full border border-border/60 bg-secondary text-foreground shadow-lg transition hover:opacity-90 sm:right-4 md:h-12 md:w-12',
          'bottom-[calc(8.25rem+env(safe-area-inset-bottom))] md:bottom-20',
          open ? 'hidden md:flex' : 'flex'
        )}
      >
        {open ? <X className="h-4 w-4 md:h-5 md:w-5" /> : <Sparkles className="h-4 w-4 md:h-5 md:w-5" />}
      </button>

      {open ? (
        <>
          <div className="no-print fixed inset-0 z-[54] md:hidden" onClick={() => !streaming && setOpen(false)} />
          <div
            role="dialog"
            aria-label={t('Ask about your money')}
            className={cn(
              'no-print fixed z-[55] flex flex-col border-border/60 bg-card shadow-2xl',
              'inset-0 rounded-none border-0',
              'md:inset-auto md:bottom-24 md:right-4 md:h-[35rem] md:w-[23.75rem] md:rounded-2xl md:border'
            )}
          >
            {panelBody}
          </div>
        </>
      ) : null}
    </>
  )
}
