import { useCallback, useEffect, useRef, useState } from 'react'
import { Banner, Button, Card, Eyebrow, Spinner, Wordmark } from '../components/ui'
import { CountdownRing, LinearTimer, MicIndicator, PlayerCard, PromptCard, RecordingStatus, TranscriptPanel, Waveform } from '../components/game'
import { useSpeech } from '../lib/speech'
import { saveAnswer, type RankedMatch, type RankedPlayer } from '../lib/matchService'
import { acceptsAppend } from '../lib/rankedRules'
import type { Opponent, PlayerStats } from '../lib/game'

const BLUE = '#638BFF', RED = '#F07878'

function AppendInput({ text, onChange, disabled }: { text: string; onChange: (text: string) => void; disabled: boolean }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  const composing = useRef(false)
  const committed = useRef(text)
  const [display, setDisplay] = useState(text)
  const append = (next: string) => {
    if (acceptsAppend(committed.current, next)) { committed.current = next; onChange(next); setDisplay(next) }
    else setDisplay(committed.current)
  }
  const end = () => { const input = ref.current; if (input && !composing.current) input.setSelectionRange(input.value.length, input.value.length) }
  return <Card className="w-full p-5">
    <Eyebrow>Your answer · append only</Eyebrow>
    <textarea ref={ref} aria-label="Type your answer" autoFocus disabled={disabled} value={display} maxLength={12000} rows={5}
      className="mt-3 w-full resize-none rounded-xl border border-line bg-bg p-4 text-lg leading-relaxed outline-none focus:border-accent disabled:opacity-60"
      placeholder="Type your reasoning. Characters cannot be removed or changed."
      onSelect={end} onFocus={end} onPaste={(e) => e.preventDefault()} onCut={(e) => e.preventDefault()} onDrop={(e) => e.preventDefault()} onDragStart={(e) => e.preventDefault()}
      onBeforeInput={(e) => { const kind = (e.nativeEvent as InputEvent).inputType; if (kind && !['insertText', 'insertLineBreak', 'insertParagraph', 'insertCompositionText', 'insertFromComposition'].includes(kind) && !(composing.current && kind === 'deleteCompositionText')) e.preventDefault() }}
      onKeyDown={(e) => { if (!composing.current && (['Backspace', 'Delete'].includes(e.key) || ((e.metaKey || e.ctrlKey) && ['v','x','z','y'].includes(e.key.toLowerCase())))) e.preventDefault() }}
      onCompositionStart={() => { end(); composing.current = true }}
      onCompositionEnd={(e) => { composing.current = false; append(e.currentTarget.value); end() }}
      onChange={(e) => { const kind = (e.nativeEvent as InputEvent).inputType || ''; if (/Paste|Drop|Replacement|history/i.test(kind)) { setDisplay(committed.current); return }; if (composing.current) setDisplay(e.currentTarget.value); else append(e.currentTarget.value) }} />
    <p className="mt-2 text-xs text-mute">No editing, deleting, pasting, or dropping text. Finish early with Submit answer.</p>
  </Card>
}

function VoiceInput({ initial, left, onText, onFinish }: { initial: string; left: number; onText: (text: string) => void; onFinish: (text: string) => void }) {
  const sp = useSpeech(initial)
  const finishing = useRef(false)
  const alive = useRef(false)
  const stopRef = useRef(sp.finish); stopRef.current = sp.finish
  const finishRef = useRef(onFinish); finishRef.current = onFinish
  const textRef = useRef(onText); textRef.current = onText
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  useEffect(() => { textRef.current(sp.text) }, [sp.text])
  const finish = () => {
    if (finishing.current) return
    finishing.current = true
    void stopRef.current().then((text) => { if (alive.current) finishRef.current(text) })
  }
  useEffect(() => { if (left === 0) finish() }, [left])
  const recording = sp.status === 'listening'
  const bad = ['denied','unsupported','error'].includes(sp.status)
  return <div className="grid w-full animate-fade-in gap-5 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
    <CountdownRing left={left} total={15} label="SPEAK" color={RED} size={190} urgent={left < 3000} />
    <div className="space-y-4">
      <div className="flex items-center gap-4"><MicIndicator off={!recording} /><div className="min-w-0 flex-1"><Waveform active={recording} color={recording ? RED : '#9299A8'} /></div></div>
      {recording ? <RecordingStatus label="Recording" /> : <span role="status" className="text-xs text-mute">{left === 0 ? 'Finalizing transcript…' : 'Connecting speech recognition…'}</span>}
      <LinearTimer left={left} total={15} color={RED} />
      {bad && <Banner tone="error" title="Speech recognition unavailable" action={sp.status !== 'unsupported' && <Button size="sm" disabled={left === 0} onClick={sp.retry}>Retry</Button>}>Check microphone permissions and your connection. A browser with Web Speech support is required. Your recognized words are preserved.</Banner>}
      <TranscriptPanel text={sp.text} live={recording} placeholder="Start speaking. Your words appear here in real time…" />
      <Button disabled={finishing.current} onClick={finish}>Submit answer</Button>
    </div>
  </div>
}

