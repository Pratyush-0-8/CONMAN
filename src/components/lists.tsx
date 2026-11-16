import { type MatchRecord, type Outcome, dateTime, rankFor, timeAgo } from '../lib/game'
import { Avatar, Dialog, Eyebrow, Icon, RatingBadge } from './ui'
import { Breakdown, Transcripts } from './game'

export const OUT = {
  win: { label: 'Victory', c: 'text-win', bg: 'bg-win/10 border-win/25' },
  loss: { label: 'Defeat', c: 'text-lose', bg: 'bg-lose/10 border-lose/25' },
  draw: { label: 'Draw', c: 'text-mute', bg: 'bg-white/5 border-line' },
} as Record<Outcome, { label: string; c: string; bg: string }>

export function OutcomePill({ o }: { o: Outcome }) {
  return <span className={`inline-flex rounded-md border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${OUT[o].bg} ${OUT[o].c}`}>{OUT[o].label}</span>
}
export const Delta = ({ d, className = '' }: { d: number; className?: string }) => (
  <span className={`tabular font-semibold ${d > 0 ? 'text-win' : d < 0 ? 'text-lose' : 'text-mute'} ${className}`}>{d > 0 ? '+' : d < 0 ? '−' : '±'}{Math.abs(d)}</span>
)

export function MatchEntry({ m, onClick, showQuestion = true }: { m: MatchRecord; onClick: () => void; showQuestion?: boolean }) {
  return (
    <button onClick={onClick} className="group flex w-full items-center gap-4 rounded-xl border border-transparent px-3 py-3.5 text-left transition-colors hover:border-line hover:bg-card2/60">
      <div className={`h-10 w-1 shrink-0 rounded-full ${m.outcome === 'win' ? 'bg-win' : m.outcome === 'loss' ? 'bg-lose' : 'bg-mute'}`} />
      <Avatar name={m.opponent} size={38} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span className="text-sm font-medium">vs {m.opponent}</span><span className="text-[11px] capitalize text-mute">{m.myMode} vs {m.oppMode}</span><OutcomePill o={m.outcome} />
        </div>
        {showQuestion ? <div className="mt-1 truncate font-serif text-[15px] text-mute">{m.question}</div> : <div className="mt-1 text-xs text-mute">{dateTime(m.at)}</div>}
      </div>
      <div className="text-right">
        <Delta d={m.delta} className="text-lg" />
        <div className="text-[11px] text-mute">{showQuestion ? dateTime(m.at) : timeAgo(m.at)}</div>
      </div>
      <Icon name="chev" className="-rotate-90 text-mute opacity-0 transition-opacity group-hover:opacity-100 max-sm:hidden" />
    </button>
  )
}

export function MatchDetailDialog({ m, me, onClose }: { m: MatchRecord | null; me: string; onClose: () => void }) {
  return (
    <Dialog open={!!m} onClose={onClose} title="Match details">
      {m && (
        <div>
          <div className="flex items-center gap-3"><OutcomePill o={m.outcome} /><span className="text-sm text-mute">{dateTime(m.at)}</span></div>
          <h3 className="mt-4 max-w-xl font-serif text-2xl leading-tight sm:text-3xl">{m.question}</h3>
          <div className="mt-5 flex flex-wrap items-center gap-4 rounded-xl border border-line bg-card2/50 p-4 text-sm">
            <span className="font-medium">{me} · {m.myMode}</span>
            <span className="text-mute">vs</span>
            <span className="font-medium">{m.opponent} · {m.oppMode}</span><RatingBadge elo={m.opponentElo} />
            <span className="ml-auto flex items-center gap-2 tabular text-mute">{m.eloBefore} → {m.eloAfter} <Delta d={m.delta} /></span>
          </div>
          <div className="mt-6 flex items-center gap-2"><Eyebrow>Decisive category</Eyebrow><span className="rounded-md bg-accent/15 px-2 py-0.5 text-xs font-semibold uppercase tracking-wider text-accent">{m.key}</span></div>
          <div className="mt-3"><Breakdown mine={m.mine} theirs={m.theirs} myName={me} oppName={m.opponent} /></div>
          <Eyebrow className="mb-3 mt-8">Transcripts</Eyebrow>
          <Transcripts myName={me} oppName={m.opponent} myText={m.myText} oppText={m.oppText} />
        </div>
      )}
    </Dialog>
  )
}

