'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUser } from '@clerk/nextjs'
import { Bell, CreditCard, Receipt, Repeat, Target } from 'lucide-react'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input, Label } from '@/components/ui/input'
import { Select } from '@/components/ui/select'
import { Segmented } from '@/components/ui/segmented'
import { Logo } from '@/components/logo'
import { useApp } from '@/store'

const OCCUPATIONS = [
  ['accounting', 'Accounting & Finance', 'Contabilidad y finanzas'],
  ['trades', 'Construction & Trades (plumber, electrician…)', 'Construcción y oficios (plomero, electricista…)'],
  ['healthcare', 'Healthcare', 'Salud'],
  ['education', 'Education', 'Educación'],
  ['technology', 'Technology', 'Tecnología'],
  ['retail', 'Retail & Sales', 'Ventas y comercio'],
  ['food', 'Food & Hospitality', 'Restaurantes y hospitalidad'],
  ['transport', 'Transportation & Delivery', 'Transporte y reparto'],
  ['government', 'Government', 'Gobierno'],
  ['business', 'Business owner', 'Dueño de negocio'],
  ['student', 'Student', 'Estudiante'],
  ['homemaker', 'Homemaker', 'Hogar'],
  ['retired', 'Retired', 'Jubilado'],
  ['other', 'Other', 'Otro'],
]

const T = {
  en: {
    setupTitle: 'Welcome to SteerMoney 👋',
    setupSub: "First, a little about you. This helps us personalize your experience.",
    language: 'Language',
    firstName: 'First name',
    lastName: 'Last name',
    dob: 'Date of birth',
    occupation: 'What do you do for work?',
    pick: 'Choose one…',
    continue: 'Continue',
    needName: 'Please enter your first name',
    tipsTitle: "You're all set, ",
    tipsSub: 'Your money, one place. Here is how to get rolling:',
    explore: 'Explore on my own',
    firstDebt: 'Add my first debt',
    tips: [
      [CreditCard, 'text-red-400 bg-red-400/10', 'Start with your debts', 'Add each card or loan on the Debt Tracker with its balance, APR, and minimum payment. The payoff simulator shows your debt-free date instantly.'],
      [Repeat, 'text-sky-400 bg-sky-400/10', 'Add your recurring bills', 'Rent, phone, subscriptions, anything monthly. They feed the reminders bell so nothing sneaks up on you.'],
      [Target, 'text-emerald-400 bg-emerald-400/10', 'Set budgets', 'Your spending categories are ready. Tap the pencil on Budgets to give each one a monthly limit.'],
      [Receipt, 'text-amber-400 bg-amber-400/10', 'Log what you spend', 'Add transactions by hand, or use Import on the Transactions page to pull in a bank CSV. It auto-categorizes and skips duplicates.'],
      [Bell, 'text-purple-400 bg-purple-400/10', 'Watch the bell', 'The bell up top warns you about payments due in the next 7 days. Enable browser notifications to get pinged the day before.'],
    ],
  },
  es: {
    setupTitle: 'Bienvenido a SteerMoney 👋',
    setupSub: 'Primero, cuéntanos un poco de ti. Esto nos ayuda a personalizar tu experiencia.',
    language: 'Idioma',
    firstName: 'Nombre',
    lastName: 'Apellido',
    dob: 'Fecha de nacimiento',
    occupation: '¿A qué te dedicas?',
    pick: 'Elige una opción…',
    continue: 'Continuar',
    needName: 'Escribe tu nombre',
    tipsTitle: 'Todo listo, ',
    tipsSub: 'Tu dinero, en un solo lugar. Así puedes empezar:',
    explore: 'Explorar por mi cuenta',
    firstDebt: 'Agregar mi primera deuda',
    tips: [
      [CreditCard, 'text-red-400 bg-red-400/10', 'Empieza con tus deudas', 'Agrega cada tarjeta o préstamo en Debt Tracker con su saldo, APR y pago mínimo. El simulador te muestra al instante cuándo estarás libre de deudas.'],
      [Repeat, 'text-sky-400 bg-sky-400/10', 'Agrega tus pagos recurrentes', 'Renta, teléfono, suscripciones, todo lo mensual. Alimentan la campana de recordatorios para que nada te tome por sorpresa.'],
      [Target, 'text-emerald-400 bg-emerald-400/10', 'Define presupuestos', 'Tus categorías de gasto ya están listas. Toca el lápiz en Budgets para ponerle un límite mensual a cada una.'],
      [Receipt, 'text-amber-400 bg-amber-400/10', 'Registra tus gastos', 'Agrega transacciones a mano, o usa Import en la página de Transactions para subir el CSV de tu banco. Se categoriza solo y omite duplicados.'],
      [Bell, 'text-purple-400 bg-purple-400/10', 'Atento a la campana', 'La campana de arriba te avisa de pagos que vencen en los próximos 7 días. Activa las notificaciones del navegador para recibir aviso un día antes.'],
    ],
  },
}

