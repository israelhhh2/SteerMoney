'use client'
import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Transactions from '@/views/Transactions'

function TxPage() {
  const router = useRouter()
  const params = useSearchParams()
  const preset = params.get('cat')
  const account = params.get('account')
  // Single setter backs both the account dropdown (views/Transactions.jsx)
  // and deep links from AccountDetail.jsx ("View all in Transactions") —
  // both just read/write the same `?account=` param, so the dropdown always
  // reflects a deep-linked selection and clearing it (id=null) drops the
  // param entirely rather than leaving `?account=`.
  const setAccount = (id) => {
    const next = new URLSearchParams(params.toString())
    if (id) next.set('account', id); else next.delete('account')
    const qs = next.toString()
    router.replace(qs ? `/transactions?${qs}` : '/transactions')
  }
  return (
    <Transactions
      preset={preset}
      clearPreset={() => router.replace('/transactions')}
      accountFilter={account}
      setAccountFilter={setAccount}
    />
  )
}

export default function Page() {
  return <Suspense><TxPage /></Suspense>
}
