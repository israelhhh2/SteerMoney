// SteerMoney brand mark: a steering wheel with a gold coin hub on the brand
// gradient. Steering + money, readable from favicon size up.
export function Logo({ className = 'h-8 w-8' }) {
  return (
    <svg viewBox="0 0 48 48" className={`shrink-0 ${className}`} aria-hidden="true">
      <defs>
        <linearGradient id="sm-grad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#10b981" />
          <stop offset="1" stopColor="#0ea5e9" />
        </linearGradient>
      </defs>
      <rect width="48" height="48" rx="12" fill="url(#sm-grad)" />
      <circle cx="24" cy="24" r="14" stroke="#0c1222" strokeWidth="4" fill="none" />
      <g stroke="#0c1222" strokeWidth="3.4">
        <line x1="24" y1="24" x2="24" y2="10.5" />
        <line x1="24" y1="24" x2="12.4" y2="31" />
        <line x1="24" y1="24" x2="35.6" y2="31" />
      </g>
      <circle cx="24" cy="24" r="6.4" fill="#0c1222" />
      <circle cx="24" cy="24" r="4.6" fill="#fbbf24" />
    </svg>
  )
}

// Wordmark: "Steer" white + "Money" in brand green.
export function Wordmark({ className = 'text-[15px]' }) {
  return (
    <span className={`font-semibold tracking-tight ${className}`}>
      Steer<span className="text-emerald-400">Money</span>
    </span>
  )
}
