import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Button, Card, Eyebrow, Icon, Spinner } from '../components/ui'
import { CountdownRing, LinearTimer, PromptCard } from '../components/game'
import { AppendInput, VoiceInput } from './Arena'
import { CATS, type InputMode } from '../lib/game'
import { populationCurve, scorePosition, strictlyBelowPercent } from '../lib/population'
import { copyDailyResult } from '../lib/dailyRules'
import { dailyRequest, prepareDailySession, readDailySession, storeDailySession, type DailyAttempt, type DailyDistribution, type DailyRound as Round, type DailySession, type DailyToday } from '../lib/dailyService'
import { requestMicrophone } from '../lib/speech'

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined,{ timeZone:'America/New_York',month:'long',day:'numeric',year:'numeric' })

function DailyInput({ round, mode, now, onSave, onSubmit }: { round: Round; mode: InputMode; now: number; onSave: (text: string) => Promise<void>; onSubmit: (text: string) => Promise<void> }) {
  const [text,setText]=useState(round.answer_text || ''), [error,setError]=useState(''), [done,setDone]=useState(false)
  const [startedBeforeDeadline]=useState(now<Date.parse(round.deadline!))
  const latest=useRef(text); latest.current=text
  const serial=useRef<Promise<void>>(Promise.resolve()), saving=useRef(false), finalized=useRef(false), alive=useRef(false), auto=useRef(false), saved=useRef(text)
  const saveRef=useRef(onSave); saveRef.current=onSave
  const submitRef=useRef(onSubmit); submitRef.current=onSubmit
  useEffect(() => { alive.current=true; return () => { alive.current=false } },[])
  const start=Date.parse(round.started_at!),deadline=Date.parse(round.deadline!),thinking=now<start+5000,left=Math.max(0,deadline-now)
  const submit=useCallback(async (value: string) => {
    if (finalized.current) return
    finalized.current=true; setError('')
    const pending=serial.current.catch(() => {}).then(() => submitRef.current(value))
    serial.current=pending
    try { await pending; if (alive.current) setDone(true) }
    catch (error) { finalized.current=false; if (alive.current) setError(error instanceof Error ? error.message : 'Could not submit your answer. Retry.') }
  },[])
  useEffect(() => {
    if (thinking || left===0 || done) return
    const id=setInterval(() => {
      if (saving.current || finalized.current || saved.current===latest.current) return
      const value=latest.current; saving.current=true
      const pending=serial.current.catch(() => {}).then(() => saveRef.current(value))
      serial.current=pending
      void pending.then(() => { saved.current=value }).catch((error) => { if (alive.current) setError(error instanceof Error ? error.message : 'Draft not synced.') }).finally(() => { saving.current=false })
    },250)
    return () => clearInterval(id)
  },[thinking,left===0,done])
  useEffect(() => { if (!thinking && left===0 && mode==='typing' && !auto.current) { auto.current=true; void submit(latest.current) } },[thinking,left,mode,submit])
  const waiting=done || (left===0 && (mode==='typing' || !startedBeforeDeadline))
  if (now<start) return <div role="status" className="flex items-center justify-center gap-3 py-10 text-mute"><Spinner />Getting your question ready…</div>
  return <div className="space-y-5">
    {error && <Banner tone="error" title="Your answer is not synced" action={<Button size="sm" onClick={() => { void submit(latest.current) }}>Retry</Button>}>{error}</Banner>}
    {thinking ? <div className="flex flex-col items-center gap-5"><CountdownRing left={Math.min(5000,Math.max(0,start+5000-now))} total={5} label="THINK" color="#638BFF" size={208} /><p className="text-sm text-mute">Five seconds to think. Then make your case.</p></div>
      : waiting ? <div role="status" className="flex flex-col items-center gap-4 py-10"><Spinner size={28} /><p className="text-mute">Saving your answer…</p></div>
      : mode==='voice' ? <VoiceInput initial={text} left={left} onText={setText} onFinish={(value) => { latest.current=value; setText(value); void submit(value) }} />
      : <div className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center"><CountdownRing left={left} total={20} label="TYPE" color="#F07878" size={190} /><div className="space-y-4"><AppendInput text={text} onChange={setText} disabled={finalized.current || left===0} /><LinearTimer left={left} total={20} color="#F07878" /><Button onClick={() => { void submit(text) }} disabled={finalized.current}>Submit answer</Button></div></div>}
  </div>
}

export function Population({ population, score }: { population: DailyDistribution; score: number }) {
  const curve=populationCurve(population.bins,population.count)
  const comparison=strictlyBelowPercent(population.count,population.below_count)
  const x=scorePosition(score)
  return <Card className="p-5 sm:p-7">
    <Eyebrow>Population distribution</Eyebrow>
    {!curve ? <p role="status" className="py-12 text-center text-lg text-mute">Not enough players to compare yet.</p> : <>
      <svg viewBox="0 0 700 240" role="img" aria-label={`Smoothed distribution of ${population.count} completed attempts. Your score is ${score}.`} className="mt-5 w-full">
        <defs><linearGradient id="daily-population-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#638BFF" stopOpacity="0.3" /><stop offset="100%" stopColor="#638BFF" stopOpacity="0.02" /></linearGradient></defs>
        <path d={curve.area} fill="url(#daily-population-fill)" />
        <path d={curve.line} fill="none" stroke="#638BFF" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        <line x1="38" x2="662" y1="185" y2="185" stroke="#38405a" />
        <line x1={x} x2={x} y1="28" y2="190" stroke="#38C994" strokeWidth="2" strokeDasharray="5 4" />
        <text x={Math.min(620,Math.max(80,x))} y="20" textAnchor="middle" fill="#38C994" fontSize="15">You · {score}</text>
        {[0,50,100,150,200,250].map((value) => <text key={value} x={scorePosition(value)} y="215" textAnchor="middle" fill="#9299A8" fontSize="14">{value}</text>)}
      </svg>
      {comparison===null ? <p role="status" className="text-center text-mute">Population comparison is temporarily unavailable.</p> : <p className="text-center text-2xl font-semibold text-win sm:text-3xl">Better than {comparison}% of players</p>}
    </>}
  </Card>
}

export function DailyFive() {
  const [today,setToday]=useState<DailyToday | null>(null),[attempt,setAttempt]=useState<DailyAttempt | null>(null),[session,setSession]=useState<DailySession | null>(null)
  const [mode,setMode]=useState<InputMode>('typing'),[loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[judgeError,setJudgeError]=useState('')
  const [showFinal,setShowFinal]=useState(false),[population,setPopulation]=useState<DailyDistribution | null>(null),[copied,setCopied]=useState(false)
  const [,tick]=useState(0)
  const mounted=useRef(false),operation=useRef(false),grading=useRef(false)
  const now=Date.now()+(attempt?.clockOffset || 0),round=attempt?.rounds.find((r) => r.position===attempt.position)
  const install=useCallback((next: DailyAttempt) => setAttempt((previous) => previous && previous.id===next.id && Date.parse(previous.server_now)>Date.parse(next.server_now) ? previous : next),[])
  const restore=useCallback(async () => {
    setLoading(true); setError(''); setPopulation(null)
    try {
      const current=await dailyRequest<DailyToday>('today')
      const active=await readDailySession()
      let stored=active
      if (stored?.token) {
        const recovered=await dailyRequest<DailyAttempt>('state',{},stored.token)
        if (recovered.date===current.date || recovered.status!=='complete') {
          if (mounted.current) { setToday(current); setSession(stored); install(recovered); setShowFinal(recovered.status==='complete'); setMode(recovered.mode) }
          return
        }
      }
      stored=await readDailySession(current.date)
      if (mounted.current) { setToday(current); setSession(stored || null); setMode(stored?.mode || 'typing'); setAttempt(null); setShowFinal(false) }
      if (stored?.token) {
        const recovered=await dailyRequest<DailyAttempt>('state',{},stored.token)
        if (mounted.current) { install(recovered); setShowFinal(recovered.status==='complete') }
      }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not load Daily Five.') }
    finally { if (mounted.current) setLoading(false) }
  },[install])
  useEffect(() => { mounted.current=true; void restore(); return () => { mounted.current=false } },[restore])
  const refresh=useCallback(async () => {
    if (!session?.token) return
    const next=await dailyRequest<DailyAttempt>('state',{},session.token)
    if (mounted.current) { install(next); setError('') }
  },[session?.token,install])
  useEffect(() => {
    if (!attempt || attempt.status==='complete') return
    let polling=false
    const update=() => { if (polling) return; polling=true; void refresh().catch((error) => { if (mounted.current) setError(error.message) }).finally(() => { polling=false }) }
    const interval=setInterval(update,2000),clock=setInterval(() => tick((n) => n+1),50)
    window.addEventListener('online',update); window.addEventListener('focus',update); document.addEventListener('visibilitychange',update)
    return () => { clearInterval(interval); clearInterval(clock); window.removeEventListener('online',update); window.removeEventListener('focus',update); document.removeEventListener('visibilitychange',update) }
  },[attempt?.id,attempt?.status,refresh])
  const start=async () => {
    if (!today || operation.current) return
    operation.current=true; setBusy(true); setError(''); setPopulation(null)
    try {
      const stored=await prepareDailySession(today.date,mode)
      if (stored.mode==='voice') await requestMicrophone()
      const result=await dailyRequest<DailyAttempt & { token: string }>('start',{ creationKey:stored.creationKey,date:today.date,mode:stored.mode })
      const credential={ ...stored,token:result.token }
      await storeDailySession(credential)
      if (mounted.current) { setSession(credential); install(result); setShowFinal(result.status==='complete') }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not start Daily Five.') }
    finally { operation.current=false; if (mounted.current) setBusy(false) }
  }
  const grade=useCallback(async () => {
    if (!session?.token || !attempt || grading.current) return
    grading.current=true; setJudgeError('')
    try { await dailyRequest('judge',{ position:attempt.position },session.token) }
    catch (error) { if (mounted.current) setJudgeError(error instanceof Error ? error.message : 'Judging failed; retry to continue.') }
    finally { grading.current=false; if (mounted.current) await refresh().catch((error) => setError(error.message)) }
  },[session?.token,attempt?.id,attempt?.position,refresh])
  useEffect(() => { if (round?.state==='locked') void grade() },[attempt?.id,attempt?.position,round?.state,grade])
  useEffect(() => { if (round?.state==='judging' && (round.judge_attempts || 0)<3 && round.judge_lease_until && now>Date.parse(round.judge_lease_until)) void grade() },[now,round?.state,round?.judge_lease_until,grade])
  const answer=useCallback(async (text: string,final: boolean) => {
    if (!session?.token || !attempt) throw new Error('Attempt credential is missing.')
    const next=await dailyRequest<DailyAttempt>(final ? 'submit' : 'save',{ position:attempt.position,text },session.token)
    if (final && mounted.current) install(next)
  },[session?.token,attempt?.id,attempt?.position,install])
  const next=async () => {
    if (operation.current || !session?.token || !attempt) return
    if (attempt.position===5) { setShowFinal(true); return }
    operation.current=true; setBusy(true); setError('')
    try {
      if (attempt.mode==='voice') await requestMicrophone()
      install(await dailyRequest<DailyAttempt>('next',{ position:attempt.position },session.token))
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not start the next question.') }
    finally { operation.current=false; setBusy(false) }
  }
  useEffect(() => {
    if (!showFinal || !session?.token || attempt?.status!=='complete') return
    let active=true,pending=false
    const load=() => {
      if (pending) return
      pending=true
      void dailyRequest<DailyDistribution>('distribution',{},session.token).then((result) => { if (active) setPopulation(result) }).catch((error) => { if (active) setError(error.message) }).finally(() => { pending=false })
    }
    const visible=() => { if (document.visibilityState==='visible') load() }
    load()
    window.addEventListener('focus',load); document.addEventListener('visibilitychange',visible)
    return () => { active=false; window.removeEventListener('focus',load); document.removeEventListener('visibilitychange',visible) }
  },[showFinal,session?.token,attempt?.status])
  const feedback=error && <Banner tone="error" title="Could not continue" action={<Button size="sm" disabled={busy} onClick={() => { if (showFinal && session?.token) void dailyRequest<DailyDistribution>('distribution',{},session.token).then((value) => { setPopulation(value); setError('') }).catch((error) => setError(error.message)); else if (attempt) void refresh().catch((error) => setError(error.message)); else void restore() }}>Retry</Button>}>{error}</Banner>
  if (loading) return <div role="status" className="grid min-h-[60vh] place-items-center"><Spinner size={32} /></div>
  return <main className="relative mx-auto max-w-5xl space-y-7 px-4 pb-28 pt-12 sm:px-8 sm:pt-16">
    {feedback}
    {!attempt ? <>
      <section className="relative py-8 text-center"><div className="pointer-events-none absolute inset-0 -z-10 bg-grid" /><Eyebrow className="!text-accent">{today ? dateLabel(today.date) : 'Today'}</Eyebrow><h1 className="mt-5 text-5xl font-semibold tracking-tight sm:text-7xl">Daily <span className="text-accent">Five.</span></h1><p className="mx-auto mt-5 max-w-lg text-lg text-mute">Five strange questions. Five chances to think clearly.<br />Play freely. See where your reasoning lands.</p>
        <div aria-label="Daily Five input mode" className="mx-auto mt-8 inline-flex rounded-xl border border-line bg-card p-1">{(['typing','voice'] as InputMode[]).map((value) => <button key={value} onClick={() => setMode(value)} disabled={busy} aria-pressed={mode===value} className={`rounded-lg px-6 py-2.5 text-sm capitalize ${mode===value ? 'bg-accent text-white' : 'text-mute'}`}>{value}</button>)}</div>
        <div className="mt-5"><Button variant="primary" size="lg" disabled={!today?.available || busy} onClick={start}>{busy ? <Spinner /> : <Icon name="bolt" />}{busy ? (mode==='voice' ? 'Allow microphone access…' : 'Starting…') : 'Start Daily Five'}</Button></div>
        {today && !today.available && <p className="mt-4 text-sm text-mute">Today’s questions haven’t been published yet. Please check back soon.</p>}
      </section>
      <div className="grid gap-4 sm:grid-cols-3">{[['5 questions','Same daily prompts for everyone'],['5s to think',mode==='voice' ? '15s to speak each answer' : '20s to type each answer'],['250 points','Five categories.']].map(([title,description]) => <Card key={title} className="p-6"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-2 text-sm text-mute">{description}</p></Card>)}</div>
    </> : showFinal && attempt.status==='complete' ? <>
      <header className="text-center"><Eyebrow>{dateLabel(attempt.date)}</Eyebrow><h1 className="mt-3 text-4xl font-semibold sm:text-6xl">Daily Five Complete.</h1><div className="mt-6 text-7xl font-semibold tabular text-accent">{attempt.final_score}<span className="text-2xl font-normal text-mute"> / 250</span></div></header>
      <div className="grid grid-cols-5 gap-2 sm:gap-4">{attempt.rounds.map((r) => <Card key={r.position} className="p-3 text-center sm:p-5"><Eyebrow>Q{r.position}</Eyebrow><div className="mt-2 text-2xl font-semibold tabular">{r.total}<span className="text-xs font-normal text-mute">/50</span></div></Card>)}</div>
      {population ? <Population population={population} score={attempt.final_score!} /> : !error && <div className="flex justify-center"><Spinner /></div>}
      <div className="flex justify-center"><Button variant="primary" size="lg" onClick={async () => { try { await copyDailyResult(attempt.final_score!); setCopied(true) } catch { setError('Clipboard access failed. Allow clipboard access and try Copy Result again.') } }}>{copied ? 'Copied!' : 'Copy Result'}</Button></div>
      {today && attempt.date!==today.date && <Button className="mx-auto flex" onClick={() => { setAttempt(null); setSession(null); setShowFinal(false); setPopulation(null) }}>Today’s Daily Five</Button>}
    </> : round && <>
      <div className="flex items-center justify-between"><Eyebrow>Daily Five · {dateLabel(attempt.date)}</Eyebrow><span className="text-sm text-mute">Question {attempt.position} / 5</span></div>
      <div className="grid grid-cols-5 gap-2">{attempt.rounds.map((r) => <div key={r.position} className={`h-1 rounded-full ${r.state==='graded' ? 'bg-win' : r.position===attempt.position ? 'bg-accent' : 'bg-line'}`} />)}</div>
      {now>=Date.parse(round.started_at!) && <PromptCard question={round.question || ''} compact />}
      {round.state==='active' ? <DailyInput key={`${attempt.id}:${round.position}`} round={round} mode={attempt.mode} now={now} onSave={(text) => answer(text,false)} onSubmit={(text) => answer(text,true)} />
        : round.state==='graded' ? <Card className="animate-fade-up space-y-6 p-6 sm:p-8"><div className="text-center"><Eyebrow>Your score</Eyebrow><div className="mt-2 text-6xl font-semibold tabular text-accent">{round.total}<span className="text-xl font-normal text-mute"> / 50</span></div></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{CATS.map((category) => <div key={category} className="rounded-xl border border-line bg-card2/50 p-4 text-center"><Eyebrow>{category}</Eyebrow><p className="mt-2 text-2xl font-semibold tabular">{round.scores![category]}<span className="text-xs text-mute">/10</span></p></div>)}</div>{round.explanation && <p className="text-center leading-relaxed text-mute">{round.explanation}</p>}<div className="flex justify-center"><Button variant="primary" size="lg" disabled={busy} onClick={next}>{busy && <Spinner />}{attempt.position===5 ? 'View Final Results' : 'Next Question'}<Icon name="arrow" /></Button></div></Card>
        : <Card className="space-y-5 p-8 text-center"><div className="flex justify-center"><Spinner size={36} /></div><h2 className="text-2xl font-semibold">Evaluating your reasoning…</h2><p className="text-sm text-mute">Your answer is saved. Scoring Logic, Creativity, Relevance, Clarity, and Depth.</p>{(round.judge_error || judgeError) && <Banner tone="error" title="Judging is pending" action={<Button size="sm" disabled={grading.current || (round.judge_attempts || 0)>=3 || (!!round.retry_at && Date.parse(round.retry_at)>now)} onClick={() => { void grade() }}>Retry</Button>}>{round.judge_error || judgeError}{(round.judge_attempts || 0)>=3 && ' The grading retry limit has been reached.'}</Banner>}</Card>}
    </>}
  </main>
}
