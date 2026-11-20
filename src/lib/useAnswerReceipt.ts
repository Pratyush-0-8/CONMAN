import { useEffect, useState } from "react";
import { readReceipt, reconcileReceipt, subscribeReceipt } from "./answerReceipt";
export function useAnswerReceipt(key: string, text?: string | null, locked = false) {
  const [, render] = useState(0);
  useEffect(() => subscribeReceipt(key, () => render((n) => n + 1)), [key]);
  useEffect(() => {
    if (typeof text === "string") reconcileReceipt(key, text, locked);
  }, [key, text, locked]);
  return readReceipt(key);
}
