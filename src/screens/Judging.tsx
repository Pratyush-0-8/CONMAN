import { useEffect, useState } from 'react'
import { CATS, type Opponent, type PlayerStats } from '../lib/game'
import { Avatar, Banner, Button, Icon, Logo, Wordmark } from '../components/ui'

const DESC = { Logic: 'Is the argument sound?', Creativity: 'Is the angle original?', Relevance: 'Does it answer the prompt?', Clarity: 'Is it easy to follow?', Depth: 'How far does it go?' } as Record<string, string>

export function Judging({ player, opp, question, myText, oppText, error, retryAt, onRetry }: { player: PlayerStats; opp: Opponent; question: string; myText: string; oppText: string; error: string | null; retryAt: string | null; onRetry: () => void }) {
  const [i, setI] = useState(0)
  const [now, setNow] = useState(Date.now())
  useEffect(() => {
    const id = setInterval(() => { setI((x) => (x + 1) % 5); setNow(Date.now()) }, 900)
    return () => clearInterval(id)
  }, [])
  const card = (name: string, text: string, c: string, delay: string) => (
    <div className="animate-fade-up rounded-2xl border border-line bg-card p-5 [animation-delay:var(--d)]" style={{ ['--d' as any]: delay }}>
      <div className="mb-3 flex items-center gap-3"><Avatar name={name} size={32} ring={c} /><span className="text-sm font-medium">{name}</span><span className="ml-auto flex items-center gap-1 text-[11px] text-mute"><Icon name="check" size={13} className="text-win" />Submitted</span></div>
      <p className="line-clamp-5 text-[15px] leading-relaxed text-ink/85">{text || 'No answer submitted.'}</p>
    </div>
  )
  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden">
      <div className="pointer-events-none absolute inset-0 bg-grid" />
      <header className="relative z-10 flex h-16 items-center px-5 sm:px-8"><Wordmark /></header>
      <main className="relative z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center gap-8 px-4 pb-12 sm:px-8">
        {error && <Banner tone="error" title="Judging is pending" action={<Button size="sm" disabled={!!retryAt && Date.parse(retryAt)>now} onClick={onRetry}>Retry</Button>}>{error}{retryAt && Date.parse(retryAt)>now ? ' Retry will be available shortly.' : ''} No ratings have been awarded.</Banner>}
        <div className="grid w-full gap-4 md:grid-cols-[1fr_auto_1fr] md:items-center md:gap-8">
          {card(player.name, myText, '#638BFF', '0ms')}
          {/* Judging core */}
          <div className="relative mx-auto grid size-40 place-items-center">
            <span className="absolute inset-0 animate-ping-slow rounded-full border border-accent/40" />
            <svg className="absolute inset-0 animate-orbit" viewBox="0 0 100 100" fill="none"><circle cx="50" cy="50" r="46" stroke="#242A3A" strokeWidth="1" /><path d="M50 4a46 46 0 0 1 46 46" stroke="#638BFF" strokeWidth="2" strokeLinecap="round" /></svg>
            <svg className="absolute inset-4 animate-orbit [animation-direction:reverse] [animation-duration:10s]" viewBox="0 0 100 100" fill="none"><polygon points="50,6 90,28 90,72 50,94 10,72 10,28" stroke="#242A3A" strokeDasharray="3 5" /></svg>
            <div className="relative grid size-20 place-items-center rounded-full border border-line bg-card"><Logo size={40} /></div>
          </div>
          {card(opp.name, oppText, '#F07878', '120ms')}
        </div>
        <div className="text-center">
          <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">Evaluating reasoning...</h1>
          <p className="mx-auto mt-2 max-w-md font-serif text-lg italic text-mute">“{question}”</p>
        </div>
        <div className="grid w-full max-w-3xl grid-cols-2 gap-3 sm:grid-cols-5">
          {CATS.map((c, k) => {
            const state = i > k ? 'done' : i === k ? 'active' : 'idle'
            return (
              <div key={c} className={`relative overflow-hidden rounded-xl border p-4 text-center transition-all duration-500 ${state === 'active' ? 'border-accent/60 bg-accent/10' : state === 'done' ? 'border-line bg-card' : 'border-line/60 bg-card/40'} ${k === 4 ? 'max-sm:col-span-2' : ''}`}>
                {state === 'active' && <div className="absolute inset-y-0 w-1/3 animate-sweep bg-gradient-to-r from-transparent via-accent/20 to-transparent" />}
                <div className={`relative mx-auto mb-2 grid size-6 place-items-center rounded-full transition-colors ${state === 'done' ? 'bg-win/20 text-win' : state === 'active' ? 'bg-accent/20 text-accent' : 'bg-line text-mute'}`}>
                  {state === 'done' ? <Icon name="check" size={13} /> : <span className={`size-1.5 rounded-full bg-current ${state === 'active' ? 'animate-blink' : ''}`} />}
                </div>
                <div className={`relative text-sm font-medium ${state === 'idle' ? 'text-mute' : ''}`}>{c}</div>
                <div className="relative mt-0.5 text-[11px] text-mute">{DESC[c]}</div>
              </div>
            )
          })}
        </div>
      </main>
    </div>
  )
}
