'use client'
import { Suspense } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import Accounts from '@/views/Accounts'

function AccountsPage() {
  const router = useRouter()
  const params = useSearchParams()
  const editParam = params.get('edit')
  return <Accounts editParam={editParam} clearEditParam={() => router.replace('/accounts')} />
}

export default function Page() {
  return <Suspense><AccountsPage /></Suspense>
}
