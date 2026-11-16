import { useState } from 'react'
import { Avatar, Button, Card, Eyebrow, RatingBadge } from '../components/ui'
import { Delta, LeaderboardRow, MatchEntry, TrendChart } from '../components/lists'
import { type MatchRecord, type PlayerStats, gamesOf, rankFor, winRate } from '../lib/game'
import { buildBoard } from '../lib/board'

const Title = ({ t, s }: { t: string; s: string }) => (
  <div className="mb-8 animate-fade-up"><h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t}</h1><p className="mt-1.5 text-mute">{s}</p></div>
)
const wrap = 'mx-auto max-w-4xl px-4 pb-28 pt-10 sm:px-6 sm:pt-14 md:pb-16'

export function Leaderboard({ player }: { player: PlayerStats | null }) {
  const board = buildBoard(player)
  return (
    <div className={wrap}>
      <Title t="Global leaderboard" s="Season 1 · Ranked 1v1 · mock data" />
      <Card className="p-2 sm:p-3">
        <div className="hidden grid-cols-[3rem_1fr_6rem_7rem_5rem] gap-3 px-3 pb-2 pt-2 text-[11px] uppercase tracking-wider text-mute sm:grid">
          <span className="text-center">#</span><span>Player</span><span className="text-right">Record</span><span /><span className="text-right">Win rate</span>
        </div>
        <div className="space-y-1">{board.map((p) => <LeaderboardRow key={p.name} p={p} />)}</div>
      </Card>
    </div>
  )
}

export function History({ history, player, open }: { history: MatchRecord[]; player: PlayerStats | null; open: (m: MatchRecord) => void }) {
  const [f, setF] = useState<'all' | 'win' | 'loss' | 'draw'>('all')
  const list = history.filter((m) => f === 'all' || m.outcome === f)
  return (
    <div className={wrap}>
      <Title t="Match history" s="Select a match to review transcripts and judging." />
      <div className="mb-4 flex gap-2 overflow-x-auto">
        {(['all', 'win', 'loss', 'draw'] as const).map((k) => <button key={k} onClick={() => setF(k)} className={`rounded-lg border px-3.5 py-1.5 text-sm capitalize transition-colors ${f === k ? 'border-accent/50 bg-accent/10 text-ink' : 'border-line text-mute hover:text-ink'}`}>{k === 'all' ? 'All' : k === 'win' ? 'Victories' : k === 'loss' ? 'Defeats' : 'Draws'}</button>)}
      </div>
      <Card className="p-2">
        {list.length ? list.map((m) => <MatchEntry key={m.id} m={m} onClick={() => open(m)} />) :
          <div className="px-6 py-16 text-center text-mute">{player && !history.length ? 'No matches yet. Play your first ranked match to see it here.' : 'No matches in this filter.'}</div>}
      </Card>
    </div>
  )
}

export function Profile({ player, history, open, onPlay }: { player: PlayerStats | null; history: MatchRecord[]; open: (m: MatchRecord) => void; onPlay: () => void }) {
  if (!player) return <div className={wrap}><Title t="Profile" s="Create a username on the home screen to get started." /></div>
  const r = rankFor(player.elo)
  const board = buildBoard(player)
  const rank = board.find((b) => b.me)!.rank
  const asc = [...history].reverse().slice(-12)
  const pts = asc.length ? [asc[0].eloBefore, ...asc.map((m) => m.eloAfter)] : []
  const net = pts.length ? pts[pts.length - 1] - pts[0] : 0
  const decided = player.wins + player.losses
  return (
    <div className={wrap}>
      <Card className="animate-fade-up flex flex-col items-start gap-5 p-6 sm:flex-row sm:items-center sm:p-8">
        <Avatar name={player.name} size={88} ring={r.color} />
        <div className="flex-1"><h1 className="text-3xl font-semibold tracking-tight">{player.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-3"><RatingBadge elo={player.elo} showRank /><span className="text-sm text-mute">Global #{rank}</span></div></div>
        <Button variant="primary" onClick={onPlay}>Find Match</Button>
      </Card>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {[['ELO', player.elo, ''], ['Matches', gamesOf(player), ''], ['Record', `${player.wins}–${player.losses}${player.draws ? `–${player.draws}` : ''}`, ''], ['Win rate', `${winRate(player)}%`, decided ? 'text-win' : '']].map(([l, v, c]) => (
          <Card key={l as string} className="p-5"><Eyebrow>{l}</Eyebrow><div className={`mt-1.5 text-3xl font-semibold tabular ${c}`}>{v}</div></Card>))}
      </div>
      <Card className="mt-5 p-6">
        <div className="flex items-center justify-between"><Eyebrow>Rating trend · last {Math.max(asc.length, 0)} matches</Eyebrow>{pts.length > 1 && <Delta d={net} />}</div>
        <div className="mt-4"><TrendChart points={pts} /></div>
      </Card>
      <Card className="mt-5 p-2">
        <div className="px-3 pb-1 pt-3"><Eyebrow>Recent matches</Eyebrow></div>
        {history.length ? history.slice(0, 5).map((m) => <MatchEntry key={m.id} m={m} onClick={() => open(m)} />) : <div className="px-6 py-12 text-center text-sm text-mute">No matches yet.</div>}
      </Card>
    </div>
  )
}
