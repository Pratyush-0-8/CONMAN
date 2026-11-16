export const CATS = ['Logic', 'Creativity', 'Relevance', 'Clarity', 'Depth'] as const
export type Cat = (typeof CATS)[number]
export type Scores = Record<Cat, number>
export type Outcome = 'win' | 'loss' | 'draw'

export interface PlayerStats { name: string; elo: number; wins: number; losses: number; draws: number }
export interface Opponent { name: string; elo: number; wins: number; losses: number; simulated: boolean }
export interface MatchRecord {
  id: string
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

const rnd = (a: number, b: number) => Math.round((a + Math.random() * (b - a)) * 10) / 10
const clamp = (n: number) => Math.min(9.9, Math.max(2, Math.round(n * 10) / 10))

export function genScores(outcome: Outcome) {
  const base = {} as Scores
  CATS.forEach((c) => (base[c] = rnd(4.5, 7.2)))
  const other = {} as Scores
  CATS.forEach((c) => (other[c] = clamp(base[c] + rnd(-0.8, 0.8))))
  let a = base, b = other
  if (outcome === 'draw') {
    // same total, different shape: swap two categories' values
    b = { ...base, Logic: base.Creativity, Creativity: base.Logic, Depth: base.Clarity, Clarity: base.Depth }
  } else {
    const k = CATS[Math.floor(Math.random() * CATS.length)]
    b = { ...other, [k]: clamp(base[k] + rnd(1.8, 2.6)) }
    while (total(b) - total(a) < 1.2) { const c = CATS[Math.floor(Math.random() * 5)]; b[c] = clamp(b[c] + 0.4) }
  }
  // a = loser/neutral, b = winner/neutral
  const mine = outcome === 'win' ? b : a
  const theirs = outcome === 'win' ? a : outcome === 'loss' ? b : b
  return { mine, theirs, key: decisiveKey(mine, theirs, outcome) }
}

export function decisiveKey(mine: Scores, theirs: Scores, outcome: Outcome) {
  if (outcome === 'draw') return 'Balanced'
  return [...CATS].sort((x, y) => Math.abs(mine[y] - theirs[y]) - Math.abs(mine[x] - theirs[x]))[0]
}

export function pickOutcome(pref: Outcome | 'random'): Outcome {
  if (pref !== 'random') return pref
  const r = Math.random()
  return r < 0.5 ? 'win' : r < 0.9 ? 'loss' : 'draw'
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
