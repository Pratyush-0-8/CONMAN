import { type InputHTMLAttributes, type ReactNode, useState } from 'react'
import { Icon, Wordmark } from './ui'
import { passwordStrength } from '../lib/auth'

export function AuthShell({ children, onBack, backLabel = 'Back' }: { children: ReactNode; onBack?: () => void; backLabel?: string }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-grid" />
      <div className="pointer-events-none absolute left-1/2 top-0 size-[560px] -translate-x-1/2 -translate-y-1/4 rounded-full bg-accent/10 blur-[120px]" />
      <header className="relative z-10 mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <button onClick={onBack} aria-label="CONMAN home"><Wordmark /></button>
        {onBack && <button onClick={onBack} className="text-sm text-mute hover:text-ink">{backLabel}</button>}
      </header>
      <main className="relative z-10 flex flex-1 items-center justify-center px-4 pb-16 pt-4">
        <div className="w-full max-w-md animate-fade-up rounded-3xl border border-line bg-card/90 p-6 shadow-[0_30px_80px_-40px_rgba(99,139,255,0.4)] backdrop-blur sm:p-9">{children}</div>
      </main>
    </div>
  )
}
export const AuthHeading = ({ title, sub }: { title: string; sub?: ReactNode }) => (
  <div className="mb-7"><h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">{title}</h1>{sub && <p className="mt-2 text-sm text-mute">{sub}</p>}</div>
)

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> { label: string; error?: string; hint?: ReactNode; onChange: (v: string) => void; right?: ReactNode }
export function TextField({ label, error, hint, onChange, right, id, ...p }: FieldProps) {
  const fid = id ?? p.name
  return (
    <div>
      <div className="mb-2 flex items-center justify-between"><label htmlFor={fid} className="text-xs font-medium text-mute">{label}</label>{right}</div>
      <input id={fid} aria-invalid={!!error} aria-describedby={error ? `${fid}-e` : undefined} onChange={(e) => onChange(e.target.value)} {...p}
        className={`h-12 w-full rounded-xl border bg-bg/60 px-4 text-[15px] outline-none transition-colors placeholder:text-mute/50 focus:border-accent ${error ? 'border-lose/60' : 'border-line'}`} />
      {error ? <p id={`${fid}-e`} className="mt-1.5 text-xs text-lose">{error}</p> : hint ? <p className="mt-1.5 text-xs text-mute">{hint}</p> : null}
    </div>
  )
}
export function PasswordField({ showStrength, ...p }: Omit<FieldProps, 'type'> & { showStrength?: boolean }) {
  const [show, setShow] = useState(false)
  const s = passwordStrength(String(p.value ?? ''))
  return (
    <div>
      <div className="relative">
        <TextField {...p} type={show ? 'text' : 'password'} />
        <button type="button" onClick={() => setShow((x) => !x)} aria-label={show ? 'Hide password' : 'Show password'} className={`absolute right-3 grid size-8 place-items-center rounded-lg text-mute hover:text-ink ${p.error ? 'top-[34px]' : 'top-[34px]'}`}>
          <Icon name={show ? 'eyeoff' : 'eye'} size={18} />
        </button>
      </div>
      {showStrength && !!p.value && (
        <div className="mt-2 flex items-center gap-1.5" aria-label="Password strength">
          {[1, 2, 3, 4].map((i) => <span key={i} className="h-1 flex-1 rounded-full transition-colors" style={{ background: i <= s ? ['', '#F07878', '#E8C06A', '#638BFF', '#38C994'][s] : '#242A3A' }} />)}
          <span className="w-12 text-right text-[11px] text-mute">{['', 'Weak', 'Fair', 'Good', 'Strong'][s]}</span>
        </div>
      )}
    </div>
  )
}
export function FormMessage({ children }: { children: ReactNode }) {
  return <div role="alert" className="flex items-start gap-2.5 rounded-xl border border-lose/30 bg-lose/[0.07] p-3 text-sm text-lose animate-fade-up"><Icon name="alert" size={16} className="mt-0.5 shrink-0" />{children}</div>
}
export function StatusIcon({ name, tone = 'accent' }: { name: string; tone?: 'accent' | 'win' | 'lose' }) {
  const c = { accent: 'bg-accent/10 text-accent border-accent/30', win: 'bg-win/10 text-win border-win/30', lose: 'bg-lose/10 text-lose border-lose/30' }[tone]
  return <div className={`relative mx-auto mb-6 grid size-16 animate-pop place-items-center rounded-2xl border ${c}`}><Icon name={name} size={28} /></div>
}
