import { type FormEvent, useEffect, useState } from 'react'
import { AuthHeading, AuthShell, FormMessage, PasswordField, StatusIcon, TextField } from '../components/auth'
import { Button, Icon, Logo, Spinner, Wordmark } from '../components/ui'
import { AuthError, type AuthUser, checkUsername, requestPasswordReset, resendVerification, signIn, signUp, validators } from '../lib/auth'
import { supabase } from '../lib/supabase';

export type AuthRoute = 'landing' | 'signin' | 'signup' | 'forgot' | 'reset-sent' | 'verify' | 'verify-invalid'
type Go = (r: AuthRoute) => void

const Submit = ({ loading, children }: { loading: boolean; children: string }) => (
  <Button type="submit" variant="primary" size="lg" disabled={loading} className="w-full">{loading ? <><Spinner size={18} />Please wait…</> : children}</Button>
)
const Switch = ({ text, action, onClick }: { text: string; action: string; onClick: () => void }) => (
  <p className="mt-6 text-center text-sm text-mute">{text} <button type="button" onClick={onClick} className="font-medium text-accent hover:underline">{action}</button></p>
)

/* ---------------- Landing ---------------- */
export function Landing({ go, onLeaderboard }: { go: Go; onLeaderboard: () => void }) {
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[720px] bg-grid" />
      <div className="pointer-events-none absolute left-1/2 top-1/3 size-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/10 blur-[130px]" />
      <svg className="pointer-events-none absolute left-1/2 top-24 -translate-x-1/2 opacity-[0.07]" width="900" height="450" viewBox="0 0 32 16" fill="none"><circle cx="12" cy="8" r="7.5" stroke="#fff" strokeWidth=".12" /><circle cx="20" cy="8" r="7.5" stroke="#fff" strokeWidth=".12" /><path d="M16 1.5 21 8l-5 6.5L11 8Z" stroke="#fff" strokeWidth=".12" /></svg>
      <header className="relative z-10 mx-auto flex h-16 w-full max-w-6xl items-center justify-between px-5 sm:px-8">
        <Wordmark />
        <div className="flex items-center gap-1">
          <button onClick={onLeaderboard} className="hidden rounded-lg px-4 py-2 text-sm text-mute hover:text-ink sm:block">Leaderboard</button>
          <Button variant="ghost" size="sm" onClick={() => go('signin')}>Sign In</Button>
        </div>
      </header>
      <main className="relative z-10 flex flex-1 flex-col items-center justify-center px-5 pb-20 pt-10 text-center">
        <div className="animate-pop relative mb-8 grid size-24 place-items-center">
          <span className="absolute inset-0 animate-ping-slow rounded-full border border-accent/40" />
          <div className="absolute inset-0 animate-orbit rounded-full border border-dashed border-line"><span className="absolute -top-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_14px_#638BFF]" /></div>
          <div className="grid size-16 place-items-center rounded-2xl border border-line bg-card"><Logo size={36} /></div>
        </div>
        <div className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-line bg-card/70 px-3.5 py-1.5 text-xs text-mute"><span className="size-1.5 animate-blink rounded-full bg-win" />Ranked 1v1 · Season 1 open</div>
        <h1 className="animate-fade-up mt-6 text-5xl font-semibold leading-[1.02] tracking-tight [animation-delay:80ms] sm:text-7xl">Think fast.<br /><span className="text-accent">Speak sharper.</span></h1>
        <p className="animate-fade-up mx-auto mt-5 max-w-md text-base text-mute [animation-delay:160ms] sm:text-lg">The competitive arena for critical thinking. Think on your feet, outreason your opponents, and climb the ranks.</p>
        <div className="animate-fade-up mt-10 flex w-full max-w-sm flex-col gap-3 [animation-delay:240ms] sm:max-w-none sm:flex-row sm:justify-center">
          <Button variant="primary" size="lg" onClick={() => go('signup')}>Create Account<Icon name="arrow" /></Button>
          <Button size="lg" onClick={() => go('signin')}>Sign In</Button>
        </div>
        <button onClick={onLeaderboard} className="animate-fade-up mt-6 inline-flex items-center gap-2 text-sm text-mute transition-colors [animation-delay:320ms] hover:text-ink"><Icon name="trophy" size={16} />View the public leaderboard</button>
        <div className="animate-fade-up mt-16 grid w-full max-w-xl grid-cols-3 gap-3 [animation-delay:400ms]">
          {[['5s', 'Think', '#638BFF'], ['15s', 'Speak', '#F07878'], ['500', 'Starting ELO', '#38C994']].map(([n, l, c]) => (
            <div key={l} className="rounded-xl border border-line bg-card/60 p-4"><div className="text-2xl font-semibold tabular" style={{ color: c }}>{n}</div><div className="text-xs text-mute">{l}</div></div>))}
        </div>
      </main>
    </div>
  )
}

