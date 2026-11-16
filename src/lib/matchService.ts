import { type MatchRecord, type Outcome, type PlayerStats, eloDelta, genScores, pickOutcome } from './game'
import { QUESTIONS, makeOpponent } from './mock'
import { supabase } from './supabase'

type Profile = { player: PlayerStats; history: MatchRecord[] }
const PROFILES = 'conman.profiles.v1'

// Local mock boundaries: replace profile/match calls with Supabase and evaluation with Gemini.
function readProfiles(): Record<string, Profile> {
  try { return JSON.parse(localStorage.getItem(PROFILES) || '{}') } catch { return {} }
}

export function loadProfile(userId: string) { return readProfiles()[userId] }
export async function loadSupabaseProfile(userId: string) {
  const { data, error } = await supabase
    .from('profiles')
    .select('username, elo, wins, losses')
    .eq('id', userId)
    .single()

  if (error) throw error

  return {
    name: data.username,
    elo: data.elo,
    wins: data.wins,
    losses: data.losses,
    draws: 0,
  }
}

export function saveProfile(userId: string, profile: Profile) {
  try { localStorage.setItem(PROFILES, JSON.stringify({ ...readProfiles(), [userId]: profile })) } catch { /* Keep the in-memory demo working when storage is unavailable. */ }
}

export function findMatch(elo: number, previousQuestion: number) {
  const questionIndex = (previousQuestion + 1 + Math.floor(Math.random() * (QUESTIONS.length - 1))) % QUESTIONS.length
  return { id: crypto.randomUUID(), opponent: makeOpponent(elo), questionIndex }
}

export function evaluateMatch(pref: Outcome | 'random') {
  const outcome = pickOutcome(pref)
  return { outcome, ...genScores(outcome) }
}

export function submitMatch({ id, player, opponent, questionIndex, text, pref }: ReturnType<typeof findMatch> & { player: PlayerStats; text: string; pref: Outcome | 'random' }): MatchRecord {
  const evaluation = evaluateMatch(pref)
  const delta = Math.max(-player.elo, eloDelta(player.elo, opponent.elo, evaluation.outcome))
  const question = QUESTIONS[questionIndex]
  return { id, opponent: opponent.name, opponentElo: opponent.elo, delta, eloBefore: player.elo, eloAfter: player.elo + delta, at: Date.now(), question: question.q, myText: text.trim() || 'No speech detected.', oppText: question.theirs, ...evaluation }
}
