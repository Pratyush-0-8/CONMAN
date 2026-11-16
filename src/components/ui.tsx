import { type ButtonHTMLAttributes, type ReactNode, useEffect } from 'react'
import { rankFor } from '../lib/game'

/* ---------- Logo: two interlocking rings (opponents) with a node where ideas meet ---------- */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <circle cx="12" cy="16" r="9" stroke="#F5F6FA" strokeWidth="2" />
      <circle cx="20" cy="16" r="9" stroke="#638BFF" strokeWidth="2" />
      <path d="M16 9.2 21.4 16 16 22.8 10.6 16Z" fill="#638BFF" />
      <circle cx="16" cy="16" r="1.6" fill="#0B0D12" />
    </svg>
  )
}
export function Wordmark({ className = '' }: { className?: string }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <Logo />
      <span className="text-[15px] font-semibold tracking-[0.22em]">CONMAN</span>
    </span>
  )
}

/* ---------- Icons ---------- */
const P: Record<string, string> = {
  play: 'M8 5v14l11-7z', trophy: 'M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0zM7 6H4v2a3 3 0 0 0 3 3M17 6h3v2a3 3 0 0 1-3 3',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0', user: 'M20 21a8 8 0 0 0-16 0M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8',
  mic: 'M12 15a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zM19 11a7 7 0 0 1-14 0M12 18v3',
  micoff: 'M3 3l18 18M9 9v3a3 3 0 0 0 5 2M15 10V6a3 3 0 0 0-5.5-1.7M19 11a7 7 0 0 1-1 3.6M5 11a7 7 0 0 0 10 6.3M12 18v3',
  x: 'M6 6l12 12M18 6 6 18', chev: 'M6 9l6 6 6-6', alert: 'M12 9v4M12 17h.01M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  bolt: 'M13 2 4 14h7l-1 8 9-12h-7z', arrow: 'M5 12h14M13 6l6 6-6 6', check: 'M5 12l5 5 9-10', crown: 'M3 8l4 4 5-7 5 7 4-4-2 11H5z',
  eye: 'M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  eyeoff: 'M3 3l18 18M10.6 6.1A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3.2 4M6.6 6.7A17 17 0 0 0 2 12s3.5 7 10 7c1.7 0 3.2-.4 4.5-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  mail: 'M3 6h18v12H3zM3 7l9 7 9-7', logout: 'M10 4H5v16h5M15 8l4 4-4 4M19 12H9',
  home: 'M4 11l8-7 8 7v9H4z', rotate: 'M4 12a8 8 0 0 1 14-5l2-2v6h-6l2.3-2.3A5.5 5.5 0 0 0 6.5 12M20 12a8 8 0 0 1-14 5l-2 2v-6h6l-2.3 2.3',
}
export function Icon({ name, size = 18, className = '' }: { name: keyof typeof P | string; size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d={P[name]} />
    </svg>
  )
}

/* ---------- Button ---------- */
type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; size?: 'md' | 'lg' | 'sm' }
export function Button({ variant = 'secondary', size = 'md', className = '', ...p }: BtnProps) {
  const v = {
    primary: 'bg-accent text-white shadow-[0_8px_30px_-8px_rgba(99,139,255,0.7)] hover:bg-[#7a9cff] hover:-translate-y-0.5',
    secondary: 'bg-card2 text-ink border border-line hover:border-[#38405a] hover:bg-[#202639]',
    ghost: 'text-mute hover:text-ink hover:bg-white/5',
    danger: 'bg-lose/10 text-lose border border-lose/30 hover:bg-lose/20',
  }[variant]
  const s = { sm: 'h-9 px-3.5 text-sm', md: 'h-11 px-5 text-sm', lg: 'h-14 px-8 text-base' }[size]
  return <button {...p} className={`inline-flex items-center justify-center gap-2 rounded-xl font-medium transition-all duration-200 active:translate-y-0 active:scale-[0.98] disabled:opacity-40 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${v} ${s} ${className}`} />
}

