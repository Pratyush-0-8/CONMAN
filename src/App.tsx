import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { useAnswerReceipt } from './lib/useAnswerReceipt'
import { Social } from './screens/Social'
import { Invitations } from './components/Social'
import { useSocial } from './lib/useSocial'
import { Nav, type Page } from './components/Nav'
import { Banner, Button, Dialog, Spinner } from './components/ui'
import { MatchDetailDialog } from './components/lists'
import { readNavigation, navigationPath, type Navigation } from './lib/navigation'
import { DailyFive } from './screens/DailyFive'
import { Home } from './screens/Home'
import { Matchmaking } from './screens/Matchmaking'
import { Arena } from './screens/Arena'
import { Judging } from './screens/Judging'
import { Results } from './screens/Results'
import { History, Leaderboard, Profile } from './screens/Pages'
import type { InputMode, MatchRecord, Opponent } from './lib/game'
import { cancelQueue, matchRecord, queueMatch, releaseMatch } from './lib/matchService'
import { requestMicrophone } from './lib/speech'
import { useRankedGame } from './lib/useRankedGame'
import { type AuthUser, signOut, verifyEmail } from './lib/auth'
import { Forgot, Landing, ResetSent, SignIn, SignUp, VerifyInvalid, VerifyPending, type AuthRoute } from './screens/Auth'
import { supabase } from './lib/supabase'

const PROTECTED: Page[] = ['history', 'profile', 'social']

