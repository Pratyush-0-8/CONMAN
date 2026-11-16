import { type ReactNode, useEffect, useRef, useState } from 'react'
import { CATS, type Cat, type Scores, fmt, total } from '../lib/game'
import { Avatar, Card, Eyebrow, Icon, RatingBadge } from './ui'

/* ---------- Countdown ---------- */
export function useCountdown(seconds: number, onDone: () => void) {
  const [left, setLeft] = useState(seconds * 1000)
  const cb = useRef(onDone)
  cb.current = onDone
  useEffect(() => {
    const deadline = Date.now() + seconds * 1000
    let completed = false
    setLeft(seconds * 1000)
    const tick = () => {
      if (completed) return
      const l = Math.max(0, deadline - Date.now())
      setLeft(l)
      if (l === 0) { completed = true; clearInterval(id); clearTimeout(end); cb.current() }
    }
    const id = setInterval(tick, 50)
    const end = setTimeout(tick, seconds * 1000)
    window.addEventListener('focus', tick)
    document.addEventListener('visibilitychange', tick)
    return () => { clearInterval(id); clearTimeout(end); window.removeEventListener('focus', tick); document.removeEventListener('visibilitychange', tick) }
  }, [seconds])
  return left
}

export function CountdownRing({ left, total: tot, label, color, size = 220, urgent }: { left: number; total: number; label: string; color: string; size?: number; urgent?: boolean }) {
  const r = 46, c = 2 * Math.PI * r
  const frac = left / (tot * 1000)
  return (
    <div className="relative grid place-items-center" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full opacity-20 blur-2xl" style={{ background: color }} />
      <svg viewBox="0 0 100 100" className="absolute inset-0 -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="#242A3A" strokeWidth="2.5" />
        <circle cx="50" cy="50" r={r} fill="none" stroke={color} strokeWidth="3" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - frac)} />
      </svg>
      <div className="relative text-center">
        <div className={`font-semibold leading-none tabular ${urgent ? 'animate-blink' : ''}`} style={{ fontSize: size * 0.36 }}>{Math.ceil(left / 1000)}</div>
        <div className="mt-2 text-xs font-semibold tracking-[0.35em]" style={{ color }}>{label}</div>
      </div>
    </div>
  )
}

export function LinearTimer({ left, total: tot, color }: { left: number; total: number; color: string }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-line">
      <div className="h-full rounded-full" style={{ width: `${(left / (tot * 1000)) * 100}%`, background: color }} />
    </div>
  )
}

/* ---------- Prompt card ---------- */
export function PromptCard({ question, compact, children }: { question: string; compact?: boolean; children?: ReactNode }) {
  return (
    <div className="relative overflow-hidden rounded-3xl border border-line bg-gradient-to-b from-card2 to-card p-6 text-center shadow-[0_30px_80px_-40px_rgba(99,139,255,0.35)] sm:p-10">
      <svg className="pointer-events-none absolute -right-10 -top-10 opacity-[0.06]" width="220" height="220" viewBox="0 0 32 32" fill="none"><circle cx="12" cy="16" r="9" stroke="#fff" /><circle cx="20" cy="16" r="9" stroke="#fff" /></svg>
      <Eyebrow className="flex items-center justify-center gap-2 !text-accent"><span className="size-1.5 rounded-full bg-accent" />The question · identical for both players</Eyebrow>
      <h2 className={`mx-auto mt-4 max-w-3xl font-serif font-medium leading-[1.15] tracking-tight text-balance ${compact ? 'text-2xl sm:text-3xl' : 'text-3xl sm:text-5xl'}`}>{question}</h2>
      {children}
    </div>
  )
}

/* ---------- Player card ---------- */
export function PlayerCard({ name, elo, side = 'left', ring, tag, big }: { name: string; elo: number; side?: 'left' | 'right'; ring?: string; tag?: string; big?: boolean }) {
  return (
    <div className={`flex items-center gap-3 ${side === 'right' ? 'flex-row-reverse text-right' : ''} ${big ? 'flex-col !text-center gap-4' : ''}`}>
      <Avatar name={name} size={big ? 112 : 40} ring={ring} />
      <div className={big ? 'space-y-2' : ''}>
        <div className={`font-semibold leading-tight ${big ? 'text-2xl' : 'text-sm'}`}>{name}</div>
        <div className={`mt-1 ${side === 'right' && !big ? 'flex justify-end' : big ? 'flex justify-center' : ''}`}><RatingBadge elo={elo} showRank={big} /></div>
        {tag && <div className="text-[11px] text-mute">{tag}</div>}
      </div>
    </div>
  )
}

