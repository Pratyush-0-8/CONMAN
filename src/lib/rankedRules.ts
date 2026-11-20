import type { InputMode } from "./game";

export const THINKING_SECONDS = 7;
export const TYPING_SECONDS = 25;
export const VOICE_SECONDS = 20;
export function inputDeadline(
  roundStart: number,
  mode: InputMode,
  thinkingSeconds = THINKING_SECONDS,
  answerSeconds = mode === "voice" ? VOICE_SECONDS : TYPING_SECONDS,
) {
  return roundStart + (thinkingSeconds + answerSeconds) * 1000;
}
export function roundPhase(
  now: number,
  roundStart: number,
  mode: InputMode,
  locked = false,
  thinkingSeconds = THINKING_SECONDS,
  answerSeconds = mode === "voice" ? VOICE_SECONDS : TYPING_SECONDS,
) {
  if (locked) return "waiting";
  if (now < roundStart) return "matched";
  if (now < roundStart + thinkingSeconds * 1000) return "think";
  return now < inputDeadline(roundStart, mode, thinkingSeconds, answerSeconds)
    ? "input"
    : "waiting";
}
// Old responses lack timing metadata. Preserve their five-second thinking phase during rollout.
export function savedRoundTiming(start: number, deadline: number, thinkingSeconds = 5) {
  return {
    thinkingSeconds,
    inputStart: start + thinkingSeconds * 1000,
    answerSeconds: Math.max(0, (deadline - start) / 1000 - thinkingSeconds),
  };
}
export function validAnswer(text: string) {
  return text.length <= 12000;
}
