import { FinanceChat } from '@/components/finance-chat'

// Full-page home for the finance chat (also reachable via the floating
// bubble on every other page — see components/finance-chat.jsx `mode`).
export default function Page() {
  return <FinanceChat mode="page" />
}
