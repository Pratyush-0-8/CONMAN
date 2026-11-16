import { useCallback, useEffect, useRef, useState } from 'react'
import { Nav, type Page } from './components/Nav'
import { Button } from './components/ui'
import { MatchDetailDialog } from './components/lists'
import { Home, type OutcomePref } from './screens/Home'
import { Matchmaking } from './screens/Matchmaking'
import { Arena } from './screens/Arena'
import { Judging } from './screens/Judging'
import { Results } from './screens/Results'
import { History, Leaderboard, Profile } from './screens/Pages'
import { type MatchRecord, type Opponent, type PlayerStats, START_ELO, eloDelta, genScores, pickOutcome } from './lib/game'
import { QUESTIONS, demoSeed, makeOpponent } from './lib/mock'
import { type AuthUser, signOut, verifyEmail } from './lib/auth'
import { Forgot, Landing, ResetSent, SignIn, SignUp, VerifyInvalid, VerifyPending, type AuthRoute } from './screens/Auth'

type Stage = 'idle' | 'search' | 'arena' | 'judging' | 'results'
// Per-user gameplay data (stats + history). No credentials are ever stored here.
const PROFILES = 'conman.profiles.v1'
const readProfiles = (): Record<string, { player: PlayerStats; history: MatchRecord[] }> => { try { return JSON.parse(localStorage.getItem(PROFILES) || '{}') } catch { return {} } }
const PROTECTED: Page[] = ['home', 'history', 'profile']

