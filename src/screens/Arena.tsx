import { useState } from 'react'
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

function Speak({ sample, onDone }: { sample: string; onDone: (t: string) => void }) {
  const sp = useSpeech(sample)
  const [retry, setRetry] = useState(false)
  const left = useCountdown(15, () => onDone(sp.final))
  const bad = sp.status !== 'listening'
  return (
    <div className="grid w-full animate-fade-in gap-5 md:grid-cols-[auto_1fr] md:items-center md:gap-10">
      <div className="flex flex-col items-center gap-3 md:gap-5">
        <CountdownRing left={left} total={15} label="SPEAK" color={RED} size={190} urgent={left < 3000} />
      </div>
      <div className="space-y-4">
        <div className="flex items-center gap-4">
          <MicIndicator off={bad} />
          <div className="min-w-0 flex-1"><Waveform active color={bad ? '#9299A8' : RED} /></div>
        </div>
        <div className="flex items-center justify-between">
          {bad ? <span className="text-xs font-medium text-mute">Demo transcript</span> : <RecordingStatus label="Recording" />}
          <span className="text-xs text-mute tabular">{(15 - left / 1000).toFixed(1)}s / 15s</span>
        </div>
        <LinearTimer left={left} total={15} color={RED} />
        {sp.status === 'denied' && !retry && (
          <Banner tone="error" title="Microphone access was blocked" action={<Button size="sm" variant="ghost" onClick={() => setRetry(true)}>Dismiss</Button>}>Allow the microphone in your browser to speak your answer. A simulated transcript is shown so you can continue the demo.</Banner>
        )}
        {sp.status === 'unsupported' && !retry && (
          <Banner title="Speech recognition unavailable" action={<Button size="sm" variant="ghost" onClick={() => setRetry(true)}>Dismiss</Button>}>This browser doesn’t support the Web Speech API. Try Chrome or Edge. Showing a simulated transcript for now.</Banner>
        )}
        {sp.status === 'error' && !retry && (
          <Banner tone="error" title="Couldn’t reach the microphone" action={<Button size="sm" variant="ghost" onClick={() => setRetry(true)}>Dismiss</Button>}>Check that an input device is connected. Continuing with a simulated transcript.</Banner>
        )}
        <TranscriptPanel text={sp.text} live placeholder="Start speaking. Your words appear here in real time…" />
      </div>
    </div>
  )
}

export function Arena({ player, opp, question, sample, onDone }: { player: PlayerStats; opp: Opponent; question: string; sample: string; onDone: (text: string) => void }) {
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
          {phase === 'think' ? <Think onDone={() => setPhase('speak')} /> : <Speak sample={sample} onDone={onDone} />}
        </div>
        <Eyebrow className="text-center !text-mute/50">Ranked · Round 1 of 1 · {phase === 'think' ? 'Preparing' : 'Recording'}</Eyebrow>
      </main>
    </div>
  )
}
