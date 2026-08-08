'use client'
import { Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import Charts from '@/views/Charts'

function ChartsPage() {
  const params = useSearchParams()
  return <Charts focus={params.get('focus')} />
}

export default function Page() {
  return <Suspense><ChartsPage /></Suspense>
}
