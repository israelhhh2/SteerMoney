'use client'
import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Transactions from '@/views/Transactions'

function TxPage() {
  const router = useRouter()
  const params = useSearchParams()
  const preset = params.get('cat')
  const account = params.get('account')
  const clearAccount = () => {
    const next = new URLSearchParams(params.toString())
    next.delete('account')
    const qs = next.toString()
    router.replace(qs ? `/transactions?${qs}` : '/transactions')
  }
  return (
    <Transactions
      preset={preset}
      clearPreset={() => router.replace('/transactions')}
      accountFilter={account}
      clearAccountFilter={clearAccount}
    />
  )
}

export default function Page() {
  return <Suspense><TxPage /></Suspense>
}