export function Arena({ player, opp, match, mine, now, onRefresh }: { player: PlayerStats; opp: Opponent; match: RankedMatch; mine: RankedPlayer; now: number; onRefresh: () => Promise<void> }) {
  const start = Date.parse(match.round_start), deadline = Date.parse(mine.deadline)
  const thinking = now < start + 5000
  const left = Math.max(0, deadline - now)
  const [text, setText] = useState(mine.answer_text || '')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [done, setDone] = useState(false)
  // On refresh after the deadline, do not reopen the microphone.
  const [voiceWasOpen] = useState(now < deadline)
  const latest = useRef(text); latest.current = text
  const chain = useRef<Promise<void>>(Promise.resolve())
  const inFlight = useRef(false)
  const alive = useRef(false)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const send = useCallback((value: string, final: boolean) => {
    const request = chain.current.catch(() => {}).then(() => saveAnswer(match.id, value, final))
    chain.current = request
    return request
  }, [match.id])
  const submit = useCallback(async (value: string) => {
    if (inFlight.current || mine.locked_at) return
    inFlight.current = true; setSubmitting(true); setError('')
    try { await send(value, true); if (alive.current) setDone(true); await onRefresh() }
    catch (error) { if (alive.current) setError(error instanceof Error ? error.message : 'Answer could not be sent. Retry.') }
    finally { inFlight.current = false; if (alive.current) setSubmitting(false) }
  }, [send, mine.locked_at, onRefresh])
  // Throttle saves even during uninterrupted typing; do not build up a network backlog.
  const draftBusy = useRef(false)
  const lastSaved = useRef(mine.answer_text || '')
  useEffect(() => {
    if (thinking || mine.locked_at || done || left === 0 || submitting) return
    const id = setInterval(() => {
      if (draftBusy.current || latest.current === lastSaved.current) return
      const value = latest.current
      draftBusy.current = true
      void send(value, false).then(() => { lastSaved.current = value }).catch((error) => { if (alive.current) setError(error instanceof Error ? error.message : 'Could not save your draft.') }).finally(() => { draftBusy.current = false })
    }, 250)
    return () => clearInterval(id)
  }, [thinking, mine.locked_at, done, left === 0, submitting, send])
  const autoSubmitted = useRef(false)
  useEffect(() => {
    if (!thinking && left === 0 && mine.input_mode === 'typing' && !autoSubmitted.current && !mine.locked_at) {
      autoSubmitted.current = true
      void submit(latest.current)
    }
  }, [thinking, left, mine.input_mode, mine.locked_at, submit])
  const waiting = !!mine.locked_at || done || (left === 0 && (mine.input_mode === 'typing' || !voiceWasOpen))
  const phase = thinking ? 'think' : waiting ? 'waiting' : mine.input_mode === 'voice' ? 'speak' : 'type'
  return <div className="relative flex min-h-screen flex-col">
    <div className="pointer-events-none absolute inset-0 bg-grid" />
    <header className="relative z-10 border-b border-line/60 bg-bg/70 backdrop-blur-xl">
      <div className="mx-auto grid h-16 max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-4 px-4 sm:h-20 sm:px-8 md:grid-cols-[1fr_auto_1fr]">
        <Wordmark className="max-md:hidden" />
        <div className="flex items-center justify-center gap-3 sm:gap-6 max-md:col-span-2 max-md:justify-start"><PlayerCard name={player.name} elo={player.elo} ring={BLUE} /><span className="text-xs font-semibold italic tracking-widest text-mute">VS</span><PlayerCard name={opp.name} elo={opp.elo} side="right" ring={RED} /></div>
        <div className={`text-right text-xs font-semibold uppercase tracking-[0.2em] ${thinking ? 'text-accent' : 'text-lose'}`}>{phase}</div>
      </div>
      <div className="h-px"><div className="h-full bg-accent transition-all duration-700" style={{ width: thinking ? '25%' : waiting ? '100%' : '65%' }} /></div>
    </header>
    <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-6 px-4 py-6 sm:gap-10 sm:px-8 sm:py-10">
      <div className="animate-fade-up"><PromptCard question={match.question} compact={!thinking} /></div>
      {error && <Banner tone="error" title="Answer not synced" action={<Button size="sm" onClick={() => { void submit(latest.current) }}>Retry</Button>}>{error}</Banner>}
      <div className="flex justify-center">
        {thinking ? <div className="flex animate-fade-in flex-col items-center gap-5 text-center"><CountdownRing left={Math.max(0,start+5000-now)} total={5} label="THINK" color={BLUE} size={208} urgent={start+5000-now < 1500} /><p className="text-sm text-mute">You have 5 seconds to prepare your answer.</p></div>
          : waiting ? <div role="status" className="space-y-4 text-center"><div className="flex justify-center"><Spinner size={28} /></div><h2 className="text-2xl font-semibold">{submitting ? 'Saving your answer…' : 'Waiting for your opponent…'}</h2><p className="text-sm text-mute">Both answers must be locked before judging begins.</p></div>
          : mine.input_mode === 'voice' ? <VoiceInput initial={text} left={left} onText={setText} onFinish={(value) => { latest.current = value; setText(value); void submit(value) }} />
          : <div className="grid w-full gap-5 md:grid-cols-[auto_1fr] md:items-center md:gap-10"><CountdownRing left={left} total={20} label="TYPE" color={RED} size={190} urgent={left < 3000} /><div className="space-y-4"><AppendInput text={text} onChange={setText} disabled={submitting || left === 0} /><LinearTimer left={left} total={20} color={RED} /><Button onClick={() => { void submit(text) }} disabled={submitting}>Submit answer</Button></div></div>}
      </div>
      <Eyebrow className="text-center !text-mute/50">Ranked · Round 1 of 1 · {mine.input_mode} vs {opp.mode}</Eyebrow>
    </main>
  </div>
}
