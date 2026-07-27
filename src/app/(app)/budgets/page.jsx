'use client'
import { useRouter } from 'next/navigation'
import Budgets from '@/views/Budgets'

export default function Page() {
  const router = useRouter()
  return <Budgets onViewTx={(cat) => router.push('/transactions?cat=' + encodeURIComponent(cat))} />
}
