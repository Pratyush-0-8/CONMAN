import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { Nav, type Page } from './components/Nav'
import { Banner, Button, Dialog, Spinner } from './components/ui'
import { MatchDetailDialog } from './components/lists'
import { Home, type OutcomePref } from './screens/Home'
import { Matchmaking } from './screens/Matchmaking'
import { Arena } from './screens/Arena'
import { Judging } from './screens/Judging'
import { Results } from './screens/Results'
import { History, Leaderboard, Profile } from './screens/Pages'
import { type MatchRecord, type Opponent, type PlayerStats, START_ELO } from './lib/game'
import { QUESTIONS, demoSeed } from './lib/mock'
import {
  findMatch,
  loadProfile,
  loadSupabaseProfile,
  saveProfile,
  submitMatch
} from './lib/matchService'
import { requestMicrophone } from './lib/speech'
import { type AuthUser, signOut, verifyEmail } from './lib/auth'
import { Forgot, Landing, ResetSent, SignIn, SignUp, VerifyInvalid, VerifyPending, type AuthRoute } from './screens/Auth'
import { supabase } from './lib/supabase'
import { judgeAnswer } from "./lib/localJudge";

type Stage = 'idle' | 'search' | 'arena' | 'judging' | 'results'
// Per-user gameplay data (stats + history). No credentials are ever stored here.
const PROTECTED: Page[] = ['home', 'history', 'profile']

