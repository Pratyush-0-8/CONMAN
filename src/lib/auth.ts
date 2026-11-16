/**
 * MOCK AUTH SERVICE — replace this module with Supabase Auth (email/password) later.
 * Keep the exported function signatures; the UI only talks to this file.
 * Passwords are validated for format and then discarded: they are never stored or compared.
 * The directory holds only public/private profile fields (no credentials), persisted for the demo.
 */
import { LEADERBOARD } from './mock'

export interface AuthUser { id: string; username: string; email: string; verified: boolean }
export class AuthError extends Error { constructor(public field: 'username' | 'email' | 'password' | 'form', message: string) { super(message) } }

const DIR_KEY = 'conman.directory.v1'
const DEMO: AuthUser = { id: 'demo', username: 'ember_logic', email: 'demo@conman.app', verified: true }
export const DEMO_EMAIL = DEMO.email

const load = (): AuthUser[] => { try { return JSON.parse(localStorage.getItem(DIR_KEY) || '[]') } catch { return [] } }
const save = (d: AuthUser[]) => localStorage.setItem(DIR_KEY, JSON.stringify(d))
const all = () => [DEMO, ...load()]
const wait = (ms = 900) => new Promise((r) => setTimeout(r, ms))

export const validators = {
  username: (v: string) => (v.length < 3 || v.length > 20 ? 'Use 3–20 characters.' : !/^[a-zA-Z0-9_.]+$/.test(v) ? 'Letters, numbers, dots and underscores only.' : ''),
  email: (v: string) => (/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) ? '' : 'Enter a valid email address.'),
  password: (v: string) => (v.length < 8 ? 'Use at least 8 characters.' : ''),
}
export function passwordStrength(p: string) {
  let s = 0
  if (p.length >= 8) s++
  if (/[A-Z]/.test(p) && /[a-z]/.test(p)) s++
  if (/\d/.test(p)) s++
  if (/[^A-Za-z0-9]/.test(p) || p.length >= 14) s++
  return s
}

export async function checkUsername(username: string) {
  await wait(300)
  const u = username.toLowerCase()
  return !(LEADERBOARD.some((p) => p.name.toLowerCase() === u) || all().some((a) => a.username.toLowerCase() === u))
}

export async function signUp(i: { username: string; email: string; password: string }): Promise<AuthUser> {
  await wait()
  if (!(await checkUsername(i.username))) throw new AuthError('username', 'That username is already taken.')
  if (all().some((a) => a.email === i.email.toLowerCase())) throw new AuthError('email', 'An account with this email already exists.')
  const user: AuthUser = { id: crypto.randomUUID(), username: i.username, email: i.email.toLowerCase(), verified: false }
  save([...load(), user])
  return user
}

export async function signIn(email: string, _password: string): Promise<AuthUser> {
  await wait()
  const u = all().find((a) => a.email === email.toLowerCase())
  // Mock: any password is accepted for a known email. Supabase will do the real check.
  if (!u) throw new AuthError('form', 'Invalid email or password.')
  return u
}

export async function verifyEmail(email: string, valid = true): Promise<AuthUser> {
  await wait(700)
  if (!valid) throw new AuthError('form', 'This verification link is invalid or has expired.')
  const d = load(); const u = d.find((a) => a.email === email)
  if (!u) throw new AuthError('form', 'This verification link is invalid or has expired.')
  u.verified = true; save(d)
  return u
}
export async function resendVerification(_email: string) { await wait(700) }
export async function requestPasswordReset(_email: string) { await wait(900) /* always succeeds: never reveal whether an email exists */ }
export async function signOut() { await wait(150) }