/* ---------- Waveform & mic ---------- */
export function Waveform({ active = true, color = '#F07878' }: { active?: boolean; color?: string }) {
  return (
    <div className="flex h-16 items-center justify-center gap-[3px]" aria-hidden>
      {Array.from({ length: 40 }).map((_, i) => {
        const env = Math.sin((i / 39) * Math.PI)
        return <span key={i} className={`w-[3px] origin-center rounded-full ${active ? 'animate-wave' : ''}`} style={{ height: `${20 + env * 80}%`, background: color, opacity: 0.35 + env * 0.65, animationDuration: `${0.6 + ((i * 37) % 70) / 100}s`, animationDelay: `${-((i * 53) % 100) / 100}s`, transform: active ? undefined : 'scaleY(0.15)' }} />
      })}
    </div>
  )
}
export function MicIndicator({ off }: { off?: boolean }) {
  return (
    <div className="relative grid size-14 place-items-center">
      {!off && <span className="absolute inset-0 animate-ping-slow rounded-full bg-lose/40" />}
      <span className={`relative grid size-14 place-items-center rounded-full ${off ? 'bg-card2 text-mute' : 'bg-lose text-white'}`}><Icon name={off ? 'micoff' : 'mic'} size={24} /></span>
    </div>
  )
}
export function RecordingStatus({ label }: { label: string }) {
  return <span className="inline-flex items-center gap-2 text-xs font-medium text-lose"><span className="size-2 animate-blink rounded-full bg-lose" />{label}</span>
}
export function TranscriptPanel({ text, live, placeholder }: { text: string; live?: boolean; placeholder: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => { ref.current?.scrollTo({ top: 1e5 }) }, [text])
  return (
    <Card className="p-5">
      <div className="flex items-center justify-between"><Eyebrow>Live transcript</Eyebrow>{live && <span className="text-[11px] text-mute">Speech-to-text</span>}</div>
      <div ref={ref} className="mt-3 max-h-36 min-h-24 overflow-y-auto text-lg leading-relaxed sm:text-xl">
        {text ? <>{text}{live && <span className="ml-0.5 inline-block h-5 w-0.5 translate-y-1 animate-blink bg-accent" />}</> : <span className="text-mute/60">{placeholder}</span>}
      </div>
    </Card>
  )
}

/* ---------- Score cards ---------- */
export function ScoreRow({ cat, mine, theirs, delay = 0 }: { cat: Cat; mine: number; theirs: number; delay?: number }) {
  const [on, setOn] = useState(false)
  useEffect(() => { const t = setTimeout(() => setOn(true), 100 + delay); return () => clearTimeout(t) }, [delay])
  const bar = (v: number, win: boolean, c: string) => (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-line"><div className="h-full rounded-full transition-[width] duration-1000 ease-out" style={{ width: on ? `${v * 10}%` : 0, background: win ? c : '#4A5266' }} /></div>
      <span className={`w-9 text-right text-sm tabular ${win ? 'font-semibold text-ink' : 'text-mute'}`}>{fmt(v)}</span>
    </div>
  )
  return (
    <div className="rounded-xl border border-line bg-card2/50 p-4">
      <div className="mb-3 flex items-center justify-between text-sm font-medium">{cat}<span className="text-[11px] font-normal text-mute">{mine === theirs ? 'Even' : mine > theirs ? `+${fmt(mine - theirs)} you` : `+${fmt(theirs - mine)} opp`}</span></div>
      <div className="space-y-2">{bar(mine, mine >= theirs, '#638BFF')}{bar(theirs, theirs > mine, '#F07878')}</div>
    </div>
  )
}
export function Breakdown({ mine, theirs, myName, oppName }: { mine: Scores; theirs: Scores; myName: string; oppName: string }) {
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs text-mute">
        <span className="flex items-center gap-4"><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-accent" />{myName}</span><span className="flex items-center gap-1.5"><i className="size-2 rounded-full bg-lose" />{oppName}</span></span>
        <span className="tabular">Total {fmt(total(mine))} – {fmt(total(theirs))}</span>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">{CATS.map((c, i) => <ScoreRow key={c} cat={c} mine={mine[c]} theirs={theirs[c]} delay={i * 120} />)}</div>
    </div>
  )
}

export function Transcripts({ myName, oppName, myText, oppText }: { myName: string; oppName: string; myText: string; oppText: string }) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {[{ n: myName, t: myText, c: '#638BFF' }, { n: oppName, t: oppText, c: '#F07878' }].map((x) => (
        <div key={x.n} className="rounded-xl border border-line bg-card2/50 p-4">
          <div className="mb-2 flex items-center gap-2 text-sm font-medium"><i className="size-2 rounded-full" style={{ background: x.c }} />{x.n}</div>
          <p className="text-[15px] leading-relaxed text-ink/90">{x.t}</p>
        </div>
      ))}
    </div>
  )
}