export default function App() {
  // Session lives in memory only; Supabase Auth will restore it across refreshes.
  async function testJudge() {
    const { data, error } = await supabase.functions.invoke('clever-action', {
      body: {
        question: "Should robots have the same rights as humans?",
        player1Answer: "Robots should have rights because robots are cool and they're probably going to take over anyway.",
        player2Answer: "Rights should depend on the capacity to experience harm, not whether something is biological. If a robot could genuinely suffer, denying it protection would be difficult to justify.",
      },
    })

    console.log('Judge result:', data)
    console.log('Judge error:', error)
  }

  async function testLocalJudge() {
    try {
      console.log("Loading local AI judge...");

      const start = performance.now();

      const score = await judgeAnswer(
        "Should robots have the same rights as humans?",
        "Robots should have rights if they're conscious, because suffering gives us a moral reason to protect them."
      );

      const seconds = ((performance.now() - start) / 1000).toFixed(1);

      alert(`AI Score: ${score}/50\nTime: ${seconds} seconds`);
    } catch (error) {
      console.error("Local judge failed:", error);
      alert(`AI error: ${String(error)}`);
    }
  }
  
  const [user, setUser] = useState<AuthUser | null>(null)
  const [route, setRoute] = useState<AuthRoute | 'app'>('landing')
  const [pending, setPending] = useState<AuthUser | null>(null)
  const [resetEmail, setResetEmail] = useState('')
  const [notice, setNotice] = useState('')
  const [player, setPlayer] = useState<PlayerStats | null>(null)
  const [history, setHistory] = useState<MatchRecord[]>([])
  const [page, setPage] = useState<Page>('home')
  const [stage, setStageState] = useState<Stage>('idle')
  const stageRef = useRef<Stage>('idle')
  const setStage = useCallback((next: Stage) => { stageRef.current = next; setStageState(next) }, [])
  const [pref, setPref] = useState<OutcomePref>('random')
  const [opp, setOpp] = useState<Opponent | null>(null)
  const [qi, setQi] = useState(0)
  const [result, setResult] = useState<MatchRecord | null>(null)
  const [detail, setDetail] = useState<MatchRecord | null>(null)
  const [micPending, setMicPending] = useState(false)
  const [micError, setMicError] = useState('')
  const permissionAttempt = useRef(0)
  const requestingMic = useRef(false)
  const activeMatch = useRef<ReturnType<typeof findMatch> | null>(null)
  const submitted = useRef(false)

  useEffect(() => {
    if (!user || !player) return
    saveProfile(user.id, { player, history })
  }, [user, player, history])
  useEffect(() => { window.scrollTo({ top: 0 }) }, [page, stage])
  useEffect(() => () => { permissionAttempt.current++ }, [])

  const cancelMic = () => { permissionAttempt.current++; requestingMic.current = false; setMicPending(false); setMicError('') }

  // Single shared profile: the username always comes from the signed-in account.
  
const enter = async (u: AuthUser) => {
  try {
    const profile = await loadSupabaseProfile(u.id)

    setPlayer(profile)
    setHistory([])
    setUser(u)
    setPending(null)
    setNotice('')
    setPage('home')
    setRoute('app')
  } catch (error) {
    console.error('Failed to load Supabase profile:', error)
    setNotice('Could not load your player profile. Please try signing in again.')
    setRoute('signin')
  }
}


  // Restore Supabase login after refresh or email verification.
  useEffect(() => {
    let active = true

    async function restoreUser() {
      const { data: { user: authUser } } =
        await supabase.auth.getUser()

      if (!active || !authUser || !authUser.email_confirmed_at) return

      const { data: profile, error } = await supabase
        .from('profiles')
        .select('username')
        .eq('id', authUser.id)
        .single()

      if (!active || error || !profile) return

      enter({
        id: authUser.id,
        username: profile.username,
        email: authUser.email || '',
        verified: true,
      })
    }

    const { data: { subscription } } =
      supabase.auth.onAuthStateChange((event) => {
        if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION') {
          // Defer Supabase requests outside the auth callback.
          setTimeout(() => { void restoreUser() }, 0)
        }

        if (event === 'SIGNED_OUT') {
          setUser(null)
          setPlayer(null)
          setHistory([])
          setStage('idle')
          setRoute('landing')
        }
      })

    return () => {
      active = false
      subscription.unsubscribe()
    }
  }, [])

  const logout = async () => { cancelMic(); activeMatch.current = null; setStage('idle'); await signOut(); setUser(null); setPlayer(null); setHistory([]); setPage('home'); setRoute('landing') }
  const toAuth = (r: AuthRoute, n = '') => { setNotice(n); setRoute(r) }
  const demo = () => { if (!user) return; const s = demoSeed(); setPlayer({ ...s.player, name: user.username }); setHistory(s.history) }
  const go = (p: Page) => { cancelMic(); if (!user && PROTECTED.includes(p)) return toAuth('signin', 'Sign in to continue.'); setPage(p); setRoute('app') }
  const play = async () => {
    if (!user || !player) return toAuth('signin', 'Sign in to find a match.')
    if (requestingMic.current || (stageRef.current !== 'idle' && stageRef.current !== 'results')) return
    requestingMic.current = true
    const attempt = ++permissionAttempt.current
    setMicError(''); setMicPending(true)
    try {
      await requestMicrophone()
      if (attempt !== permissionAttempt.current) return
      const match = findMatch(player.elo, qi)
      activeMatch.current = match; submitted.current = false
      setResult(null); setOpp(match.opponent); setQi(match.questionIndex)
      setStage('search')
    } catch (error) {
      if (attempt === permissionAttempt.current) setMicError(error instanceof Error ? error.message : 'Could not access your microphone. Check your settings, then retry.')
    } finally {
      if (attempt === permissionAttempt.current) { requestingMic.current = false; setMicPending(false) }
    }
  }
  const home = () => { cancelMic(); activeMatch.current = null; setStage('idle'); setPage('home') }
  const cb = { go: toAuth }
  const matchId = activeMatch.current?.id

  const finishSpeaking = (text: string) => {
    if (!player || !activeMatch.current || activeMatch.current.id !== matchId || stageRef.current !== 'arena' || submitted.current) return
    submitted.current = true
    const rec = submitMatch({ ...activeMatch.current, player, text, pref })
    setResult(rec); setHistory((h) => h.some((m) => m.id === rec.id) ? h : [rec, ...h])
    setPlayer((p) => p ? { ...p, elo: rec.eloAfter, wins: p.wins + +(rec.outcome === 'win'), losses: p.losses + +(rec.outcome === 'loss'), draws: p.draws + +(rec.outcome === 'draw') } : p)
    setStage('judging')
  }
  const judged = useCallback(() => { if (stageRef.current === 'judging') setStage('results') }, [setStage])
  const withMicFeedback = (content: ReactNode) => (
    <>
      {content}
      <Dialog open={micPending || !!micError} onClose={cancelMic} title="Microphone access">
        <div className="pr-8">
          <h2 className="mb-4 text-xl font-semibold">Microphone access</h2>
          {micPending ? <div role="status" className="flex items-center gap-3 text-sm text-mute"><Spinner />Allow microphone access in your browser to find a match.</div> : <Banner tone="error" title="Microphone required" action={<Button size="sm" onClick={play}>Retry</Button>}>{micError}</Banner>}
        </div>
      </Dialog>
    </>
  )

  if (player && opp) {
    if (stage === 'search') return <Matchmaking key={matchId} player={player} opp={opp} onCancel={home} onReady={() => { if (stageRef.current === 'search' && activeMatch.current?.id === matchId) setStage('arena') }} />
    if (stage === 'arena') return <Arena player={player} opp={opp} question={QUESTIONS[qi].q} onDone={finishSpeaking} />
    if (stage === 'judging' && result) return <Judging player={player} opp={opp} question={result.question} myText={result.myText} oppText={result.oppText} onDone={judged} />
    if (stage === 'results' && result) return withMicFeedback(<Results m={result} me={player.name} onAgain={play} onHome={home} />)
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
    if (r === 'verify')
  return pending
    ? <VerifyPending
        email={pending.email}
        go={cb.go}
        onVerified={async () => {}}
        onExpired={() => toAuth('verify-invalid')}
      />
    : <SignIn
        go={cb.go}
        onSignedIn={enter}
        onUnverified={(u) => {
          setPending(u)
          toAuth('verify')
        }}
      />
    if (r === 'verify-invalid') return <VerifyInvalid go={cb.go} />
    return <Landing go={cb.go} onLeaderboard={() => { setPage('leaderboard'); setRoute('app') }} />
  }

  return withMicFeedback(
    <div className="min-h-screen">
      <button
        onClick={testJudge}
        className="fixed bottom-5 right-5 z-50 rounded-lg bg-blue-600 px-4 py-2 text-white"
      >
        Test Gemini Judge
      </button>
      <button
        onClick={testLocalJudge}
        style={{
          position: "fixed",
          bottom: 80,
          right: 20,
          zIndex: 9999,
          padding: "12px 20px",
          background: "#2563eb",
          color: "white",
          borderRadius: 8,
          cursor: "pointer",
        }}
      >
        Test Local Judge
      </button>
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
