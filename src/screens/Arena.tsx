import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Card, Eyebrow, Spinner, Wordmark } from '../components/ui'
import { CountdownRing, LinearTimer, MicIndicator, PlayerCard, PromptCard, RecordingStatus, TranscriptPanel, Waveform } from '../components/game'
import { savedRoundTiming, VOICE_SECONDS } from '../lib/rankedRules'
import { useSpeech } from '../lib/speech'
import { type RankedMatch, type RankedPlayer } from '../lib/matchService'
import { useAnswerSync } from '../lib/useAnswerSync'
import type { Opponent, PlayerStats } from '../lib/game'

const BLUE = '#638BFF', RED = '#F07878'


export function AppendInput({ text, onChange, disabled }: {
    text: string;
    onChange: (text: string) => void;
    disabled: boolean;
  }) {
    return (
      <Card className="w-full p-5">
        <Eyebrow>Your answer</Eyebrow>
        <textarea
          aria-label="Type your answer"
          autoFocus
          disabled={disabled}
          value={text}
          maxLength={12000}
          rows={5}
          className="mt-3 w-full resize-none rounded-xl border border-line bg-bg p-4 text-lg leading-relaxed outline-none focus:border-accent disabled:opacity-60"
          placeholder="Type your reasoning..."
          onPaste={(e) => e.preventDefault()}
          onDrop={(e) => e.preventDefault()}
          onBeforeInput={(e) => {
            const kind = (e.nativeEvent as InputEvent).inputType;
            if (kind === 'insertFromPaste' || kind === 'insertFromDrop') {
              e.preventDefault();
            }
          }}
          onChange={(e) => onChange(e.currentTarget.value)}
        />
        <p className="mt-2 text-xs text-mute">
          You can edit your answer. Pasting is disabled.
        </p>
      </Card>
    );
  }


export function VoiceInput({ initial, left, onText, onFinish, totalSeconds = VOICE_SECONDS }: { initial: string; left: number; totalSeconds?: number; onText: (text: string) => void; onFinish: (text: string) => void }) {
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
    <CountdownRing left={left} total={totalSeconds} label="SPEAK" color={RED} size={190} urgent={left < 3000} />
    <div className="space-y-4">
      <div className="flex items-center gap-4"><MicIndicator off={!recording} /><div className="min-w-0 flex-1"><Waveform active={recording} color={recording ? RED : '#9299A8'} /></div></div>
      {recording ? <RecordingStatus label="Recording" /> : <span role="status" className="text-xs text-mute">{left === 0 ? 'Finalizing transcript…' : 'Connecting speech recognition…'}</span>}
      <LinearTimer left={left} total={totalSeconds} color={RED} />
      {bad && <Banner tone="error" title="Speech recognition unavailable" action={sp.status !== 'unsupported' && <Button size="sm" disabled={left === 0} onClick={sp.retry}>Retry</Button>}>Check microphone permissions and your connection. A browser with Web Speech support is required. Your recognized words are preserved.</Banner>}
      <TranscriptPanel text={sp.text} live={recording} placeholder="Start speaking. Your words appear here in real time…" />
      <Button disabled={finishing.current} onClick={finish}>Submit answer</Button>
    </div>
  </div>
}

export function Arena({ player, opp, match, mine, now, onRefresh }: { player: PlayerStats; opp: Opponent; match: RankedMatch; mine: RankedPlayer; now: number; onRefresh: () => Promise<void> }) {
  const start = Date.parse(match.round_start), deadline = Date.parse(mine.deadline)
  const timing = savedRoundTiming(start, deadline, match.thinking_seconds)
  const thinking = now < timing.inputStart
  const left = Math.max(0, deadline - now)
  const sync = useAnswerSync(match.id, { ...mine, thinking_seconds: timing.thinkingSeconds }, match.round_start, now, onRefresh)
  const { text, error, submitting, done, finalizing, ready, superseded, change, submit, retry } = sync
  // On refresh after the deadline, do not reopen the microphone.
  const voiceStarted = useRef(false)
  useEffect(() => { if (ready && !thinking && left > 0 && mine.input_mode === 'voice') voiceStarted.current = true }, [ready, thinking, left > 0, mine.input_mode])
  useEffect(() => {
    if (!thinking && left === 0 && mine.input_mode === 'typing' && ready && !done) void submit()
  }, [thinking, left === 0, mine.input_mode, ready, done, submit])
  const waiting = !!mine.locked_at || done || finalizing || (left === 0 && (mine.input_mode === 'typing' || !voiceStarted.current))
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
      {error && <Banner tone="error" title="Answer not synced" action={<Button size="sm" onClick={() => { if (superseded) window.location.reload(); else void retry() }}>{superseded ? 'Reload saved answer' : 'Retry'}</Button>}>{error}</Banner>}
      <div className="flex justify-center">
        {thinking ? <div className="flex animate-fade-in flex-col items-center gap-5 text-center"><CountdownRing left={Math.max(0,timing.inputStart-now)} total={timing.thinkingSeconds} label="THINK" color={BLUE} size={208} urgent={timing.inputStart-now < 1500} /><p className="text-sm text-mute">You have {timing.thinkingSeconds} seconds to prepare your answer.</p></div>
          : waiting ? <div role="status" className="space-y-4 text-center"><div className="flex justify-center"><Spinner size={28} /></div><h2 className="text-2xl font-semibold">{submitting ? 'Saving your answer…' : finalizing && !done ? 'Your answer is awaiting confirmation…' : 'Waiting for your opponent…'}</h2><p className="text-sm text-mute">Both answers must be locked before judging begins.</p></div>
          : superseded ? <p className="text-sm text-mute">Answer editing is paused in this tab.</p>
          : !ready ? <div role="status" className="flex items-center gap-3 text-sm text-mute"><Spinner />Restoring your saved answer…</div>
          : mine.input_mode === 'voice' ? <VoiceInput initial={text} left={left} totalSeconds={timing.answerSeconds} onText={change} onFinish={(value) => { void submit(value) }} />
          : <div className="grid w-full gap-5 md:grid-cols-[auto_1fr] md:items-center md:gap-10"><CountdownRing left={left} total={timing.answerSeconds} label="TYPE" color={RED} size={190} urgent={left < 3000} /><div className="space-y-4"><AppendInput text={text} onChange={change} disabled={submitting || finalizing || superseded || left === 0} /><LinearTimer left={left} total={timing.answerSeconds} color={RED} /><Button onClick={() => { void submit() }} disabled={submitting || finalizing || superseded}>Submit answer</Button></div></div>}
      </div>
      <Eyebrow className="text-center !text-mute/50">{match.is_ranked === false ? 'Unranked friend challenge' : 'Ranked'} · Round 1 of 1 · {mine.input_mode} vs {opp.mode}</Eyebrow>
    </main>
  </div>
}
