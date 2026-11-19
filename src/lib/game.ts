export const CATS = ['Logic', 'Creativity', 'Relevance', 'Clarity', 'Depth'] as const
export type Cat = (typeof CATS)[number]
export type Scores = Record<Cat, number>
export type Outcome = 'win' | 'loss' | 'draw'
export type InputMode = 'voice' | 'typing'

export interface PlayerStats { id?: string; name: string; elo: number; wins: number; losses: number; draws: number }
export interface Opponent { name: string; elo: number; wins: number; losses: number; mode?: InputMode }
export interface MatchRecord {
  ranked?: boolean
  id: string
  myMode: InputMode
  oppMode: InputMode
  opponent: string
  opponentElo: number
  outcome: Outcome
  delta: number
  eloBefore: number
  eloAfter: number
  at: number
  question: string
  myText: string
  oppText: string
  mine: Scores
  theirs: Scores
  key: string
}

export const START_ELO = 500
export const total = (s: Scores) => CATS.reduce((a, c) => a + s[c], 0)
export const fmt = (n: number) => n.toFixed(1)

const TIERS = [
  { min: 0, name: 'Novice', color: '#9299A8' },
  { min: 600, name: 'Apprentice', color: '#7FB6A6' },
  { min: 900, name: 'Analyst', color: '#638BFF' },
  { min: 1200, name: 'Strategist', color: '#A98BFF' },
  { min: 1500, name: 'Sage', color: '#E8C06A' },
]
export const rankFor = (elo: number) => [...TIERS].reverse().find((t) => elo >= t.min)!

export const gamesOf = (p: { wins: number; losses: number; draws: number }) => p.wins + p.losses + p.draws
export const winRate = (p: { wins: number; losses: number; draws: number }) =>
  gamesOf(p) ? Math.round((p.wins / gamesOf(p)) * 100) : 0

export function eloDelta(me: number, opp: number, outcome: Outcome) {
  const exp = 1 / (1 + 10 ** ((opp - me) / 400))
  const s = outcome === 'win' ? 1 : outcome === 'draw' ? 0.5 : 0
  return Math.round(32 * (s - exp))
}

export function decisiveKey(mine: Scores, theirs: Scores, outcome: Outcome) {
  if (outcome === 'draw') return 'Balanced'
  return [...CATS].sort((x, y) => Math.abs(mine[y] - theirs[y]) - Math.abs(mine[x] - theirs[x]))[0]
}

export function timeAgo(ts: number) {
  const m = Math.round((Date.now() - ts) / 60000)
  if (m < 1) return 'Just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}
export const dateTime = (ts: number) =>
  new Date(ts).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