// First-run flow: language + profile, then quick tips.
// Shows once per account (persisted via settings.sim.onboarded).
export function Onboarding() {
  const { state, update, viewingAs, space } = useApp()
  const { user } = useUser()
  const router = useRouter()
  const [step, setStep] = useState(0)
  const [lang, setLang] = useState(user?.unsafeMetadata?.lang === 'es' ? 'es' : 'en')
  const [f, setF] = useState({ firstName: user?.firstName || '', lastName: user?.lastName || '', dob: '', occupation: '' })
  const [err, setErr] = useState(null)
  const [saving, setSaving] = useState(false)
  if (!state || viewingAs || space || state.sim.onboarded) return null

  const t = T[lang]
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value })
  const done = () => update((s) => { s.sim.onboarded = true })

  const saveProfile = async () => {
    if (!f.firstName.trim()) return setErr(t.needName)
    setErr(null)
    setSaving(true)
    try {
      await user.update({
        firstName: f.firstName.trim(),
        lastName: f.lastName.trim(),
        unsafeMetadata: { ...user.unsafeMetadata, lang, dob: f.dob || null, occupation: f.occupation || null },
      })
    } catch {
      // name updates can be restricted by Clerk settings; keep the metadata at least
      try { await user.update({ unsafeMetadata: { ...user.unsafeMetadata, lang, dob: f.dob || null, occupation: f.occupation || null } }) } catch {}
    }
    setSaving(false)
    setStep(1)
  }

  return (
    <Dialog open onOpenChange={() => {}}>
      <DialogContent className="max-w-md" onInteractOutside={(e) => e.preventDefault()}>
        {step === 0 ? (
          <>
            <DialogHeader>
              <Logo className="mb-1 h-10 w-10" />
              <DialogTitle>{t.setupTitle}</DialogTitle>
              <p className="text-xs text-muted-foreground">{t.setupSub}</p>
            </DialogHeader>
            <div className="grid gap-3">
              <div>
                <Label>{t.language}</Label>
                <Segmented value={lang} onChange={setLang} options={[['en', 'English'], ['es', 'Español']]} />
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                <div><Label>{t.firstName}</Label><Input value={f.firstName} onChange={set('firstName')} /></div>
                <div><Label>{t.lastName}</Label><Input value={f.lastName} onChange={set('lastName')} /></div>
              </div>
              <div><Label>{t.dob}</Label><Input type="date" value={f.dob} onChange={set('dob')} /></div>
              <div>
                <Label>{t.occupation}</Label>
                <Select className="w-full" value={f.occupation} onChange={set('occupation')}>
                  <option value="">{t.pick}</option>
                  {OCCUPATIONS.map(([id, en, es]) => <option key={id} value={id}>{lang === 'es' ? es : en}</option>)}
                </Select>
              </div>
              {err && <p className="text-xs text-red-400">{err}</p>}
            </div>
            <DialogFooter>
              <Button className="w-full sm:w-auto" disabled={saving} onClick={saveProfile}>{t.continue}</Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <Logo className="mb-1 h-10 w-10" />
              <DialogTitle>{t.tipsTitle}{f.firstName.trim() || 'friend'} 🎉</DialogTitle>
              <p className="text-xs text-muted-foreground">{t.tipsSub}</p>
            </DialogHeader>
            <div className="space-y-3">
              {t.tips.map(([Icon, tone, title, body]) => (
                <div key={title} className="flex gap-3">
                  <span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${tone}`}>
                    <Icon className="h-4 w-4" />
                  </span>
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold leading-tight">{title}</div>
                    <div className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{body}</div>
                  </div>
                </div>
              ))}
            </div>
            <DialogFooter className="flex-col gap-2 sm:flex-row">
              <Button variant="ghost" className="w-full sm:w-auto" onClick={done}>{t.explore}</Button>
              <Button className="w-full sm:w-auto" onClick={() => { done(); router.push('/debts') }}>
                <CreditCard />{t.firstDebt}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
