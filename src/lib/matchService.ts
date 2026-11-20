import { type InputMode, type MatchRecord, type PlayerStats, type Scores } from './game'
import { supabase } from './supabase'

export interface RankedPlayer {
  player_id: string; username: string; elo?: number; wins?: number; losses?: number; input_mode: InputMode; deadline: string; locked_at: string | null
  answer_revision?: number; answer_writer?: string | null; answer_text?: string; scores: Scores | null; total: number | null; elo_before: number | null; elo_after: number | null; delta: number | null
}
export interface RankedMatch {
  is_ranked?: boolean; id: string; player1_id: string; player2_id: string; question: string
  state: 'active' | 'judge_pending' | 'judging' | 'judge_error' | 'complete'
  round_start: string; completed_at: string | null; players: RankedPlayer[]
  judge_error: string | null; judge_retry_at: string | null; judge_attempts: number
  result: { model: string; winner: 'player1' | 'player2' | 'draw'; decisiveCategory: string } | null
}
export interface RankedState {
  match: RankedMatch | null
  queue: { input_mode: InputMode; joined_at: string } | null
  server_now: string
  clockOffset: number
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}, timeout?: number): Promise<T> {
  const request = supabase.rpc(name, args)
  const { data, error } = await (timeout ? request.abortSignal(AbortSignal.timeout(timeout)) : request)
  if (error) throw new Error(error.message)
  return data as T
}
export async function getRankedState(): Promise<RankedState> {
  const before = Date.now()
  const state = await rpc<Omit<RankedState, 'clockOffset'>>('ranked_state')
  return { ...state, clockOffset: Date.parse(state.server_now) - (before + Date.now()) / 2 }
}
export async function requestJudgment(id: string) {
  const { error } = await supabase.functions.invoke('clever-action', { body: { matchId: id } })
  if (error) throw new Error('The judge is temporarily unavailable. Your answers are saved; retry judging.')
}
export async function loadSupabaseProfile(userId: string): Promise<PlayerStats> {
  const { data, error } = await supabase.from('profiles').select('id,username,elo,wins,losses,draws').eq('id', userId).single()
  if (error) throw new Error(error.message)
  return { id: data.id, name: data.username, elo: data.elo, wins: data.wins, losses: data.losses, draws: data.draws }
}
export function matchRecord(match: Pick<RankedMatch, 'id' | 'player1_id' | 'question' | 'players' | 'completed_at' | 'is_ranked'> & { result?: RankedMatch['result']; judge_result?: RankedMatch['result'] }, userId: string): MatchRecord {
  const mine = match.players.find((p) => p.player_id === userId)!
  const other = match.players.find((p) => p.player_id !== userId)!
  const result = match.result || match.judge_result!
  const outcome = result.winner === 'draw' ? 'draw' : ((match.player1_id === userId) === (result.winner === 'player1') ? 'win' : 'loss')
  return { ranked: match.is_ranked !== false, id: match.id, myMode: mine.input_mode, oppMode: other.input_mode, opponent: other.username, opponentElo: other.elo_before!, outcome,
    delta: mine.delta!, eloBefore: mine.elo_before!, eloAfter: mine.elo_after!, at: Date.parse(match.completed_at!), question: match.question,
    myText: mine.answer_text || '', oppText: other.answer_text || '', mine: mine.scores!, theirs: other.scores!, key: result.decisiveCategory }
}
export async function loadHistory(userId: string) {
  const matches = await rpc<Parameters<typeof matchRecord>[0][]>('ranked_history')
  return matches.map((match) => matchRecord(match, userId))
}
export function subscribeRanked(userId: string, refresh: () => void) {
  const channel = supabase.channel(`ranked:${userId}`)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ranked_players', filter: `player_id=eq.${userId}` }, refresh)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ranked_queue', filter: `player_id=eq.${userId}` }, refresh)
    .subscribe((status) => { if (status === 'SUBSCRIBED') refresh() })
  return () => { void supabase.removeChannel(channel) }
}

export interface AnswerSnapshot {
  status: 'ready' | 'saved' | 'locked' | 'stale' | 'superseded' | 'expired'
  final_answer_text?: string | null; final_revision?: number | null; answer_text: string; revision: number; writer_id: string | null; locked_at: string | null; server_now: string
}
export const openAnswerSession = (id: string, writer: string, previousWriter: string | null) => rpc<AnswerSnapshot>('ranked_begin_answer', { p_match: id, p_writer: writer, p_previous_writer: previousWriter }, 5000)
export const saveAnswer = (id: string, text: string, final: boolean, revision: number, writer: string) => rpc<AnswerSnapshot>('ranked_answer_v2', { p_match: id, p_text: text, p_final: final, p_revision: revision, p_writer: writer }, 5000)
export const queueMatch = (mode: InputMode, join = false) => rpc<string | null>('ranked_queue_match', { p_mode: mode, p_join: join })
export const cancelQueue = () => rpc<void>('ranked_cancel_queue')
export const releaseMatch = (id: string) => rpc<void>('ranked_release', { p_match: id })
