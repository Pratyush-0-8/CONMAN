import type { InputMode } from './game'

export function inputDeadline(roundStart: number, mode: InputMode) { return roundStart + 5000 + (mode === 'voice' ? 15000 : 20000) }
export function roundPhase(now: number, roundStart: number, mode: InputMode, locked = false) {
  if (locked) return 'waiting'
  if (now < roundStart) return 'matched'
  if (now < roundStart + 5000) return 'think'
  return now < inputDeadline(roundStart, mode) ? 'input' : 'waiting'
}
export function acceptsAppend(previous: string, next: string) { return next.length <= 12000 && next.startsWith(previous) }
