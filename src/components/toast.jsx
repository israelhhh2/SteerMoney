'use client'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const ToastCtx = createContext(() => {})
const CenterToastCtx = createContext(() => {})

let nextId = 0
let nextCenterId = 0
const CENTER_MS = 1600 // auto-dismiss delay for the centered "in progress result" toast
const CENTER_FADE_MS = 250 // must match the fade-out transition below

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([])
  const timers = useRef({})

  const dismiss = useCallback((id) => {
    clearTimeout(timers.current[id])
    delete timers.current[id]
    setToasts((t) => t.filter((x) => x.id !== id))
  }, [])

  const toast = useCallback((message, variant = 'success') => {
    const id = ++nextId
    setToasts((t) => [...t, { id, message, variant }])
    timers.current[id] = setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id))
      delete timers.current[id]
    }, 3500)
  }, [])

  // Centered overlay toast for "did the destructive/async action succeed?"
  // moments (delete, disconnect, erase-all-data) — distinct from the corner
  // toasts above, which are for routine confirmations. Only one shows at a
  // time; a new call replaces whatever's currently showing.
  const [centerToastState, setCenterToastState] = useState(null)
  const centerTimer = useRef(null)
  const centerFadeTimer = useRef(null)

  const centerToast = useCallback((message, variant = 'success') => {
    clearTimeout(centerTimer.current)
    clearTimeout(centerFadeTimer.current)
    const id = ++nextCenterId
    setCenterToastState({ id, message, variant, leaving: false })
    centerTimer.current = setTimeout(() => {
      setCenterToastState((c) => (c && c.id === id ? { ...c, leaving: true } : c))
      centerFadeTimer.current = setTimeout(() => {
        setCenterToastState((c) => (c && c.id === id ? null : c))
      }, CENTER_FADE_MS)
    }, CENTER_MS)
  }, [])

  return (
    <ToastCtx.Provider value={toast}>
      <CenterToastCtx.Provider value={centerToast}>
        {children}
        <div className="fixed inset-x-0 bottom-5 z-[60] flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:right-5 sm:items-end">
          {toasts.map((t) => {
            const isError = t.variant === 'error'
            const Icon = isError ? XCircle : CheckCircle2
            return (
              <div
                key={t.id}
                onClick={() => dismiss(t.id)}
                className={cn(
                  'fade-in flex w-full max-w-sm cursor-pointer items-center gap-2 rounded-xl border bg-card px-4 py-3 shadow-lg',
                  isError ? 'border-red-400/30' : 'border-emerald-400/30'
                )}
              >
                <Icon className={cn('h-4 w-4 shrink-0', isError ? 'text-red-400' : 'text-emerald-400')} />
                <span className="text-[0.8125rem] font-semibold">{t.message}</span>
              </div>
            )
          })}
        </div>
        {centerToastState && (
          <div className="fixed inset-0 z-[70] flex items-center justify-center px-6" role="status" aria-live="polite">
            <div
              className={cn(
                'flex flex-col items-center gap-2.5 rounded-2xl border bg-card px-7 py-6 text-center shadow-2xl transition-all duration-200',
                centerToastState.variant === 'error' ? 'border-red-400/30' : 'border-emerald-400/30',
                centerToastState.leaving ? 'opacity-0 scale-95' : 'fade-in opacity-100 scale-100'
              )}
            >
              {centerToastState.variant === 'error' ? (
                <XCircle className="h-9 w-9 text-red-400" />
              ) : (
                <CheckCircle2 className="h-9 w-9 text-emerald-400" />
              )}
              <span className="max-w-[16rem] text-[0.875rem] font-bold">{centerToastState.message}</span>
            </div>
          </div>
        )}
      </CenterToastCtx.Provider>
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)
// Centered overlay variant — see CenterToastCtx above. Signature matches
// useToast()'s function: centerToast(message, variant = 'success' | 'error').
export const useCenterToast = () => useContext(CenterToastCtx)
