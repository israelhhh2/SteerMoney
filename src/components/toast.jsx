'use client'
import { createContext, useCallback, useContext, useRef, useState } from 'react'
import { CheckCircle2, XCircle } from 'lucide-react'
import { cn } from '@/lib/utils'

const ToastCtx = createContext(() => {})

let nextId = 0

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

  return (
    <ToastCtx.Provider value={toast}>
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
    </ToastCtx.Provider>
  )
}

export const useToast = () => useContext(ToastCtx)