/* ---------------- Create account ---------------- */
export function SignUp({ go, onCreated }: { go: Go; onCreated: (u: AuthUser) => void }) {
  const [f, setF] = useState({ username: '', email: '', password: '', confirm: '' })
  const [touched, setTouched] = useState<Record<string, boolean>>({})
  const [server, setServer] = useState<Record<string, string>>({})
  const [formErr, setFormErr] = useState('')
  const [loading, setLoading] = useState(false)
  const [avail, setAvail] = useState<'' | 'checking' | 'ok'>('')
  const set = (k: keyof typeof f) => (v: string) => { setF((s) => ({ ...s, [k]: v })); setServer((s) => ({ ...s, [k]: '' })) }
  const errs: Record<string, string> = {
    username: validators.username(f.username), email: validators.email(f.email), password: validators.password(f.password),
    confirm: f.confirm !== f.password ? 'Passwords don’t match.' : '',
  }
  const show = (k: string) => (touched[k] ? errs[k] || server[k] : server[k]) || ''
  const blur = (k: string) => () => setTouched((t) => ({ ...t, [k]: true }))

  useEffect(() => {
    if (validators.username(f.username)) { setAvail(''); return }
    setAvail('checking')
    let live = true
    const t = setTimeout(async () => {
      const ok = await checkUsername(f.username)
      if (!live) return
      setAvail(ok ? 'ok' : '')
      if (!ok) setServer((s) => ({ ...s, username: 'That username is already taken.' }))
    }, 400)
    return () => { live = false; clearTimeout(t) }
  }, [f.username])

  async function submit(e: FormEvent) {
    e.preventDefault()
    setTouched({ username: true, email: true, password: true, confirm: true }); setFormErr('')
    if (Object.values(errs).some(Boolean) || server.username) return
    setLoading(true)
    try { onCreated(await signUp({ username: f.username, email: f.email, password: f.password })) }
    catch (err) {
      if (err instanceof AuthError && err.field !== 'form') setServer((s) => ({ ...s, [err.field]: err.message }))
      else setFormErr('Something went wrong. Please try again.')
      setLoading(false)
    }
  }
  return (
    <AuthShell onBack={() => go('landing')}>
      <AuthHeading title="Create your account" sub="Start at 500 ELO and climb the ranked ladder." />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {formErr && <FormMessage>{formErr}</FormMessage>}
        <TextField label="Username" name="username" value={f.username} onChange={set('username')} onBlur={blur('username')} error={show('username')} maxLength={20} autoComplete="username" placeholder="quietfalcon"
          hint={avail === 'checking' ? 'Checking availability…' : avail === 'ok' ? <span className="text-win">Available</span> : 'Public. Shown in matches and on leaderboards.'} />
        <TextField label="Email" name="email" type="email" value={f.email} onChange={set('email')} onBlur={blur('email')} error={show('email')} autoComplete="email" placeholder="you@example.com" hint="Private. Never shown to other players." />
        <PasswordField label="Password" name="password" value={f.password} onChange={set('password')} onBlur={blur('password')} error={show('password')} autoComplete="new-password" placeholder="At least 8 characters" showStrength />
        <PasswordField label="Confirm password" name="confirm" value={f.confirm} onChange={set('confirm')} onBlur={blur('confirm')} error={show('confirm')} autoComplete="new-password" placeholder="Repeat password" />
        <div className="pt-2"><Submit loading={loading}>Create Account</Submit></div>
      </form>
      <Switch text="Already have an account?" action="Sign in" onClick={() => go('signin')} />
    </AuthShell>
  )
}

/* ---------------- Sign in ---------------- */
export function SignIn({ go, onSignedIn, onUnverified, notice }: { go: Go; onSignedIn: (u: AuthUser) => void; onUnverified: (u: AuthUser) => void; notice?: string }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [touched, setTouched] = useState(false)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)
  const eErr = touched ? validators.email(email) : ''
  const pErr = touched && !password ? 'Enter your password.' : ''
  async function submit(e: FormEvent) {
    e.preventDefault(); setTouched(true); setErr('')
    if (validators.email(email) || !password) return
    setLoading(true)
    try { const u = await signIn(email, password); u.verified ? onSignedIn(u) : onUnverified(u) }
    catch (x) { setErr(x instanceof AuthError ? x.message : 'Something went wrong. Please try again.'); setLoading(false) }
  }
  return (
    <AuthShell onBack={() => go('landing')}>
      <AuthHeading title="Welcome back" sub="Sign in to return to the arena." />
      <form onSubmit={submit} className="space-y-4" noValidate>
        {notice && !err && <div className="flex items-center gap-2.5 rounded-xl border border-accent/30 bg-accent/[0.07] p-3 text-sm text-accent"><Icon name="alert" size={16} />{notice}</div>}
        {err && <FormMessage>{err}</FormMessage>}
        <TextField label="Email" name="email" type="email" value={email} onChange={setEmail} error={eErr} autoComplete="email" placeholder="you@example.com" />
        <PasswordField label="Password" name="password" value={password} onChange={setPassword} error={pErr} autoComplete="current-password" placeholder="Your password"
          right={<button type="button" onClick={() => go('forgot')} className="text-xs text-accent hover:underline">Forgot password?</button>} />
        <div className="pt-2"><Submit loading={loading}>Sign In</Submit></div>
      </form>
      <Switch text="New to CONMAN?" action="Create account" onClick={() => go('signup')} />
    </AuthShell>
  )
}

