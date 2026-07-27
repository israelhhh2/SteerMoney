'use client'
import { useEffect, useState } from 'react'

// Matches Tailwind's `sm` breakpoint — true below 640px.
// Recharts props (legend layout, axis width) aren't CSS, so charts need this.
export function useIsMobile() {
  const [mobile, setMobile] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 639px)')
    const onChange = () => setMobile(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])
  return mobile
}
