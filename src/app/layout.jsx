import { Nunito } from 'next/font/google'
import { AuthProvider } from '@/components/auth-provider'
import './globals.css'

const nunito = Nunito({ subsets: ['latin'], weight: ['400', '600', '700', '800', '900'], variable: '--font-sans' })

export const metadata = {
  title: 'SteerMoney',
  description: 'Steer your money: debts, budgets, recurring bills, charts, and payoff simulators, all in one place.',
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
