import { clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs) { return twMerge(clsx(inputs)) }

export const fmt = (n) => (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const fmt0 = (n) => (n < 0 ? '-' : '') + '$' + Math.round(Math.abs(n)).toLocaleString('en-US')

// Module-level language flag, kept in sync by lib/i18n.js's useLang() hook
// (every view calls useT()/useLang() on render). The date helpers below are
// plain functions called from lots of non-component code, not hooks — this
// is the "keep it simple" way for them to know the current language without
// threading `lang` through every call site.
export let currentLang = 'en'
export function setCurrentLang(lang) { currentLang = lang === 'es' ? 'es' : 'en' }

const MONTHS_ES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']

export const isoDate = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
export const today = () => isoDate(new Date())
export const ymLabel = (ym) => {
  const y = +ym.slice(0, 4), m = +ym.slice(5, 7) - 1
  if (currentLang === 'es') return `${MONTHS_ES[m]}. ${y}`
  return new Date(y, m, 1).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
export const monthLabel = (d) => {
  const dt = new Date(d)
  if (currentLang === 'es') return `${MONTHS_ES[dt.getMonth()]}. ${dt.getFullYear()}`
  return dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
}
export const prettyDate = (iso) => {
  const dt = new Date(iso + 'T00:00:00')
  if (currentLang === 'es') return `${dt.getDate()} ${MONTHS_ES[dt.getMonth()]}.`
  return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}
export const uid = (p = 'x') => p + Math.random().toString(36).slice(2, 9)

// Category id -> color/emoji lookups now live in lib/categories.js (the
// single source shared with store.jsx's DEFAULT_CATEGORIES and
// components/shared.jsx's CAT_ICONS — see that file's header comment) —
// re-exported here unchanged so every existing `from '@/lib/utils'` import
// keeps working.
export { CAT_COLORS, CAT_EMOJI } from './categories'
import { CAT_COLORS as _CAT_COLORS, CAT_EMOJI as _CAT_EMOJI } from './categories'
export const catColor = (id) => _CAT_COLORS[id] || '#a1a1aa'
export const catEmoji = (id) => _CAT_EMOJI[id] || '🎯'

export const ordinal = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]) }

export function srcLabel(desc) {
  if (/Hammr Payroll/i.test(desc)) return 'Hammr Payroll (work)'
  const z = desc.match(/^ZELLE (.+)/i)
  if (z) return 'Zelle · ' + z[1].replace(/\s+[A-Z0-9]{8,}$/, '').trim()
  if (/P2P.*Money Network|Money Network.*P2P|Julia Vallejo : P2P/i.test(desc)) return 'Julia Vallejo (P2P)'
  if (/APPLE CASH/i.test(desc)) return 'Apple Cash'
  return desc.split(' ').slice(0, 3).join(' ')
}
