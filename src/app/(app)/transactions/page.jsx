'use client'
import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Transactions from '@/views/Transactions'

function TxPage() {
  const router = useRouter()
  const preset = useSearchParams().get('cat')
  return <Transactions preset={preset} clearPreset={() => router.replace('/transactions')} />
}

export default function Page() {
  return <Suspense><TxPage /></Suspense>
}
