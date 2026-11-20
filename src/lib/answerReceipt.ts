// Keep an unresolved final across rerenders/refreshes so polling cannot hide a failed submission.
export interface AnswerReceipt {
  phase?: "draft" | "final";
  revision?: number;
  text: string;
  confirmed: boolean;
  error?: string;
}
const receipts = new Map<string, AnswerReceipt>();
const listeners = new Map<string, Set<() => void>>();
const prefix = "conman-final:";
export function readReceipt(key: string): AnswerReceipt | null {
  if (receipts.has(key)) return receipts.get(key)!;
  try {
    const raw = sessionStorage.getItem(prefix + key);
    if (raw) {
      const saved = JSON.parse(raw);
      if (typeof saved.text === "string" && typeof saved.confirmed === "boolean") {
        receipts.set(key, saved);
        return saved;
      }
    }
  } catch {
    /* Storage may be disabled; in-memory confirmation still works. */
  }
  return null;
}
export function writeReceipt(key: string, value: AnswerReceipt | null) {
  if (value) receipts.set(key, value);
  else receipts.delete(key);
  try {
    if (value) sessionStorage.setItem(prefix + key, JSON.stringify(value));
    else sessionStorage.removeItem(prefix + key);
  } catch {
    /* No credentials or server authority are stored here. */
  }
  listeners.get(key)?.forEach((fn) => fn());
}
export function reconcileReceipt(key: string, text: string, locked: boolean) {
  const saved = readReceipt(key);
  if (!saved || !locked) return;
  const confirmed = saved.text === text;
  const error = confirmed
    ? undefined
    : "Your final answer was not saved. The server locked a different draft. Review it before continuing.";
  if (saved.confirmed !== confirmed || saved.error !== error)
    writeReceipt(key, { ...saved, confirmed, error });
}
export function subscribeReceipt(key: string, fn: () => void) {
  const set = listeners.get(key) || new Set();
  set.add(fn);
  listeners.set(key, set);
  return () => {
    set.delete(fn);
    if (!set.size) listeners.delete(key);
  };
}
