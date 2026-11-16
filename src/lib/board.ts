import { useEffect, useState } from 'react'
import type { PlayerStats } from './game'
import type { LbEntry } from '../components/lists'
import { supabase } from './supabase'

export function useLeaderboard(player: PlayerStats | null) {
  const [board, setBoard] = useState<LbEntry[]>([])
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void supabase.rpc('ranked_leaderboard').then(({ data, error }) => {
      if (!alive) return
      if (error) { setError('Could not load the leaderboard.'); return }
      setError('')
      setBoard((data || []).map((p: { id: string; username: string; elo: number; wins: number; losses: number; draws: number; rank: number }) => ({ name: p.username, elo: p.elo, wins: p.wins, losses: p.losses, draws: p.draws, rank: Number(p.rank), me: p.id === player?.id })))
    })
    return () => { alive = false }
  }, [player?.id, player?.elo])
  return { board, error }
}
