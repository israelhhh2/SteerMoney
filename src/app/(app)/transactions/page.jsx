'use client'
import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Transactions from '@/views/Transactions'

function TxPage() {
  const router = useRouter()
  const params = useSearchParams()
  const account = params.get('account')
  const cat = params.get('cat')
  // Single setter backs both the account dropdown (views/Transactions.jsx)
  // and deep links from AccountDetail.jsx ("View all in Transactions") /
  // Dashboard's "Where the money went" rows / Budgets' category rows —
  // all of them just read/write the same `?account=`/`?cat=` params, so the
  // dropdown/select always reflects a deep-linked selection and clearing it
  // (id=null) drops the param entirely rather than leaving `?account=`/`?cat=`
  // dangling with an empty value.
  const setParam = (key, value) => (id) => {
    const next = new URLSearchParams(params.toString())
    if (id) next.set(key, id); else next.delete(key)
    const qs = next.toString()
    router.replace(qs ? `/transactions?${qs}` : '/transactions')
  }
  return (
    <Transactions
      catFilter={cat}
      setCatFilter={setParam('cat')}
      accountFilter={account}
      setAccountFilter={setParam('account')}
    />
  )
}

export default function Page() {
  return <Suspense><TxPage /></Suspense>
}
