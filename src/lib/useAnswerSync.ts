import { useCallback, useEffect, useRef, useState } from "react";
import { readReceipt, writeReceipt, reconcileReceipt } from "./answerReceipt";
import { validAnswer } from "./rankedRules";
import {
  openAnswerSession,
  saveAnswer,
  type AnswerSnapshot,
  type RankedPlayer,
} from "./matchService";

export interface AnswerTransport {
  open: typeof openAnswerSession;
  save: typeof saveAnswer;
}
const rankedTransport: AnswerTransport = { open: openAnswerSession, save: saveAnswer };

// One editor per participant; a refresh takes over using a compare-and-swap token.
// Drafts may be in flight when finalization starts. Higher revisions win on the server.
export function useAnswerSync(
  matchId: string,
  mine: RankedPlayer,
  roundStart: string,
  now: number,
  onRefresh: () => Promise<void>,
  transport: AnswerTransport = rankedTransport,
) {
  const receiptKey = `${matchId}:${mine.player_id}`;
  const recovery = useRef(readReceipt(receiptKey));
  const [writer] = useState(() => crypto.randomUUID());
  const [text, setText] = useState(mine.answer_text || "");
  const [ready, setReady] = useState(false),
    [done, setDone] = useState(!!mine.locked_at);
  const [submitting, setSubmitting] = useState(false),
    [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState(""),
    [superseded, setSuperseded] = useState(false);
  const latest = useRef(text),
    saved = useRef(text),
    revision = useRef(mine.answer_revision || 0);
  const transportRef = useRef(transport);
  transportRef.current = transport;
  const initialWriter = useRef(mine.answer_writer || null);
  const intent = useRef<{ text: string; revision: number } | null>(null);
  const alive = useRef(false),
    opened = useRef(false),
    lost = useRef(false),
    locked = useRef(!!mine.locked_at);
  const opening = useRef(false),
    draftBusy = useRef(false),
    finalBusy = useRef(false),
    acknowledged = useRef(0);
  const clock = useRef({
    offset: now - Date.now(),
    start: Date.parse(roundStart) + 5000,
    deadline: Date.parse(mine.deadline),
  });
  clock.current.offset = now - Date.now();
  const refresh = useRef(onRefresh);
  refresh.current = onRefresh;
  const observe = useCallback(
    (snapshot: AnswerSnapshot) => {
      if (!alive.current) return;
      if (snapshot.locked_at || snapshot.status === "locked") {
        reconcileReceipt(receiptKey, snapshot.answer_text, true);
        locked.current = true;
        setDone(true);
        if (snapshot.answer_text !== latest.current) {
          setError(
            "This round is locked. Your last synced answer was used; this tab has edits that were not submitted.",
          );
        } else setError("");
        void refresh.current();
      } else if (snapshot.status === "superseded" || snapshot.status === "stale") {
        const record = readReceipt(receiptKey);
        if (record)
          writeReceipt(receiptKey, {
            ...record,
            confirmed: false,
            error: "A newer editor owns this answer. Reload to confirm your final submission.",
          });
        lost.current = true;
        setSuperseded(true);
        setError(
          "This answer is open in a newer editor. Reload to continue from the saved answer.",
        );
      } else if (snapshot.status === "expired") {
        setError(
          "The answer deadline has passed. Only text received within the server time limit can be used.",
        );
        void refresh.current();
      }
    },
    [receiptKey],
  );
  const open = useCallback(async () => {
    if (opening.current || opened.current || lost.current || locked.current) return;
    opening.current = true;
    try {
      const snapshot = await transportRef.current.open(matchId, writer, initialWriter.current);
      if (!alive.current) return;
      if (snapshot.status === "ready") {
        revision.current = snapshot.revision;
        acknowledged.current = snapshot.revision;
        if (
          recovery.current &&
          recovery.current.revision !== undefined &&
          recovery.current.revision <= snapshot.revision
        ) {
          // A newer persisted revision wins over a stale tab cache.
          recovery.current = null;
          writeReceipt(receiptKey, null);
        }
        latest.current =
          recovery.current && !recovery.current.confirmed
            ? recovery.current.text
            : snapshot.answer_text;
        saved.current = snapshot.answer_text;
        setText(latest.current);
        opened.current = true;
        setReady(true);
        setError("");
      } else observe(snapshot);
    } catch (e) {
      if (alive.current)
        setError(e instanceof Error ? e.message : "Could not restore your saved answer. Retry.");
    } finally {
      opening.current = false;
    }
  }, [matchId, writer, observe]);
  const change = useCallback(
    (value: string) => {
      if (
        !opened.current ||
        lost.current ||
        locked.current ||
        intent.current ||
        !validAnswer(value)
      )
        return;
      if (
        mine.input_mode === "typing" &&
        Date.now() + clock.current.offset >= clock.current.deadline
      )
        return;
      // Update synchronously so submit/deadline callbacks see the last input event before React renders.
      latest.current = value;
      writeReceipt(receiptKey, {
        text: value,
        confirmed: false,
        phase: "draft",
        revision: revision.current + 1,
      });
      setText(value);
    },
    [mine.input_mode, receiptKey],
  );
  const draft = useCallback(async () => {
    const at = Date.now() + clock.current.offset;
    if (
      !opened.current ||
      lost.current ||
      locked.current ||
      intent.current ||
      draftBusy.current ||
      latest.current === saved.current ||
      at < clock.current.start ||
      at >= clock.current.deadline
    )
      return;
    const value = latest.current,
      version = ++revision.current;
    draftBusy.current = true;
    try {
      const snapshot = await transportRef.current.save(matchId, value, false, version, writer);
      if (!alive.current) return;
      if (snapshot.status === "saved" && version >= acknowledged.current) {
        acknowledged.current = version;
        saved.current = value;
        if (!intent.current) setError("");
      } else if (!intent.current || snapshot.locked_at) observe(snapshot);
    } catch (e) {
      // A late autosave response must not replace a final submission's status/error.
      if (alive.current && !intent.current && !locked.current && !lost.current)
        setError(e instanceof Error ? e.message : "Could not save your draft. Reconnecting…");
    } finally {
      draftBusy.current = false;
    }
  }, [matchId, writer, observe]);
  const submit = useCallback(
    async (value = latest.current) => {
      if (!opened.current || lost.current || locked.current || finalBusy.current) return;
      if (!intent.current) {
        latest.current = value;
        setText(value);
        intent.current = { text: value, revision: ++revision.current };
        writeReceipt(receiptKey, {
          text: value,
          confirmed: false,
          phase: "final",
          revision: intent.current.revision,
        });
        setFinalizing(true);
      }
      const request = intent.current;
      finalBusy.current = true;
      setSubmitting(true);
      setError("");
      try {
        // Send immediately; do not wait behind an autosave or a timed-out request.
        const snapshot = await transportRef.current.save(
          matchId,
          request.text,
          true,
          request.revision,
          writer,
        );
        if (snapshot.answer_text !== request.text || !snapshot.locked_at) {
          if (snapshot.status !== "stale" && snapshot.status !== "superseded")
            throw new Error(
              "Your final answer was not saved. The round is locked with the last received draft. Check the submitted text before continuing.",
            );
        }
        reconcileReceipt(receiptKey, snapshot.answer_text, !!snapshot.locked_at);
        if (alive.current) observe(snapshot);
      } catch (e) {
        const record = readReceipt(receiptKey);
        if (record && !record.confirmed)
          writeReceipt(receiptKey, {
            ...record,
            error: e instanceof Error ? e.message : "Final answer could not be confirmed.",
          });
        if (alive.current && !locked.current)
          setError(e instanceof Error ? e.message : "Answer could not be sent. Retry.");
      } finally {
        finalBusy.current = false;
        if (alive.current) setSubmitting(false);
      }
    },
    [matchId, writer, observe, receiptKey],
  );
  useEffect(() => {
    if (
      ready &&
      recovery.current &&
      recovery.current.phase !== "draft" &&
      !recovery.current.confirmed &&
      !intent.current
    )
      void submit(recovery.current.text);
  }, [ready, submit]);
  const retry = useCallback(async () => {
    if (lost.current) return;
    if (!opened.current) await open();
    else if (intent.current) await submit();
    else await draft();
  }, [open, submit, draft]);
  useEffect(() => {
    alive.current = true;
    void open();
    const timer = setInterval(() => {
      void draft();
    }, 250);
    const reconnect = () => {
      void retry();
    };
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    return () => {
      alive.current = false;
      clearInterval(timer);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
    };
  }, [open, draft, retry]);
  useEffect(() => {
    if (mine.locked_at)
      observe({
        status: "locked",
        answer_text: mine.answer_text || "",
        revision: mine.answer_revision || 0,
        writer_id: mine.answer_writer || null,
        locked_at: mine.locked_at,
        server_now: "",
      });
  }, [mine.locked_at, mine.answer_text, mine.answer_revision, mine.answer_writer, observe]);
  return { text, change, ready, done, finalizing, submitting, superseded, error, submit, retry };
}