export default function App() {
  const initialNavigation = useRef(readNavigation(window.location.pathname, window.history.state?.page))
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authReady, setAuthReady] = useState(false)
  const [route, setRoute] = useState<AuthRoute | 'app'>(initialNavigation.current.route)
  const [pending, setPending] = useState<AuthUser | null>(null)
  const [resetEmail, setResetEmail] = useState('')
  const [notice, setNotice] = useState('')
  const [page, setPage] = useState<Page>(initialNavigation.current.page)
  const [profileId, setProfileId] = useState(initialNavigation.current.profileId)
  const profileRef = useRef(profileId); profileRef.current = profileId
  const pageRef = useRef(page); pageRef.current = page
  const visit = useCallback((next: Navigation, replace = false) => {
    pageRef.current = next.page; setPage(next.page); setRoute(next.route); setProfileId(next.profileId); profileRef.current = next.profileId
    const path = navigationPath(next)
    if (window.location.pathname !== path) window.history[replace ? 'replaceState' : 'pushState'](next, '', path)
  }, [])
  useEffect(() => {
    const pop = () => { const next = readNavigation(window.location.pathname, window.history.state?.page); pageRef.current = next.page; setPage(next.page); setRoute(next.route); setProfileId(next.profileId); profileRef.current = next.profileId }
    window.addEventListener('popstate', pop)
    return () => window.removeEventListener('popstate', pop)
  }, [])
  useEffect(() => { if (user && route !== 'app') visit({ page,route:'app',profileId:profileRef.current },true) }, [user, route, page, visit])
  const [mode, setMode] = useState<InputMode>('voice')
  const [detail, setDetail] = useState<MatchRecord | null>(null)
  const [micPending, setMicPending] = useState(false)
  const [playError, setPlayError] = useState('')
  const permissionAttempt = useRef(0)
  const busy = useRef(false)
  const game = useRankedGame(user?.id)
  const { player, history, state } = game
  const match = state?.match
  const socialAvailable = !!user && !state?.queue && !match
  const social = useSocial(user?.id, socialAvailable, game.refresh)
  const openProfile = (id?: string) => visit({ page:'social', route:'app', profileId:id })
  const mine = match?.players.find((p) => p.player_id === user?.id)
  const receipt = useAnswerReceipt(`${match?.id}:${user?.id}`,mine?.answer_text,!!mine?.locked_at)
  const finalNotice = receipt && !receipt.confirmed && receipt.error && <div className="mx-auto max-w-4xl px-4 py-3"><Banner tone="error" title="Final answer not confirmed">{receipt.error}</Banner></div>
  const other = match?.players.find((p) => p.player_id !== user?.id)
  const [, renderClock] = useState(0)
  const clockOffset = state?.clockOffset || 0
  const now = Date.now() + clockOffset
  useEffect(() => {
    if (!match || match.state !== 'active') return
    const id = setInterval(() => renderClock((tick) => tick + 1), 50)
    return () => clearInterval(id)
  }, [clockOffset, match?.id, match?.state])
  useEffect(() => { window.scrollTo({ top: 0 }) }, [page, match?.id, match?.state])
  const enter = useCallback((u: AuthUser) => { setUser((previous) => previous?.id === u.id ? previous : u); setPending(null); setNotice(''); visit({ page:pageRef.current,route:'app',profileId:profileRef.current },true) }, [visit])
  const cancelMic = () => { permissionAttempt.current++; busy.current = false; setMicPending(false); setPlayError('') }
  useEffect(() => {
    let active = true, authVersion = 0
    const restore = async () => {
      const version = ++authVersion
      try {
        const { data: { user: authUser } } = await supabase.auth.getUser()
        if (!active || version !== authVersion || !authUser?.email_confirmed_at) return
        const { data: profile } = await supabase.from('profiles').select('username').eq('id', authUser.id).single()
        if (active && version === authVersion && profile) enter({ id: authUser.id, username: profile.username, email: authUser.email || '', verified: true })
      } catch { if (active && version === authVersion) setNotice('Could not restore your session. Please sign in again.') }
      finally { if (active && version === authVersion) setAuthReady(true) }
    }
    void restore()
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event) => {
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') setTimeout(() => { if (active) void restore() }, 0)
      if (event === 'SIGNED_OUT') { authVersion++; setAuthReady(true); permissionAttempt.current++; busy.current = false; setMicPending(false); setPlayError(''); setUser(null); visit({ page:'daily',route:'app' },true) }
    })
    return () => { active = false; permissionAttempt.current++; subscription.unsubscribe() }
  }, [enter, visit])
  const toAuth = (r: AuthRoute, n = '') => { setNotice(n); visit(r === 'landing' ? { page:'home',route:'app' } : { page:pageRef.current,route:r,profileId:profileRef.current }) }
  const go = (p: Page) => { cancelMic(); if (!user && PROTECTED.includes(p)) { setNotice('Sign in to continue.'); visit({ page:p,route:'signin' }); return }; visit({ page:p,route:'app' }) }
  const logout = async () => {
    cancelMic()
    try { await cancelQueue().catch(() => {}); await signOut(); setUser(null); visit({ page:'daily',route:'app' },true) }
    catch (error) { setPlayError(error instanceof Error ? error.message : 'Could not sign out. Retry.') }
  }
  const play = async () => {
    if (!user || !player) return toAuth('signin', 'Sign in to find a match.')
    if (busy.current || (match && match.state !== 'complete')) return
    busy.current = true
    const attempt = ++permissionAttempt.current
    setPlayError(''); setMicPending(true)
    try {
      if (mode === 'voice') await requestMicrophone()
      if (attempt !== permissionAttempt.current) return
      if (match?.state === 'complete') await releaseMatch(match.id)
      await queueMatch(mode, true)
      if (attempt !== permissionAttempt.current) { await cancelQueue(); return }
      await game.refresh()
    } catch (error) { if (attempt === permissionAttempt.current) setPlayError(error instanceof Error ? error.message : 'Could not join matchmaking. Retry.') }
    finally { if (attempt === permissionAttempt.current) { busy.current = false; setMicPending(false) } }
  }
  const home = async () => {
    try { if (match?.state === 'complete') await releaseMatch(match.id); await cancelQueue(); await game.refresh(); visit({ page:'home',route:'app' }) }
    catch (error) { setPlayError(error instanceof Error ? error.message : 'Could not leave matchmaking. Retry.') }
  }
  const withFeedback = (content: ReactNode) => <>{content}{finalNotice}{user && !match && !state?.queue && (page !== 'social' || profileId) && <aside aria-label="Challenge invitations" className="fixed bottom-24 right-3 z-50 max-h-[65vh] w-[calc(100%-1.5rem)] max-w-sm overflow-auto lg:bottom-6"><Invitations compact invitations={social.invitations} userId={user.id} now={social.now} available={socialAvailable} onUpdate={async () => { await social.refresh(); await game.refresh() }} /></aside>}<Dialog open={micPending || !!playError} onClose={cancelMic} title="Find match"><div className="pr-8"><h2 className="mb-4 text-xl font-semibold">{mode === 'voice' ? 'Microphone access' : 'Find match'}</h2>{micPending ? <div role="status" className="flex items-center gap-3 text-sm text-mute"><Spinner />{mode === 'voice' ? 'Allow microphone access to find a match.' : 'Joining the ranked queue…'}</div> : <Banner tone="error" title="Could not continue" action={<Button size="sm" onClick={play}>Retry</Button>}>{playError}</Banner>}</div></Dialog></>
  const connection = game.error && <div className="mx-auto max-w-4xl px-4 py-3"><Banner tone="error" title="Connection interrupted" action={<Button size="sm" onClick={() => { void game.reloadAccount(); void game.refresh() }}>Retry</Button>}>{game.error}</Banner></div>

  // Public Daily Five is available immediately, independent of auth restoration/profile loading.
  if (page === 'daily' && route === 'app' && !match && !state?.queue) return withFeedback(<div className="min-h-screen"><Nav page="daily" go={go} player={player} email={user?.email} onPlay={play} onSignOut={logout} onSignIn={() => toAuth('signin')} onSignUp={() => toAuth('signup')} onLanding={() => go('daily')} /><DailyFive /></div>)

  if (player && user && match && mine && other) {
    const opp: Opponent = { name: other.username, elo: other.elo ?? other.elo_before ?? 500, wins: other.wins || 0, losses: other.losses || 0, mode: other.input_mode }
    if (match.state === 'complete') return withFeedback(<Results key={match.id} m={matchRecord(match, user.id)} me={player.name} onAgain={play} onHome={home} />)
    if (match.state !== 'active') return <>{connection}{finalNotice}<Judging player={player} opp={opp} question={match.question} myText={mine.answer_text || ''} oppText={other.answer_text || ''} error={match.judge_error || game.judgeError} retryAt={match.judge_retry_at} onRetry={() => { void game.judge(match.id) }} /></>
    if (now < Date.parse(match.round_start)) return <>{connection}<Matchmaking player={player} opp={opp} joinedAt={match.round_start} clockOffset={clockOffset} onCancel={home} /></>
    return <>{connection}<Arena key={match.id} player={player} opp={opp} match={match} mine={mine} now={now} onRefresh={game.refresh} /></>
  }
  if (player && state?.queue) return withFeedback(<>{connection}<Matchmaking player={player} opp={null} joinedAt={state.queue.joined_at} clockOffset={clockOffset} onCancel={home} /></>)

  if (!user) {
    const shell = (content: ReactNode) => <div className="min-h-screen"><Nav page={page} go={go} player={null} onPlay={play} onSignOut={logout} onSignIn={() => toAuth('signin')} onSignUp={() => toAuth('signup')} onLanding={() => go('daily')} />{content}</div>
    if (route === 'app' && page === 'social' && profileId) return shell(<Social userId={undefined} profileId={profileId} openProfile={openProfile} social={social} available={false} onMatch={game.refresh} />)
    if (route === 'app' && page === 'leaderboard') return shell(<Leaderboard player={null} />)
    if (!authReady) return shell(<div className="grid min-h-[60vh] place-items-center"><Spinner size={32} /></div>)
    if ((route === 'app' && page === 'home') || route === 'landing') return shell(<Landing showHeader={false} go={toAuth} onLeaderboard={() => go('leaderboard')} />)
    const r = route === 'app' ? 'signin' : route
    if (r === 'signup') return shell(<SignUp go={toAuth} onCreated={(u) => { setPending(u); toAuth('verify') }} />)
    if (r === 'signin') return shell(<SignIn go={toAuth} notice={notice} onSignedIn={enter} onUnverified={(u) => { setPending(u); toAuth('verify') }} />)
    if (r === 'forgot') return shell(<Forgot go={toAuth} onSent={(email) => { setResetEmail(email); toAuth('reset-sent') }} />)
    if (r === 'reset-sent') return shell(<ResetSent email={resetEmail} go={toAuth} />)
    if (r === 'verify' && pending) return shell(<VerifyPending email={pending.email} go={toAuth} onVerified={async () => enter(await verifyEmail(pending.email))} onExpired={() => toAuth('verify-invalid')} />)
    if (r === 'verify-invalid') return shell(<VerifyInvalid go={toAuth} />)
    return shell(<SignIn go={toAuth} onSignedIn={enter} onUnverified={(u) => { setPending(u); toAuth('verify') }} />)
  }
  if (!player) return <div className="grid min-h-screen place-items-center"><div className="max-w-lg p-6">{connection || <Spinner size={32} />}<Button className="mt-4" onClick={logout}>Sign out</Button></div></div>
  return withFeedback(<div className="min-h-screen">
    <Nav page={page} go={go} player={player} email={user.email} onPlay={play} onSignOut={logout} onSignIn={() => {}} onSignUp={() => {}} onLanding={() => {}} />
    {connection}
    <div key={page} className="animate-fade-in">
      {page === 'social' && <Social userId={user.id} profileId={profileId} openProfile={openProfile} social={social} available={socialAvailable} onMatch={game.refresh} />}
      {page === 'home' && <Home player={player} history={history} mode={mode} setMode={setMode} onPlay={play} go={go} openMatch={setDetail} />}
      {page === 'leaderboard' && <Leaderboard player={player} />}
      {page === 'history' && <History history={history} player={player} open={setDetail} />}
      {page === 'profile' && <Profile player={player} history={history} open={setDetail} onPlay={play} />}
    </div>
    <MatchDetailDialog m={detail} me={player.name} onClose={() => setDetail(null)} />
  </div>)
}
