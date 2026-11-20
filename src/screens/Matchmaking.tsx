import { useEffect, useState } from 'react'
import { Avatar, Button, Logo, RatingBadge, Wordmark } from '../components/ui'
import { PlayerCard } from '../components/game'
import type { Opponent, PlayerStats } from '../lib/game'

const STATUS = ['Scanning the ranked pool', 'Looking for players near your rating', 'Widening the search range', 'Waiting for another player']

export function Matchmaking({ player, opp, joinedAt, clockOffset, onCancel, expired = false, onRetry }: { player: PlayerStats; opp: Opponent | null; joinedAt: string; clockOffset: number; onCancel: () => void; expired?: boolean; onRetry?: () => void }) {
  const [now, setNow] = useState(Date.now() + clockOffset)
  useEffect(() => { const id = setInterval(() => setNow(Date.now() + clockOffset), 100); return () => clearInterval(id) }, [clockOffset])
  const t = Math.max(0, (now-Date.parse(joinedAt))/1000)
  const mm = `${String(Math.floor(t/60)).padStart(2,'0')}:${String(Math.floor(t)%60).padStart(2,'0')}`
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid" />
      <div className="pointer-events-none absolute left-1/2 top-1/2 size-[640px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-accent/10 blur-[120px]" />
      <header className="relative z-10 flex h-16 items-center px-5 sm:px-8"><Wordmark /></header>

      {expired ? (
        <main role="status" className="relative z-10 flex flex-1 animate-fade-in flex-col items-center justify-center px-6 pb-16 text-center">
          <div className="grid size-24 place-items-center rounded-full border border-line bg-card"><Logo size={44} /></div>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight sm:text-4xl">No opponents available right now.</h1>
          <p className="mt-3 max-w-md text-sm text-mute">Looks like nobody's searching for a match. Try again in a bit!</p>
          <div className="mt-8 flex flex-wrap justify-center gap-3"><Button onClick={onRetry}>Try Again</Button><Button variant="secondary" onClick={onCancel}>Back to Home</Button></div>
        </main>
      ) : !opp ? (
        <main key="s" className="relative z-10 flex flex-1 animate-fade-in flex-col items-center justify-center px-6 pb-16 text-center">
          <div className="relative grid size-64 place-items-center sm:size-72">
            {[0, 0.8, 1.6].map((d) => <span key={d} className="absolute inset-8 animate-ping-slow rounded-full border border-accent/40" style={{ animationDelay: `${d}s` }} />)}
            <div className="absolute inset-4 animate-orbit rounded-full border border-dashed border-line"><span className="absolute -top-1.5 left-1/2 size-3 -translate-x-1/2 rounded-full bg-accent shadow-[0_0_20px_#638BFF]" /></div>
            <div className="absolute inset-14 animate-orbit rounded-full border border-line [animation-direction:reverse] [animation-duration:9s]"><span className="absolute -bottom-1 left-1/2 size-2 -translate-x-1/2 rounded-full bg-ink/70" /></div>
            <div className="relative grid size-24 place-items-center rounded-full border border-line bg-card"><Logo size={44} /></div>
          </div>
          <h1 className="mt-8 text-3xl font-semibold tracking-tight sm:text-4xl">Finding your opponent...</h1>
          <p key={Math.min(3, Math.floor(t / 2.5))} className="mt-2 animate-fade-in text-sm text-mute">{STATUS[Math.min(3, Math.floor(t / 2.5))]}</p>
          <div className="mt-6 flex items-center gap-3"><span className="text-4xl font-semibold tabular">{mm}</span></div>
          <div className="mt-8 flex items-center gap-3 rounded-2xl border border-line bg-card/80 px-4 py-3"><Avatar name={player.name} size={36} /><div className="text-left"><div className="text-sm font-medium">{player.name}</div><div className="text-xs text-mute">Ranked 1v1</div></div><RatingBadge elo={player.elo} /></div>
          <Button variant="secondary" className="mt-8" onClick={onCancel}>Cancel match</Button>
        </main>
      ) : (
        <main key="f" className="relative z-10 flex flex-1 flex-col items-center justify-center px-6 pb-16 text-center">
          <div className="animate-pop text-xs font-semibold uppercase tracking-[0.35em] text-win">Opponent found</div>
          <div className="mt-10 grid w-full max-w-4xl grid-cols-[1fr_auto_1fr] items-center gap-3 sm:gap-8">
            <div className="animate-slide-l"><PlayerCard big name={player.name} elo={player.elo} ring="#638BFF" /></div>
            <div className="animate-pop text-5xl font-semibold italic tracking-tight text-white/90 [animation-delay:500ms] sm:text-8xl"><span className="bg-gradient-to-b from-white to-white/20 bg-clip-text text-transparent">VS</span></div>
            <div className="animate-slide-r"><PlayerCard big name={opp.name} elo={opp.elo} ring="#F07878" /></div>
          </div>
          <p className="mt-10 animate-fade-in text-sm text-mute [animation-delay:900ms]">Round begins in a moment · <span className="capitalize text-mute/70">{opp.mode} opponent</span></p>
        </main>
      )}
    </div>
  )
}
