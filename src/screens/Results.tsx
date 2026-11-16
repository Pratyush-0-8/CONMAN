import { useEffect, useState } from 'react'
import { CATS, type MatchRecord, fmt, rankFor, total } from '../lib/game'
import { Avatar, Button, Card, Eyebrow, Icon, RatingBadge } from '../components/ui'
import { ScoreRow, Transcripts } from '../components/game'
import { Delta, OUT } from '../components/lists'

function useCountUp(from: number, to: number, ms = 1600, delay = 900) {
  const [v, setV] = useState(from)
  useEffect(() => {
    let raf = 0
    const t0 = performance.now() + delay
    const tick = (n: number) => {
      const p = Math.min(1, Math.max(0, (n - t0) / ms))
      setV(Math.round(from + (to - from) * (1 - (1 - p) ** 3)))
      if (p < 1) raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf)
  }, [from, to, ms, delay])
  return v
}

export function Results({ m, me, onAgain, onHome }: { m: MatchRecord; me: string; onAgain: () => void; onHome: () => void }) {
  const [open, setOpen] = useState(false)
  const [reveal, setReveal] = useState(0)
  useEffect(() => {
    const timers = [120,300,480,660,840,1400,2000,2400].map((delay, i) => setTimeout(() => setReveal(i+1), delay))
    return () => timers.forEach(clearTimeout)
  }, [m.id])
  const showTotals = reveal >= 6, showWinner = reveal >= 7, showRating = reveal >= 8
  const elo = useCountUp(m.eloBefore, m.eloAfter, 1200, 2400)
  const o = OUT[m.outcome]
  const glow = !showWinner ? '#638BFF' : m.outcome === 'win' ? '#38C994' : m.outcome === 'loss' ? '#F07878' : '#9299A8'
  const rankChanged = rankFor(m.eloBefore).name !== rankFor(m.eloAfter).name
  const side = (name: string, score: number, elo: number, winner: boolean, c: string, d = '0ms') => (
    <div className="animate-fade-up flex flex-col items-center gap-3 text-center [animation-delay:var(--d)]" style={{ ['--d' as any]: d }}>
      <div className="relative">
        <Avatar name={name} size={80} ring={showWinner && winner ? '#E8C06A' : c} />
        {showWinner && winner && <span className="absolute -top-3 left-1/2 grid size-8 -translate-x-1/2 place-items-center rounded-full bg-[#E8C06A] text-bg"><Icon name="crown" size={16} /></span>}
      </div>
      <div><div className="font-semibold">{name}</div><div className="mt-1.5"><RatingBadge elo={elo} /></div></div>
      <div className="text-3xl font-semibold tabular">{showTotals ? fmt(score) : '—'}<span className="text-sm font-normal text-mute"> / 50</span></div>
    </div>
  )
  return (
    <div className="relative min-h-screen overflow-hidden pb-16">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-grid" />
      <div className="pointer-events-none absolute left-1/2 top-0 size-[620px] -translate-x-1/2 -translate-y-1/3 rounded-full blur-[130px] opacity-25" style={{ background: glow }} />
      <div className="relative mx-auto max-w-4xl px-4 pt-14 sm:px-6 sm:pt-20">
        <div className="text-center">
          <Eyebrow className="animate-fade-in">Ranked 1v1 · Match complete</Eyebrow>
          <h1 className={`animate-pop mt-3 text-6xl font-semibold tracking-tight sm:text-8xl ${showWinner ? o.c : 'text-ink'}`}>{showWinner ? o.label : 'Score reveal'}</h1>
        </div>

        <section className="mt-8"><Eyebrow className="mb-3">Score breakdown · {me} / {m.opponent}</Eyebrow><div className="grid gap-3 sm:grid-cols-2">{CATS.map((cat,i) => reveal>i ? <ScoreRow key={cat} cat={cat} mine={m.mine[cat]} theirs={m.theirs[cat]} /> : <div key={cat} className="h-28 rounded-xl border border-line bg-card2/50" />)}</div></section>

        <div className="mt-10 grid grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-8">
          {side(me, total(m.mine), m.eloBefore, m.outcome === 'win', '#638BFF')}
          <div className="animate-pop text-center [animation-delay:400ms]">
            <div className="text-xs italic tracking-widest text-mute">VS</div>
            {showRating && <><div className={`mt-1 text-4xl font-semibold tabular sm:text-5xl ${m.delta > 0 ? 'text-win' : m.delta < 0 ? 'text-lose' : 'text-mute'}`}><Delta d={m.delta} /></div>
            <div className="mt-1 text-[11px] uppercase tracking-widest text-mute">ELO</div></>}
          </div>
          {side(m.opponent, total(m.theirs), m.opponentElo, m.outcome === 'loss', '#F07878', '120ms')}
        </div>

        {showRating && <Card className="animate-fade-up mt-10 grid gap-px overflow-hidden bg-line [animation-delay:300ms] sm:grid-cols-2">
          <div className="bg-card p-6 text-center sm:p-8">
            <Eyebrow>Your rating</Eyebrow>
            <div className="mt-2 flex items-center justify-center gap-4 tabular">
              <span className="text-xl text-mute line-through decoration-mute/40">{m.eloBefore}</span><Icon name="arrow" className="text-mute" />
              <span className={`text-5xl font-semibold ${m.delta > 0 ? 'text-win' : m.delta < 0 ? 'text-lose' : ''}`}>{elo}</span>
            </div>
            <div className="mt-2 text-sm text-mute">{rankChanged && m.delta > 0 ? <span className="text-win">Promoted to {rankFor(m.eloAfter).name}</span> : rankChanged ? <span className="text-lose">Dropped to {rankFor(m.eloAfter).name}</span> : rankFor(m.eloAfter).name}</div>
          </div>
          <div className="bg-card p-6 text-center sm:p-8">
            <Eyebrow>{m.outcome === 'draw' ? 'Judge’s verdict' : 'Decided by'}</Eyebrow>
            <div className="mt-2 text-4xl font-semibold uppercase tracking-[0.12em] text-accent sm:text-5xl">{m.key}</div>
            <div className="mt-2 text-sm text-mute">{m.outcome === 'draw' ? 'Both answers scored evenly overall.' : 'The category that separated the two answers most.'}</div>
          </div>
        </Card>}


        <Card className="mt-8 p-6 sm:p-8">
          <Eyebrow>The question</Eyebrow>
          <p className="mt-2 font-serif text-2xl leading-snug sm:text-3xl">{m.question}</p>
          <button onClick={() => setOpen((x) => !x)} aria-expanded={open} className="mt-5 flex items-center gap-2 text-sm font-medium text-accent hover:underline">
            Compare transcripts<Icon name="chev" size={16} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
          </button>
          <div className={`grid transition-all duration-500 ${open ? 'mt-4 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'}`}><div className="overflow-hidden"><Transcripts myName={me} oppName={m.opponent} myText={m.myText} oppText={m.oppText} /></div></div>
        </Card>

        {showRating && <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Button variant="primary" size="lg" onClick={onAgain}><Icon name="rotate" />Play again</Button>
          <Button size="lg" onClick={onHome}><Icon name="home" />Return home</Button>
        </div>}
      </div>
    </div>
  )
}