export default function App() {
  // Session lives in memory only; Supabase Auth will restore it across refreshes.
  const [user, setUser] = useState<AuthUser | null>(null)
  const [route, setRoute] = useState<AuthRoute | 'app'>('landing')
  const [pending, setPending] = useState<AuthUser | null>(null)
  const [resetEmail, setResetEmail] = useState('')
  const [notice, setNotice] = useState('')
  const [player, setPlayer] = useState<PlayerStats | null>(null)
  const [history, setHistory] = useState<MatchRecord[]>([])
  const [page, setPage] = useState<Page>('home')
  const [stage, setStage] = useState<Stage>('idle')
  const [pref, setPref] = useState<OutcomePref>('random')
  const [opp, setOpp] = useState<Opponent | null>(null)
  const [qi, setQi] = useState(0)
  const [result, setResult] = useState<MatchRecord | null>(null)
  const [detail, setDetail] = useState<MatchRecord | null>(null)
  const myText = useRef('')

  useEffect(() => {
    if (!user || !player) return
    localStorage.setItem(PROFILES, JSON.stringify({ ...readProfiles(), [user.id]: { player, history } }))
  }, [user, player, history])
  useEffect(() => { window.scrollTo({ top: 0 }) }, [page, stage])

  // Single shared profile: the username always comes from the signed-in account.
  const enter = (u: AuthUser) => {
    const saved = readProfiles()[u.id]
    if (saved) { setPlayer({ ...saved.player, name: u.username }); setHistory(saved.history) }
    else if (u.id === 'demo') { const s = demoSeed(); setPlayer({ ...s.player, name: u.username }); setHistory(s.history) }
    else { setPlayer({ name: u.username, elo: START_ELO, wins: 0, losses: 0, draws: 0 }); setHistory([]) }
    setUser(u); setPending(null); setNotice(''); setPage('home'); setRoute('app')
  }
  const logout = async () => { await signOut(); setUser(null); setPlayer(null); setHistory([]); setStage('idle'); setPage('home'); setRoute('landing') }
  const toAuth = (r: AuthRoute, n = '') => { setNotice(n); setRoute(r) }
  const demo = () => { if (!user) return; const s = demoSeed(); setPlayer({ ...s.player, name: user.username }); setHistory(s.history) }
  const go = (p: Page) => { if (!user && PROTECTED.includes(p)) return toAuth('signin', 'Sign in to continue.'); setPage(p); setRoute('app') }
  const play = () => {
    if (!user || !player) return toAuth('signin', 'Sign in to find a match.')
    setOpp(makeOpponent(player.elo)); setQi((q) => (q + 1 + Math.floor(Math.random() * (QUESTIONS.length - 1))) % QUESTIONS.length)
    setStage('search')
  }
  const home = () => { setStage('idle'); setPage('home') }
  const cb = { go: toAuth }

  const finishSpeaking = (text: string) => {
    if (!player || !opp) return
    const outcome = pickOutcome(pref)
    const delta = eloDelta(player.elo, opp.elo, outcome)
    const g = genScores(outcome)
    const q = QUESTIONS[qi]
    myText.current = text || 'No speech detected.'
    const rec: MatchRecord = { id: String(Date.now()), opponent: opp.name, opponentElo: opp.elo, outcome, delta, eloBefore: player.elo, eloAfter: player.elo + delta, at: Date.now(), question: q.q, myText: myText.current, oppText: q.theirs, ...g }
    setResult(rec); setHistory((h) => [rec, ...h])
    setPlayer({ ...player, elo: rec.eloAfter, wins: player.wins + +(outcome === 'win'), losses: player.losses + +(outcome === 'loss'), draws: player.draws + +(outcome === 'draw') })
    setStage('judging')
  }
  const judged = useCallback(() => setStage('results'), [])

  if (player && opp) {
    if (stage === 'search') return <Matchmaking key={opp.name + qi} player={player} opp={opp} onCancel={home} onReady={() => setStage('arena')} />
    if (stage === 'arena') return <Arena player={player} opp={opp} question={QUESTIONS[qi].q} sample={QUESTIONS[qi].mine} onDone={finishSpeaking} />
    if (stage === 'judging' && result) return <Judging player={player} opp={opp} question={result.question} myText={result.myText} oppText={result.oppText} onDone={judged} />
    if (stage === 'results' && result) return <Results m={result} me={player.name} onAgain={play} onHome={home} />
  }

  // Route guard: unauthenticated users only reach landing, auth screens and the public leaderboard.
  if (!user || !player) {
    if (route === 'app' && page === 'leaderboard') {
      return (
        <div className="min-h-screen">
          <Nav page="leaderboard" go={go} player={null} onPlay={play} onSignOut={logout} onSignIn={() => toAuth('signin')} onSignUp={() => toAuth('signup')} onLanding={() => toAuth('landing')} />
          <Leaderboard player={null} />
          <div className="mx-auto max-w-4xl px-4 pb-16 sm:px-6"><div className="flex flex-col items-center justify-between gap-4 rounded-2xl border border-accent/30 bg-accent/[0.07] p-6 sm:flex-row"><div><div className="font-semibold">Think you can climb this ladder?</div><div className="text-sm text-mute">Create an account to start at 500 ELO.</div></div><Button variant="primary" onClick={() => toAuth('signup')}>Create Account</Button></div></div>
        </div>
      )
    }
    const r = route === 'app' ? 'signin' : route
    if (r === 'signup') return <SignUp go={cb.go} onCreated={(u) => { setPending(u); toAuth('verify') }} />
    if (r === 'signin') return <SignIn go={cb.go} notice={notice || (route === 'app' ? 'Sign in to continue.' : '')} onSignedIn={enter} onUnverified={(u) => { setPending(u); toAuth('verify') }} />
    if (r === 'forgot') return <Forgot go={cb.go} onSent={(e) => { setResetEmail(e); toAuth('reset-sent') }} />
    if (r === 'reset-sent') return <ResetSent email={resetEmail} go={cb.go} />
    if (r === 'verify') return pending ? <VerifyPending email={pending.email} go={cb.go} onVerified={async () => enter(await verifyEmail(pending.email))} onExpired={() => toAuth('verify-invalid')} /> : <SignIn go={cb.go} onSignedIn={enter} onUnverified={(u) => { setPending(u); toAuth('verify') }} />
    if (r === 'verify-invalid') return <VerifyInvalid go={cb.go} />
    return <Landing go={cb.go} onLeaderboard={() => { setPage('leaderboard'); setRoute('app') }} />
  }

  return (
    <div className="min-h-screen">
      <Nav page={page} go={go} player={player} email={user.email} onPlay={play} onSignOut={logout} onSignIn={() => {}} onSignUp={() => {}} onLanding={() => {}} />
      <div key={page} className="animate-fade-in">
        {page === 'home' && <Home player={player} history={history} pref={pref} setPref={setPref} onDemo={demo} onPlay={play} go={go} openMatch={setDetail} />}
        {page === 'leaderboard' && <Leaderboard player={player} />}
        {page === 'history' && <History history={history} player={player} open={setDetail} />}
        {page === 'profile' && <Profile player={player} history={history} open={setDetail} onPlay={play} />}
      </div>
      <MatchDetailDialog m={detail} me={player.name} onClose={() => setDetail(null)} />
    </div>
  )
}
