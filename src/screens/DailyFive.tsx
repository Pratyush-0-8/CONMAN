import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Button, Card, Eyebrow, Icon, Spinner } from '../components/ui'
import { CountdownRing, LinearTimer, PromptCard } from '../components/game'
import { AppendInput, VoiceInput } from './Arena'
import { CATS, type InputMode } from '../lib/game'
import { populationCurve, scorePosition, strictlyBelowPercent } from '../lib/population'
import { copyDailyResult } from '../lib/dailyRules'
import { dailyRequest, dailyAnswerTransport, prepareDailySession, storeDailySession, type DailyAttempt, type DailyDistribution, type DailyRound as Round, type DailySession, type DailyToday } from '../lib/dailyService'
import { useAnswerReceipt } from '../lib/useAnswerReceipt'
import { writeReceipt } from '../lib/answerReceipt'
import { savedRoundTiming } from '../lib/rankedRules'
import { useAnswerSync } from '../lib/useAnswerSync'
import { dailyRolloverDelay, loadCurrentDaily } from '../lib/dailySession'
import { requestMicrophone } from '../lib/speech'

const dateLabel = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined,{ timeZone:'America/New_York',month:'long',day:'numeric',year:'numeric' })

export function DailyInput({ round, mode, now, token, attemptId, onRefresh }: { round: Round; mode: InputMode; now: number; token: string; attemptId: string; onRefresh: () => Promise<void> }) {
  const timing=savedRoundTiming(Date.parse(round.started_at!),Date.parse(round.deadline!),round.thinking_seconds)
  const sync = useAnswerSync(`${attemptId}:${round.position}`, {
    thinking_seconds:timing.thinkingSeconds, player_id: attemptId, username: '', input_mode: mode, deadline: round.deadline!, locked_at: round.locked_at || null,
    answer_text: round.answer_text || '', answer_revision: round.answer_revision, answer_writer: round.answer_writer,
    scores: null, total: null, elo_before: null, elo_after: null, delta: null,
  }, round.started_at!, now, onRefresh, dailyAnswerTransport(token, round.position))
  const { text, error, ready, done, finalizing, submitting, superseded, change, submit, retry } = sync
  const start=Date.parse(round.started_at!), deadline=Date.parse(round.deadline!), thinking=now<timing.inputStart, left=Math.max(0,deadline-now)
  const voiceStarted=useRef(false)
  useEffect(() => { if (ready && !thinking && left>0 && mode==='voice') voiceStarted.current=true },[ready,thinking,left>0,mode])
  useEffect(() => { if (!thinking && left===0 && mode==='typing' && ready && !done) void submit() },[thinking,left===0,mode,ready,done,submit])
  const waiting=done || finalizing || (left===0 && (mode==='typing' || !voiceStarted.current))
  if (now<start) return <div role="status" className="flex items-center justify-center gap-3 py-10 text-mute"><Spinner />Getting your question ready…</div>
  return <div className="space-y-5">
    {error && <Banner tone="error" title="Your answer is not synced" action={<Button size="sm" onClick={() => { if (superseded) window.location.reload(); else void retry() }}>{superseded ? 'Reload saved answer' : 'Retry'}</Button>}>{error}</Banner>}
    {thinking ? <div className="flex flex-col items-center gap-5"><CountdownRing left={Math.min(timing.thinkingSeconds*1000,Math.max(0,timing.inputStart-now))} total={timing.thinkingSeconds} label="THINK" color="#638BFF" size={208} /><p className="text-sm text-mute">{timing.thinkingSeconds} seconds to think. Then make your case.</p></div>
      : waiting ? <div role="status" className="flex flex-col items-center gap-4 py-10"><Spinner size={28} /><p className="text-mute">{done ? 'Answer saved. Preparing grading…' : submitting ? 'Saving your final answer…' : 'Final answer not confirmed. Retry submission.'}</p></div>
      : superseded ? <p className="text-sm text-mute">Answer editing is paused in this tab.</p>
      : !ready ? <div role="status" className="flex items-center justify-center gap-3"><Spinner />Restoring your saved answer…</div>
      : mode==='voice' ? <VoiceInput initial={text} left={left} totalSeconds={timing.answerSeconds} onText={change} onFinish={(value) => { void submit(value) }} />
      : <div className="grid gap-6 md:grid-cols-[auto_1fr] md:items-center"><CountdownRing left={left} total={timing.answerSeconds} label="TYPE" color="#F07878" size={190} /><div className="space-y-4"><AppendInput text={text} onChange={change} disabled={finalizing || superseded || left===0} /><LinearTimer left={left} total={timing.answerSeconds} color="#F07878" /><Button onClick={() => { void submit() }} disabled={finalizing || superseded}>Submit answer</Button></div></div>}
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
  const mounted=useRef(false),operation=useRef(false),grading=useRef<string | null>(null)
  const restoreVersion=useRef(0), selectedDate=useRef<string | null>(null)
  const now=Date.now()+(attempt?.clockOffset || 0),round=attempt?.rounds.find((r) => r.position===attempt.position)
  const receiptKey = `${attempt?.id}:${round?.position}:${attempt?.id}`
  const receipt = useAnswerReceipt(receiptKey,round?.final_answer_text,!!round?.locked_at)
  const install=useCallback((next: DailyAttempt) => { if (next.date!==selectedDate.current) return; setAttempt((previous) => previous && previous.id===next.id && Date.parse(previous.server_now)>Date.parse(next.server_now) ? previous : next) },[])
  const restore=useCallback(async () => {
    const version=++restoreVersion.current
    setLoading(true); setError(''); setPopulation(null)
    try {
      const loaded=await loadCurrentDaily()
      if (!mounted.current || version!==restoreVersion.current) return
      selectedDate.current=loaded.today.date
      setToday(loaded.today); setSession(loaded.session); setAttempt(loaded.attempt)
      setShowFinal(loaded.attempt?.status==='complete'); setMode(loaded.attempt?.mode || loaded.session?.mode || 'typing')
    } catch (error) { if (mounted.current && version===restoreVersion.current) setError(error instanceof Error ? error.message : 'Could not load Daily Five.') }
    finally { if (mounted.current && version===restoreVersion.current) setLoading(false) }
  },[])
  useEffect(() => {
    if (!today) return
    let active=true, checking=false
    const check=async () => {
      if (checking) return; checking=true
      try {
        const current=await dailyRequest<DailyToday>('today')
        if (active && current.date!==selectedDate.current) await restore()
        else if (active) setToday(current)
      } catch (error) { if (active) setError(error instanceof Error ? error.message : 'Could not check today’s challenge.') }
      finally { checking=false }
    }
    const rollover=setTimeout(() => { void check() },dailyRolloverDelay(today)), poll=setInterval(() => { void check() },60000)
    const visible=() => { if (document.visibilityState==='visible') void check() }
    window.addEventListener('focus',visible); window.addEventListener('online',visible); document.addEventListener('visibilitychange',visible)
    return () => { active=false; clearTimeout(rollover); clearInterval(poll); window.removeEventListener('focus',visible); window.removeEventListener('online',visible); document.removeEventListener('visibilitychange',visible) }
  },[today?.date,today?.next_date_at,today?.server_now,restore])
  useEffect(() => { mounted.current=true; void restore(); return () => { mounted.current=false } },[restore])
  const refresh=useCallback(async () => {
    if (!session?.token) return
    const version=restoreVersion.current
    const next=await dailyRequest<DailyAttempt>('state',{},session.token)
    if (mounted.current && version===restoreVersion.current) { install(next); setError('') }
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
    const version=restoreVersion.current
    operation.current=true; setBusy(true); setError(''); setPopulation(null)
    try {
      const stored=await prepareDailySession(today.date,mode)
      if (stored.mode==='voice') await requestMicrophone()
      const result=await dailyRequest<DailyAttempt & { token: string }>('start',{ creationKey:stored.creationKey,date:today.date,mode:stored.mode })
      const credential={ ...stored,token:result.token }
      await storeDailySession(credential)
      if (mounted.current && version===restoreVersion.current && result.date===selectedDate.current) { setSession(credential); install(result); setShowFinal(result.status==='complete') }
    } catch (error) { if (mounted.current) setError(error instanceof Error ? error.message : 'Could not start Daily Five.') }
    finally { operation.current=false; if (mounted.current) setBusy(false) }
  }
  const grade=useCallback(async () => {
    if (!session?.token || !attempt || (receipt && !receipt.confirmed)) return
    const key=`${attempt.id}:${attempt.position}`, version=restoreVersion.current
    if (grading.current===key) return
    grading.current=key; setJudgeError('')
    try { await dailyRequest('judge',{ position:attempt.position },session.token) }
    catch (error) { if (mounted.current && version===restoreVersion.current) setJudgeError(error instanceof Error ? error.message : 'Judging failed; retry to continue.') }
    finally { if (grading.current===key) grading.current=null; if (mounted.current && version===restoreVersion.current) await refresh().catch((error) => setError(error.message)) }
  },[session?.token,attempt?.id,attempt?.position,refresh,receipt?.confirmed,receipt?.error])
  useEffect(() => { if (round?.state==='locked' && (!receipt || receipt.confirmed)) void grade() },[attempt?.id,attempt?.position,round?.state,grade,receipt?.confirmed,!!receipt])
  useEffect(() => { if (round?.state==='judging' && (round.judge_attempts || 0)<3 && round.judge_lease_until && now>Date.parse(round.judge_lease_until)) void grade() },[now,round?.state,round?.judge_lease_until,grade])
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
    {receipt && !receipt.confirmed && round?.state!=='active' && <Banner tone="error" title="Final answer not confirmed" action={<Button size="sm" onClick={() => writeReceipt(receiptKey,null)}>Continue with saved draft</Button>}>{receipt.error || 'The final submission has not been confirmed. Your answer has not been graded in this tab.'}<p className="mt-2 whitespace-pre-wrap">Saved draft: {round?.answer_text || '(empty)'}</p></Banner>}
    {!attempt ? <>
      <section className="relative py-8 text-center"><div className="pointer-events-none absolute inset-0 -z-10 bg-grid" /><Eyebrow className="!text-accent">{today ? dateLabel(today.date) : 'Today'}</Eyebrow><h1 className="mt-5 text-5xl font-semibold tracking-tight sm:text-7xl">Daily <span className="text-accent">Five.</span></h1><p className="mx-auto mt-5 max-w-lg text-lg text-mute">Five strange questions. Five chances to think clearly.<br />Play freely. See where your reasoning lands.</p>
        <div aria-label="Daily Five input mode" className="mx-auto mt-8 inline-flex rounded-xl border border-line bg-card p-1">{(['typing','voice'] as InputMode[]).map((value) => <button key={value} onClick={() => setMode(value)} disabled={busy} aria-pressed={mode===value} className={`rounded-lg px-6 py-2.5 text-sm capitalize ${mode===value ? 'bg-accent text-white' : 'text-mute'}`}>{value}</button>)}</div>
        <div className="mt-5"><Button variant="primary" size="lg" disabled={!today?.available || busy} onClick={start}>{busy ? <Spinner /> : <Icon name="bolt" />}{busy ? (mode==='voice' ? 'Allow microphone access…' : 'Starting…') : 'Start Daily Five'}</Button></div>
        {today && !today.available && <p className="mt-4 text-sm text-mute">Today’s questions haven’t been published yet. Please check back soon.</p>}
      </section>
      <div className="grid gap-4 sm:grid-cols-3">{[['5 questions','Same daily prompts for everyone'],['10s to think',mode==='voice' ? '25s to speak each answer' : '35s to type each answer'],['250 points','Five categories.']].map(([title,description]) => <Card key={title} className="p-6"><h2 className="text-lg font-semibold">{title}</h2><p className="mt-2 text-sm text-mute">{description}</p></Card>)}</div>
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
      {round.state==='active' ? <DailyInput key={`${attempt.id}:${round.position}`} round={round} mode={attempt.mode} now={now} token={session!.token!} attemptId={attempt.id} onRefresh={refresh} />
        : round.state==='graded' ? <Card className="animate-fade-up space-y-6 p-6 sm:p-8"><div className="text-center"><Eyebrow>Your score</Eyebrow><div className="mt-2 text-6xl font-semibold tabular text-accent">{round.total}<span className="text-xl font-normal text-mute"> / 50</span></div></div><div className="grid grid-cols-2 gap-3 sm:grid-cols-5">{CATS.map((category) => <div key={category} className="rounded-xl border border-line bg-card2/50 p-4 text-center"><Eyebrow>{category}</Eyebrow><p className="mt-2 text-2xl font-semibold tabular">{round.scores![category]}<span className="text-xs text-mute">/10</span></p></div>)}</div>{round.explanation && <p className="text-center leading-relaxed text-mute">{round.explanation}</p>}<div className="flex justify-center"><Button variant="primary" size="lg" disabled={busy} onClick={next}>{busy && <Spinner />}{attempt.position===5 ? 'View Final Results' : 'Next Question'}<Icon name="arrow" /></Button></div></Card>
        : <Card className="space-y-5 p-8 text-center"><div className="flex justify-center"><Spinner size={36} /></div><h2 className="text-2xl font-semibold">{receipt && !receipt.confirmed ? 'Final answer needs review' : 'Evaluating your reasoning…'}</h2><p className="text-sm text-mute">{receipt && !receipt.confirmed ? 'Review the saved draft above. Grading is paused in this tab.' : 'Your answer is saved. Scoring Logic, Creativity, Relevance, Clarity, and Depth.'}</p>{(round.judge_error || judgeError) && <Banner tone="error" title="Judging is pending" action={<Button size="sm" disabled={grading.current===`${attempt.id}:${attempt.position}` || (round.judge_attempts || 0)>=3 || (!!round.retry_at && Date.parse(round.retry_at)>now)} onClick={() => { void grade() }}>Retry</Button>}>{round.judge_error || judgeError}{(round.judge_attempts || 0)>=3 && ' The grading retry limit has been reached.'}</Banner>}</Card>}
    </>}
  </main>
}
