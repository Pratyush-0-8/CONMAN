import { useCallback, useEffect, useRef, useState } from 'react'
import type { MatchRecord, PlayerStats } from './game'
import { getRankedState, searchMatch, loadHistory, loadSupabaseProfile, requestJudgment, subscribeRanked, type RankedState } from './matchService'

export function useRankedGame(userId?: string) {
  const [player, setPlayer] = useState<PlayerStats | null>(null)
  const [history, setHistory] = useState<MatchRecord[]>([])
  const [state, setState] = useState<RankedState | null>(null)
  const [error, setError] = useState('')
  const [accountError, setAccountError] = useState('')
  const [judgeError, setJudgeError] = useState('')
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  const accountRef = useRef<() => Promise<void>>(async () => {})
  const refresh = useCallback(() => refreshRef.current(), [])
  const reloadAccount = useCallback(() => accountRef.current(), [])

  useEffect(() => {
    let alive = true, polling = false, lastCompleted = ''
    setPlayer(null); setHistory([]); setState(null); setError(''); setAccountError(''); setJudgeError('')
    if (!userId) { refreshRef.current = async () => {}; return }
    const account = async () => {
      try {
        const [profile, records] = await Promise.all([loadSupabaseProfile(userId), loadHistory(userId)])
        if (alive) { setPlayer(profile); setHistory(records); setAccountError('') }
      } catch (error) { if (alive) setAccountError(error instanceof Error ? error.message : 'Could not load your account.') }
    }
    accountRef.current = account
    const update = async () => {
      if (!alive || polling) return
      polling = true
      try {
        let next = await getRankedState()
        if (next.queue) { await searchMatch(next.queue.input_mode, next.queue.attempt_id); next = await getRankedState() }
        if (!alive) return
        setState(next); setError('')
        if (next.match?.state === 'complete' && next.match.id !== lastCompleted) { lastCompleted = next.match.id; void account() }
      } catch (error) { if (alive) setError(error instanceof Error ? error.message : 'Connection interrupted. Reconnecting…') }
      finally { polling = false }
    }
    refreshRef.current = update
    void account(); void update()
    const unsubscribe = subscribeRanked(userId, () => { void update() })
    const poll = setInterval(() => { void update() }, 1000)
    const reconnect = () => { void update() }
    window.addEventListener('online', reconnect); window.addEventListener('focus', reconnect)
    return () => { alive = false; clearInterval(poll); unsubscribe(); window.removeEventListener('online', reconnect); window.removeEventListener('focus', reconnect) }
  }, [userId])

  // Wake at the server's 20-second decision and final expiry, including after refresh.
  const queue = state?.queue
  useEffect(() => {
    if (!queue) return
    const at = queue.expires_at ? Date.parse(queue.expires_at) : Date.parse(queue.joined_at) + 20000
    const timer = setTimeout(() => { void refresh() }, Math.max(25, at - Date.now() - (state?.clockOffset || 0)))
    return () => clearTimeout(timer)
  }, [queue?.attempt_id, queue?.joined_at, queue?.expires_at, state?.clockOffset, refresh])

  const judgingRef = useRef(false)
  const judge = useCallback(async (matchId: string) => {
    if (judgingRef.current) return
    judgingRef.current = true; setJudgeError('')
    try { await requestJudgment(matchId) }
    catch (error) { setJudgeError(error instanceof Error ? error.message : 'Judging failed. Retry to continue.') }
    finally { judgingRef.current = false; await refreshRef.current() }
  }, [])
  // A crashed judge worker can be reclaimed after its server lease expires.
  const match = state?.match
  useEffect(() => {
    if (!match) return
    if (match.state === 'judge_pending') void judge(match.id)
    if (match.state === 'judging') {
      const id = setInterval(() => { void judge(match.id) }, 20000)
      return () => clearInterval(id)
    }
  }, [match?.id, match?.state, judge])

  return { player, history, state, error: accountError || error, judgeError, refresh, reloadAccount, judge }
}
