import { useEffect, useRef, useState } from 'react'
import { Banner, Button, Eyebrow, Wordmark } from '../components/ui'
import { CountdownRing, LinearTimer, MicIndicator, PlayerCard, PromptCard, RecordingStatus, TranscriptPanel, Waveform, useCountdown } from '../components/game'
import { useSpeech } from '../lib/speech'
import type { Opponent, PlayerStats } from '../lib/game'

const BLUE = '#638BFF', RED = '#F07878'

function Think({ onDone }: { onDone: () => void }) {
  const left = useCountdown(5, onDone)
  return (
    <div className="flex animate-fade-in flex-col items-center gap-5 text-center">
      <CountdownRing left={left} total={5} label="THINK" color={BLUE} size={208} urgent={left < 1500} />
      <p className="text-sm text-mute sm:text-base">You have 5 seconds to prepare your answer.</p>
      <p className="text-xs text-mute/60">Microphone stays off until the speaking phase.</p>
    </div>
  )
}

function Speak({ onDone }: { onDone: (t: string) => void }) {
  const sp = useSpeech()
  const finished = useRef(false)
  const mounted = useRef(false)
  useEffect(() => { mounted.current = true; return () => { mounted.current = false } }, [])
  const left = useCountdown(15, () => {
    if (finished.current) return
    finished.current = true
    void sp.finish().then((text) => { if (mounted.current) onDone(text) })
  })
  const recording = sp.status === 'listening'
  const bad = sp.status === 'denied' || sp.status === 'unsupported' || sp.status === 'error'
  return (
    <div className="grid w-full animate-fade-in gap-5 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
      <div className="flex flex-col items-center gap-3 md:gap-5">
        <CountdownRing left={left} total={15} label="SPEAK" color={RED} size={190} urgent={left < 3000} />
      </div>
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <MicIndicator off={!recording} />
          <div className="min-w-0 flex-1"><Waveform active={recording} color={recording ? RED : '#9299A8'} /></div>
        </div>
        <div className="flex items-center justify-between">
          {recording ? <RecordingStatus label="Recording" /> : <span role="status" className="text-xs font-medium text-mute">{sp.status === 'starting' ? 'Starting speech recognition…' : sp.status === 'stopped' ? 'Submitting transcript…' : 'Speech recognition unavailable'}</span>}
          <span className="text-xs text-mute tabular">{(15 - left / 1000).toFixed(1)}s / 15s</span>
        </div>
        <LinearTimer left={left} total={15} color={RED} />
        {sp.status === 'denied' && (
          <Banner tone="error" title="Speech recognition was blocked" action={<Button size="sm" variant="ghost" disabled={left === 0} onClick={sp.retry}>Retry</Button>}>Allow microphone and speech recognition access in your browser’s site settings. Only words actually recognized will be submitted.</Banner>
        )}
        {sp.status === 'unsupported' && (
          <Banner title="Speech recognition unavailable">This browser doesn’t support the Web Speech API. Use a browser with speech recognition support, such as Chrome or Edge. No sample answer will be submitted.</Banner>
        )}
        {sp.status === 'error' && (
          <Banner tone="error" title="Speech recognition interrupted" action={<Button size="sm" variant="ghost" disabled={left === 0} onClick={sp.retry}>Retry</Button>}>Check your microphone and internet connection, then retry within the remaining time. Your transcript so far is preserved.</Banner>
        )}
        <TranscriptPanel text={sp.text} live={recording} placeholder={bad ? 'No speech recognized. Only your spoken words will appear here.' : 'Start speaking. Your words appear here in real time…'} />
      </div>
    </div>
  )
}

export function Arena({ player, opp, question, onDone }: { player: PlayerStats; opp: Opponent; question: string; onDone: (text: string) => void }) {
  const [phase, setPhase] = useState<'think' | 'speak'>('think')
  return (
    <div className="relative flex min-h-screen flex-col">
      <div className="pointer-events-none absolute inset-0 bg-grid" />
      <header className="relative z-10 border-b border-line/60 bg-bg/70 backdrop-blur-xl">
        <div className="mx-auto grid h-16 max-w-6xl grid-cols-[auto_1fr_auto] items-center gap-4 px-4 sm:h-20 sm:px-8 md:grid-cols-[1fr_auto_1fr]">
          <Wordmark className="max-md:hidden" />
          <div className="flex items-center justify-center gap-3 sm:gap-6 max-md:col-span-2 max-md:justify-start">
            <PlayerCard name={player.name} elo={player.elo} ring={BLUE} />
            <span className="text-xs font-semibold italic tracking-widest text-mute">VS</span>
            <PlayerCard name={opp.name} elo={opp.elo} side="right" ring={RED} />
          </div>
          <div className="flex items-center justify-end gap-2 text-xs font-semibold tracking-[0.2em]">
            {(['think', 'speak'] as const).map((p, i) => (
              <span key={p} className={`flex items-center gap-2 transition-colors ${phase === p ? (p === 'think' ? 'text-accent' : 'text-lose') : 'text-mute/50'}`}>
                {i > 0 && <span className="h-px w-4 bg-line" />}<span className="hidden uppercase sm:inline">{p}</span><span className="sm:hidden uppercase">{p[0]}</span>
              </span>
            ))}
          </div>
        </div>
        <div className="h-px"><div className="h-full bg-accent transition-all duration-700" style={{ width: phase === 'think' ? '25%' : '65%' }} /></div>
      </header>
      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col justify-center gap-6 px-4 py-6 sm:gap-10 sm:px-8 sm:py-10">
        <div className="animate-fade-up"><PromptCard question={question} compact={phase === 'speak'} /></div>
        <div key={phase} className="flex justify-center">
          {phase === 'think' ? <Think onDone={() => setPhase('speak')} /> : <Speak onDone={onDone} />}
        </div>
        <Eyebrow className="text-center !text-mute/50">Ranked · Round 1 of 1 · {phase === 'think' ? 'Preparing' : 'Recording'}</Eyebrow>
      </main>
    </div>
  )
}