/* ---------------- Forgot / reset sent ---------------- */
export function Forgot({ go, onSent }: { go: Go; onSent: (email: string) => void }) {
  const [email, setEmail] = useState('')
  const [touched, setTouched] = useState(false)
  const [loading, setLoading] = useState(false)
  const err = touched ? validators.email(email) : ''
  async function submit(e: FormEvent) {
    e.preventDefault(); setTouched(true)
    if (validators.email(email)) return
    setLoading(true); await requestPasswordReset(email); onSent(email)
  }
  return (
    <AuthShell onBack={() => go('signin')} backLabel="Back to sign in">
      <AuthHeading title="Reset your password" sub="Enter your email and we’ll send you a link to choose a new password." />
      <form onSubmit={submit} className="space-y-4" noValidate>
        <TextField label="Email" name="email" type="email" value={email} onChange={setEmail} error={err} autoComplete="email" placeholder="you@example.com" />
        <div className="pt-2"><Submit loading={loading}>Send reset link</Submit></div>
      </form>
      <Switch text="Remembered it?" action="Sign in" onClick={() => go('signin')} />
    </AuthShell>
  )
}
export function ResetSent({ email, go }: { email: string; go: Go }) {
  return (
    <AuthShell>
      <div className="text-center">
        <StatusIcon name="mail" tone="win" />
        <h1 className="text-2xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="mt-3 text-sm text-mute">If an account exists for <b className="font-medium text-ink">{email}</b>, a password reset link is on its way. It expires in 1 hour.</p>
        <Button variant="primary" size="lg" className="mt-8 w-full" onClick={() => go('signin')}>Back to sign in</Button>
        <button onClick={() => go('forgot')} className="mt-4 text-sm text-mute hover:text-ink">Use a different email</button>
      </div>
    </AuthShell>
  )
}

/* ---------------- Email verification ---------------- */

export function VerifyPending({
  email,
  go,
}: {
  email: string
  go: Go
  onVerified: () => Promise<void>
  onExpired: () => void
}) {
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function resend() {
    setBusy(true)
    setError('')

    try {
      await resendVerification(email)
      setSent(true)
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Could not resend verification email.'
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <AuthShell onBack={() => go('landing')}>
      <div className="text-center">
        <StatusIcon name="mail" />

        <h1 className="text-2xl font-semibold tracking-tight">
          Verify your email
        </h1>

        <p className="mt-3 text-sm text-mute">
          We sent a confirmation link to{' '}
          <b className="font-medium text-ink">{email}</b>.
          Click the link to activate your account.
        </p>

        <div className="mt-7 space-y-3">
          {error && <FormMessage>{error}</FormMessage>}

          <Button
            size="lg"
            className="w-full"
            onClick={resend}
            disabled={busy}
          >
            {busy ? 'Sending...' : 'Resend verification email'}
          </Button>

          {sent && (
            <p className="text-xs text-win">
              Verification email sent!
            </p>
          )}
        </div>

        <button
          onClick={() => go('signin')}
          className="mt-6 text-sm text-mute hover:text-ink"
        >
          Back to sign in
        </button>
      </div>
    </AuthShell>
  )
}

export function VerifyInvalid({ go }: { go: Go }) {
  return (
    <AuthShell>
      <div className="text-center">
        <StatusIcon name="alert" tone="lose" />
        <h1 className="text-2xl font-semibold tracking-tight">Link invalid or expired</h1>
        <p className="mt-3 text-sm text-mute">This verification link can no longer be used. Request a fresh one and try again.</p>
        <Button variant="primary" size="lg" className="mt-8 w-full" onClick={() => go('verify')}>Send a new link</Button>
        <button onClick={() => go('signin')} className="mt-4 text-sm text-mute hover:text-ink">Back to sign in</button>
      </div>
    </AuthShell>
  )
}
