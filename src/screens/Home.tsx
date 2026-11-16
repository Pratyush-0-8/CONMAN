import { Avatar, Button, Card, Eyebrow, Icon, RatingBadge } from '../components/ui'
import { LeaderboardRow, MatchEntry } from '../components/lists'
import { type MatchRecord, type InputMode, type PlayerStats, gamesOf, rankFor, winRate } from '../lib/game'
import { useLeaderboard } from '../lib/board'
import type { Page } from '../components/Nav'

export function Home({ player, history, mode, setMode, onPlay, go, openMatch }: {
  player: PlayerStats; history: MatchRecord[]; mode: InputMode; setMode: (p: InputMode) => void
  onPlay: () => void; go: (p: Page) => void; openMatch: (m: MatchRecord) => void
}) {
  const { board, error: boardError } = useLeaderboard(player)
  const me = board.find((b) => b.me)
  const rank = player ? rankFor(player.elo) : null
  return (
    <div className="mx-auto max-w-6xl px-4 pb-28 sm:px-6 md:pb-16">
      {/* Hero */}
      <section className="relative pt-14 text-center sm:pt-24">
        <div className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[520px] bg-grid" />
        <div className="pointer-events-none absolute left-1/2 top-10 -z-10 size-[520px] -translate-x-1/2 rounded-full bg-accent/10 blur-[120px]" />
        <svg className="pointer-events-none absolute left-1/2 top-4 -z-10 -translate-x-1/2 opacity-[0.07]" width="720" height="360" viewBox="0 0 32 16" fill="none"><circle cx="12" cy="8" r="7.5" stroke="#fff" strokeWidth=".15" /><circle cx="20" cy="8" r="7.5" stroke="#fff" strokeWidth=".15" /></svg>
        <div className="animate-fade-up inline-flex items-center gap-2 rounded-full border border-line bg-card/70 px-3.5 py-1.5 text-xs text-mute"><span className="size-1.5 animate-blink rounded-full bg-win" />Ranked 1v1 · Season 1 open</div>
        <h1 className="animate-fade-up mx-auto mt-6 max-w-3xl text-5xl font-semibold leading-[1.02] tracking-tight [animation-delay:80ms] sm:text-7xl">Think fast.<br /><span className="text-accent">Speak sharper.</span></h1>
        <p className="animate-fade-up mx-auto mt-5 max-w-lg text-base text-mute [animation-delay:160ms] sm:text-lg">One strange question. Voice or typing. Out-reason a rival in real time and climb the ranks.</p>
        <div className="animate-fade-up mt-10 flex flex-col items-center [animation-delay:240ms]">
          <div aria-label="Input mode" className="mb-4 flex rounded-xl border border-line bg-card p-1">{(['voice','typing'] as InputMode[]).map((value) => <button key={value} onClick={() => setMode(value)} aria-pressed={mode === value} className={`rounded-lg px-5 py-2 text-sm capitalize ${mode === value ? 'bg-accent text-white' : 'text-mute'}`}>{value}</button>)}</div>
          {(
            <>
              <button onClick={onPlay} className="group relative inline-flex h-20 items-center gap-4 rounded-2xl bg-accent px-12 text-xl font-semibold text-white shadow-[0_20px_60px_-12px_rgba(99,139,255,0.8)] transition-all hover:-translate-y-1 hover:bg-[#7a9cff] active:scale-[0.98] max-sm:w-full max-sm:justify-center">
                <span className="absolute inset-0 -z-10 animate-ping-slow rounded-2xl bg-accent/30" />
                <Icon name="bolt" size={24} />Find Match<Icon name="arrow" className="transition-transform group-hover:translate-x-1" />
              </button>
              <div className="mt-4 text-sm text-mute">Playing as <b className="font-medium text-ink">{player.name}</b> · <span className="tabular">{player.elo}</span> ELO</div>
            </>
          )}
        </div>
      </section>

      {/* Dashboard */}
      <section className="mt-16 grid gap-5 lg:grid-cols-3 lg:mt-24">
        <Card className="p-6">
          {player && rank ? (
            <>
              <div className="flex items-center gap-4"><Avatar name={player.name} size={60} />
                <div><div className="text-lg font-semibold">{player.name}</div><div className="mt-0.5 flex items-center gap-2 text-sm" style={{ color: rank.color }}>{rank.name}{me && <span className="text-mute">· Global #{me.rank}</span>}</div></div></div>
              <div className="mt-6 flex items-end justify-between"><div><Eyebrow>Rating</Eyebrow><div className="text-5xl font-semibold tabular">{player.elo}</div></div><RatingBadge elo={player.elo} /></div>
              <div className="mt-6 grid grid-cols-4 gap-2 border-t border-line pt-5 text-center">
                {[['Wins', player.wins, 'text-win'], ['Losses', player.losses, 'text-lose'], ['Draws', player.draws, ''], ['Win rate', `${winRate(player)}%`, '']].map(([l, v, c]) => (
                  <div key={l as string}><div className={`text-xl font-semibold tabular ${c}`}>{v}</div><div className="mt-0.5 text-[11px] text-mute">{l}</div></div>))}
              </div>
              <Button variant="ghost" size="sm" className="mt-4 w-full" onClick={() => go('profile')}>View profile</Button>
            </>
          ) : (
            <div className="grid h-full min-h-60 place-items-center text-center"><div><div className="mx-auto mb-3 grid size-12 place-items-center rounded-xl bg-card2 text-mute"><Icon name="user" /></div><div className="font-medium">Your player card</div><p className="mt-1 text-sm text-mute">Pick a username to start at 500 ELO.</p></div></div>
          )}
        </Card>

        <Card className="relative overflow-hidden p-6 lg:col-span-2">
          <div className="pointer-events-none absolute -right-16 -top-16 size-64 rounded-full bg-accent/10 blur-3xl" />
          <div className="flex items-start justify-between"><div><Eyebrow className="!text-accent">Mode</Eyebrow><h3 className="mt-1 text-2xl font-semibold">Ranked 1v1</h3><p className="mt-1 max-w-sm text-sm text-mute">Same question for both players. Judged on five dimensions of reasoning. ELO on the line.</p></div><Icon name="trophy" size={28} className="text-accent" /></div>
          <div className="mt-6 grid grid-cols-3 gap-3">
            {[['5s', 'Think', '#638BFF'], [mode === 'voice' ? '15s' : '20s', mode === 'voice' ? 'Speak' : 'Type', '#F07878'], ['5', 'Criteria', '#38C994']].map(([n, l, c]) => (
              <div key={l} className="rounded-xl border border-line bg-card2/60 p-4"><div className="text-2xl font-semibold tabular" style={{ color: c }}>{n}</div><div className="text-xs text-mute">{l}</div></div>))}
          </div>
          <p className="mt-6 border-t border-line pt-4 text-xs text-mute">Voice and Typing share one ranked pool and ELO.</p>
        </Card>

        <Card className="p-3 lg:col-span-2">
          <div className="flex items-center justify-between px-3 pb-1 pt-3"><Eyebrow>Recent matches</Eyebrow><button onClick={() => go('history')} className="text-xs text-accent hover:underline">View all</button></div>
          {history.length ? history.slice(0, 4).map((m) => <MatchEntry key={m.id} m={m} onClick={() => openMatch(m)} />) :
            <div className="px-4 py-12 text-center text-sm text-mute">No matches yet. Your first one is a click away.</div>}
        </Card>

        <Card className="p-3">
          <div className="flex items-center justify-between px-3 pb-2 pt-3"><Eyebrow>Top players</Eyebrow><button onClick={() => go('leaderboard')} className="text-xs text-accent hover:underline">Leaderboard</button></div>
          {boardError && <p role="alert" className="p-3 text-sm text-mute">{boardError}</p>}
          {board.slice(0, 5).map((p) => <LeaderboardRow key={p.name} p={p} compact />)}
          {me && me.rank > 5 && <><div className="px-3 py-1 text-center text-mute">···</div><LeaderboardRow p={me} compact /></>}
        </Card>
      </section>
      <p className="mt-10 text-center text-xs text-mute/70">{player ? gamesOf(player) : 0} matches played</p>
    </div>
  )
}
