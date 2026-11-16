import { type PlayerStats } from './game'
import { LEADERBOARD } from './mock'
import type { LbEntry } from '../components/lists'

export function buildBoard(player: PlayerStats | null): LbEntry[] {
  const all = [...LEADERBOARD.map((p) => ({ ...p, me: false })), ...(player ? [{ name: player.name, elo: player.elo, wins: player.wins, losses: player.losses + player.draws, me: true }] : [])]
  return all.sort((a, b) => b.elo - a.elo).map((p, i) => ({ ...p, rank: i + 1 }))
}
