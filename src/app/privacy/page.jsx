import Link from 'next/link'
import { Logo, Wordmark } from '@/components/logo'

export const metadata = { title: 'Privacy Policy — SteerMoney' }

const SECTIONS = [
  [
    '1. Who we are',
    <>
      <p>
        SteerMoney is a personal finance app operated by Wage Watch Compliance Group. If
        you have questions about this policy or how your data is handled, contact us at{' '}
        <a href="mailto:info@wagewatchcompliance.com" className="text-primary underline underline-offset-2">
          info@wagewatchcompliance.com
        </a>
        .
      </p>
    </>,
  ],
  [
    '2. Information we collect',
    <>
      <ul className="list-disc space-y-1.5 pl-5">
        <li><strong>Account information</strong> — your name and email address, managed through our authentication provider, Supabase.</li>
        <li><strong>Financial data from connected accounts</strong> — if you link a bank through Plaid, we receive account balances, transactions, and liabilities (like loans and credit cards) for the accounts you choose to connect.</li>
        <li><strong>Data you enter manually</strong> — budgets, debts, goals, and any other information you add yourself.</li>
        <li><strong>Basic usage and log data</strong> — things like device and browser type, and general activity in the app, used to keep it running reliably.</li>
      </ul>
    </>,
  ],
  [
    '3. How we get your bank data',
    <>
      <p>
        Bank connections are made through Plaid, a third-party service. You choose which
        accounts to connect, and Plaid runs its own consent flow before sharing any data
        with us. We never see or store your bank username or password — those stay
        between you and Plaid. You can read Plaid&apos;s own privacy policy at{' '}
        <a
          href="https://plaid.com/legal/#end-user-privacy-policy"
          target="_blank"
          rel="noreferrer"
          className="text-primary underline underline-offset-2"
        >
          plaid.com/legal/#end-user-privacy-policy
        </a>
        .
      </p>
    </>,
  ],
  [
    '4. How we use your information',
    <>
      <p>
        We use your information to provide SteerMoney&apos;s features — budgeting, debt
        tracking, goal tracking, and financial insights. We do not sell your personal
        data, we do not share it with advertisers, and we do not use it to market
        third-party products or services to you.
      </p>
    </>,
  ],
  [
    '5. Storage and security',
    <>
      <ul className="list-disc space-y-1.5 pl-5">
        <li>Data is encrypted in transit (TLS 1.2+) and encrypted at rest.</li>
        <li>Row-level security ensures only you can access your own data.</li>
        <li>Bank access tokens are stored server-side only and are never exposed to your browser or any client app.</li>
        <li>Multi-factor authentication is required on all of our administrative systems.</li>
      </ul>
    </>,
  ],
  [
    '6. Service providers we use',
    <>
      <p>We rely on a small set of trusted providers, each of which processes data only to deliver their specific service to us:</p>
      <ul className="mt-2 list-disc space-y-1.5 pl-5">
        <li><strong>Supabase</strong> — database storage, authentication, and account management.</li>
        <li><strong>Vercel</strong> — application hosting.</li>
        <li><strong>Plaid</strong> — bank connectivity and financial data.</li>
      </ul>
    </>,
  ],
  [
    '7. Data retention and deletion',
    <>
      <p>
        We keep your data for as long as your account is active. You can disconnect a
        linked bank at any time, which revokes our access through Plaid immediately. You
        can also request full deletion of your account and data at any time by emailing{' '}
        <a href="mailto:info@wagewatchcompliance.com" className="text-primary underline underline-offset-2">
          info@wagewatchcompliance.com
        </a>
        . We&apos;ll delete your data upon request.
      </p>
    </>,
  ],
  [
    '8. Your rights',
    <>
      <p>
        You can access, correct, delete, or export your data at any time. To exercise any
        of these rights, contact us at{' '}
        <a href="mailto:info@wagewatchcompliance.com" className="text-primary underline underline-offset-2">
          info@wagewatchcompliance.com
        </a>
        .
      </p>
    </>,
  ],
  [
    '9. Children',
    <>
      <p>SteerMoney is not directed at, and is not intended for use by, anyone under the age of 18.</p>
    </>,
  ],
  [
    '10. Changes to this policy',
    <>
      <p>
        If we make changes to this policy, we&apos;ll update the effective date below and
        note any material changes here.
      </p>
    </>,
  ],
]

export default function PrivacyPolicy() {
  return (
    <div className="flex min-h-screen flex-col">
      {/* header */}
      <header className="mx-auto flex w-full max-w-5xl items-center gap-3 px-6 py-5">
        <Logo className="h-8 w-8" />
        <Wordmark />
        <div className="ml-auto">
          <Link href="/home" className="rounded-lg px-3.5 py-2 text-[13px] font-medium text-muted-foreground transition hover:text-foreground">
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-10">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Privacy Policy</h1>
        <p className="mt-2 text-[13px] text-muted-foreground">Effective date: August 4, 2026</p>

        <p className="mt-6 text-[15px] leading-relaxed text-muted-foreground">
          This policy explains what information SteerMoney collects, how we use it, and
          the choices you have. We&apos;ve tried to write it in plain English rather than
          dense legal language.
        </p>

        <div className="mt-10 space-y-8">
          {SECTIONS.map(([title, body]) => (
            <section key={title} className="rounded-xl border bg-card p-5">
              <h2 className="text-[15px] font-semibold">{title}</h2>
              <div className="mt-2 text-[13.5px] leading-relaxed text-muted-foreground">{body}</div>
            </section>
          ))}
        </div>

        <div className="mt-10">
          <Link href="/home" className="text-[13px] font-medium text-primary underline underline-offset-2">
            &larr; Back to home
          </Link>
        </div>
      </main>

      <footer className="border-t py-6 text-center text-[11px] text-muted-foreground">
        SteerMoney · made with ❤️
      </footer>
    </div>
  )
}