/* ---------- Leaderboard row ---------- */
const PODIUM = ['#E8C06A', '#C3CAD8', '#C98B5E']
export interface LbEntry { name: string; elo: number; wins: number; losses: number; draws?: number; rank: number; me?: boolean }
export function LeaderboardRow({ p, compact }: { p: LbEntry; compact?: boolean }) {
  const g = p.wins + p.losses + (p.draws || 0)
  const wr = g ? Math.round((p.wins / g) * 100) : 0
  const pod = p.rank <= 3 ? PODIUM[p.rank - 1] : null
  return (
    <div className={`grid items-center gap-3 rounded-xl px-3 py-2.5 ${compact ? 'grid-cols-[2rem_1fr_auto]' : 'grid-cols-[2.25rem_1fr_auto] sm:grid-cols-[3rem_1fr_6rem_7rem_5rem]'} ${p.me ? 'border border-accent/40 bg-accent/10' : pod ? 'bg-card2/50' : ''}`} style={pod && !p.me ? { boxShadow: `inset 3px 0 0 ${pod}` } : undefined}>
      <div className="text-center tabular font-semibold" style={{ color: pod ?? '#9299A8' }}>{pod ? <Icon name="crown" size={18} className="mx-auto" /> : p.rank}</div>
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={p.name} size={compact ? 32 : 38} ring={pod ?? undefined} />
        <div className="min-w-0"><div className="truncate text-sm font-medium">{p.name}{p.me && <span className="ml-2 rounded bg-accent px-1.5 py-0.5 align-middle text-[10px] font-semibold text-white">YOU</span>}</div>
          {!compact && <div className="text-[11px] text-mute sm:hidden">{p.wins}W {p.losses}L · {wr}%</div>}</div>
      </div>
      {!compact && <div className="hidden text-right text-sm tabular text-mute sm:block">{p.wins}W – {p.losses}L{p.draws ? ` – ${p.draws}D` : ''}</div>}
      {!compact && <div className="hidden sm:block"><div className="ml-auto h-1.5 w-20 overflow-hidden rounded-full bg-line"><div className="h-full bg-win/80" style={{ width: `${wr}%` }} /></div></div>}
      {!compact && <div className="hidden text-right text-sm tabular sm:block">{wr}%</div>}
      <div className="text-right"><div className="font-semibold tabular">{p.elo}</div>{!compact && <div className="text-[11px] text-mute sm:hidden">{rankFor(p.elo).name}</div>}</div>
    </div>
  )
}

/* ---------- Trend chart ---------- */
export function TrendChart({ points }: { points: number[] }) {
  if (points.length < 2) return <div className="grid h-44 place-items-center text-sm text-mute">Play a match to start your rating trend.</div>
  const W = 600, H = 180, pad = 14
  const min = Math.min(...points) - 15, max = Math.max(...points) + 15
  const xy = points.map((v, i) => [pad + (i / (points.length - 1)) * (W - pad * 2), H - pad - ((v - min) / (max - min)) * (H - pad * 2)])
  const line = xy.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ')
  const last = xy[xy.length - 1]
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-44 w-full" preserveAspectRatio="none" role="img" aria-label="Rating trend">
      <defs><linearGradient id="tg" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#638BFF" stopOpacity=".3" /><stop offset="1" stopColor="#638BFF" stopOpacity="0" /></linearGradient></defs>
      {[0.25, 0.5, 0.75].map((f) => <line key={f} x1="0" x2={W} y1={H * f} y2={H * f} stroke="#242A3A" strokeDasharray="3 5" />)}
      <path d={`${line} L${last[0]} ${H} L${xy[0][0]} ${H}Z`} fill="url(#tg)" />
      <path d={line} fill="none" stroke="#638BFF" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}