export function Card({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-2xl border border-line bg-card ${className}`}>{children}</div>
}
export const Eyebrow = ({ children, className = '' }: { children: ReactNode; className?: string }) => (
  <div className={`text-[11px] font-medium uppercase tracking-[0.18em] text-mute ${className}`}>{children}</div>
)

/* ---------- Avatar & rating ---------- */
const hue = (s: string) => [...s].reduce((a, c) => a + c.charCodeAt(0) * 17, 0) % 360
export function Avatar({ name, size = 40, ring }: { name: string; size?: number; ring?: string }) {
  const h = hue(name || 'x')
  return (
    <div
      className="relative grid shrink-0 place-items-center overflow-hidden rounded-[28%] font-semibold text-ink"
      style={{ width: size, height: size, fontSize: size * 0.38, background: `linear-gradient(135deg, hsl(${h} 45% 30%), hsl(${(h + 40) % 360} 40% 18%))`, boxShadow: ring ? `0 0 0 2px ${ring}` : 'inset 0 0 0 1px rgba(255,255,255,.08)' }}
    >
      <svg className="absolute inset-0 opacity-20" viewBox="0 0 40 40"><circle cx="14" cy="20" r="11" stroke="#fff" fill="none" /><circle cx="26" cy="20" r="11" stroke="#fff" fill="none" /></svg>
      <span className="relative">{(name || '?').slice(0, 2).toUpperCase()}</span>
    </div>
  )
}
export function RatingBadge({ elo, showRank = false }: { elo: number; showRank?: boolean }) {
  const r = rankFor(elo)
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full border border-line bg-card2 px-2.5 py-1 text-xs font-medium tabular-nums">
      <span className="size-1.5 rounded-full" style={{ background: r.color }} />
      {elo}
      {showRank && <span className="text-mute">· {r.name}</span>}
    </span>
  )
}

/* ---------- Banner (errors / info) ---------- */
export function Banner({ tone = 'info', title, children, action }: { tone?: 'info' | 'error'; title: string; children?: ReactNode; action?: ReactNode }) {
  const c = tone === 'error' ? 'border-lose/30 bg-lose/[0.07] text-lose' : 'border-accent/30 bg-accent/[0.07] text-accent'
  return (
    <div role="alert" className={`flex items-start gap-3 rounded-xl border p-3.5 animate-fade-up ${c}`}>
      <Icon name={tone === 'error' ? 'micoff' : 'alert'} className="mt-0.5 shrink-0" />
      <div className="min-w-0 flex-1 text-sm">
        <div className="font-medium">{title}</div>
        {children && <div className="mt-0.5 text-mute">{children}</div>}
      </div>
      {action}
    </div>
  )
}

/* ---------- Dialog ---------- */
export function Dialog({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  useEffect(() => {
    if (!open) return
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', k)
    document.body.style.overflow = 'hidden'
    return () => { window.removeEventListener('keydown', k); document.body.style.overflow = '' }
  }, [open, onClose])
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-6" role="dialog" aria-modal aria-label={title}>
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />
      <div className="relative max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-t-3xl border border-line bg-card p-5 shadow-2xl animate-fade-up sm:rounded-3xl sm:p-8">
        <button onClick={onClose} aria-label="Close" className="absolute right-4 top-4 grid size-9 place-items-center rounded-lg text-mute hover:bg-white/5 hover:text-ink"><Icon name="x" /></button>
        {children}
      </div>
    </div>
  )
}

/* ---------- Loading ---------- */
export function Spinner({ size = 18 }: { size?: number }) {
  return <span className="inline-block animate-orbit rounded-full border-2 border-accent/30 border-t-accent" style={{ width: size, height: size, animationDuration: '0.9s' }} />
}
export function Skeleton({ className = '' }: { className?: string }) {
  return <div className={`relative overflow-hidden rounded-md bg-card2 ${className}`}><div className="absolute inset-y-0 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-white/5 to-transparent" /></div>
}
