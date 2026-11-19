
import { supabase } from './supabase'

export interface AuthUser {
  id: string
  username: string
  email: string
  verified: boolean
}

export class AuthError extends Error {
  constructor(
    public field: 'username' | 'email' | 'password' | 'form',
    message: string
  ) {
    super(message)
  }
}

export const validators = {
  username: (v: string) =>
    v.length < 3 || v.length > 20
      ? 'Use 3–20 characters.'
      : !/^[a-zA-Z0-9_]+$/.test(v)
        ? 'Letters, numbers, and underscores only.'
        : '',

  email: (v: string) =>
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)
      ? ''
      : 'Enter a valid email address.',

  password: (v: string) =>
    v.length < 8 ? 'Use at least 8 characters.' : '',
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
  if (validators.username(username)) return false

  const { data, error } = await supabase
    .from('profiles')
    .select('id')
    .ilike('username', username.replace(/_/g, '\\_'))
    .limit(1)

  if (error) throw new AuthError('form', error.message)
  return data.length === 0
}

export async function signUp(i: {
  username: string
  email: string
  password: string
}): Promise<AuthUser> {
  const username = i.username.trim()
  const email = i.email.trim().toLowerCase()

  if (validators.username(username))
    throw new AuthError('username', validators.username(username))

  if (validators.email(email))
    throw new AuthError('email', validators.email(email))

  if (validators.password(i.password))
    throw new AuthError('password', validators.password(i.password))

  if (!(await checkUsername(username)))
    throw new AuthError('username', 'That username is already taken.')

  const { data, error } = await supabase.auth.signUp({
    email,
    password: i.password,
    options: {
      data: { username },
      emailRedirectTo: window.location.origin,
    },
  })

  if (error) {
    if (/username|duplicate|unique|database error/i.test(error.message))
      throw new AuthError('username', 'Username unavailable or registration failed.')

    throw new AuthError('form', error.message)
  }

  if (!data.user)
    throw new AuthError('form', 'Account creation failed.')

  return {
    id: data.user.id,
    username,
    email,
    verified: !!data.user.email_confirmed_at,
  }
}

export async function signIn(
  email: string,
  password: string
): Promise<AuthUser> {
  const { data, error } = await supabase.auth.signInWithPassword({
    email: email.trim().toLowerCase(),
    password,
  })

  if (error || !data.user)
    throw new AuthError('form', error?.message || 'Invalid login.')

  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', data.user.id)
    .single()

  if (profileError || !profile)
    throw new AuthError('form', 'Could not load your player profile.')

  return {
    id: data.user.id,
    username: profile.username,
    email: data.user.email || email,
    verified: !!data.user.email_confirmed_at,
  }
}

// Real verification happens through the emailed Supabase link.
// This only checks whether the current user is verified.
export async function verifyEmail(
  _email: string,
  _valid = true
): Promise<AuthUser> {
  const { data, error } = await supabase.auth.getUser()

  if (error || !data.user?.email_confirmed_at)
    throw new AuthError('form', 'Please verify your email using the link.')

  const { data: profile } = await supabase
    .from('profiles')
    .select('username')
    .eq('id', data.user.id)
    .single()

  if (!profile)
    throw new AuthError('form', 'Player profile not found.')

  return {
    id: data.user.id,
    username: profile.username,
    email: data.user.email || '',
    verified: true,
  }
}

export async function resendVerification(email: string) {
  const { error } = await supabase.auth.resend({
    type: 'signup',
    email,
    options: { emailRedirectTo: window.location.origin },
  })

  if (error) throw new AuthError('form', error.message)
}

export async function requestPasswordReset(email: string) {
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: window.location.origin,
  })

  if (error) throw new AuthError('form', error.message)
}

export async function signOut() {
  const { error } = await supabase.auth.signOut()
  if (error) throw new AuthError('form', error.message)
}
