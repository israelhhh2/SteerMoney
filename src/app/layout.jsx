import { Nunito } from 'next/font/google'
import { AuthProvider } from '@/components/auth-provider'
import './globals.css'

const nunito = Nunito({ subsets: ['latin'], weight: ['400', '600', '700', '800', '900'], variable: '--font-sans' })

export const metadata = {
  title: 'SteerMoney',
  description: 'Steer your money: debts, budgets, recurring bills, charts, and payoff simulators, all in one place.',
}

// Explicit (rather than relying on Next's implicit default, which happens to
// render the same tag) so the "don't cap maximumScale" decision is on record:
// the mobile zoom-after-editing bug (reported from /debts) is iOS auto-
// zooming any focused input under 16px font-size, not a viewport-scale
// problem — the real fix is the `input, select, textarea { font-size: 16px
// !important }` mobile rule in globals.css. Adding `maximumScale: 1` here
// would "fix" the symptom by disabling pinch-zoom entirely, which is a known
// accessibility regression (WCAG 1.4.4) for anyone who needs to zoom the UI
// — not worth trading away for a problem the font-size fix already solves.
export const viewport = {
  width: 'device-width',
  initialScale: 1,
}

export default function RootLayout({ children }) {
  return (
    // suppressHydrationWarning: mobile browsers (Chrome iOS) inject attributes like
    // __gcrremoteframetoken into <html> before React hydrates; ignore those.
    <html lang="en" className={nunito.variable} suppressHydrationWarning>
      <body>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  )
}
