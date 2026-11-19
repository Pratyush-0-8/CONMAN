import { useCallback, useEffect, useRef, useState } from "react";
import { getInvitations, heartbeat, subscribeSocial, type Invitation } from "./socialService";

export function useSocial(
  userId: string | undefined,
  available: boolean,
  onMatch: () => Promise<void>,
) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(Date.now());
  const refreshRef = useRef<() => Promise<void>>(async () => {});
  const onMatchRef = useRef(onMatch);
  onMatchRef.current = onMatch;
  const availableRef = useRef(available);
  availableRef.current = available;
  const pulseRef = useRef<() => Promise<void>>(async () => {});
  const refresh = useCallback(() => refreshRef.current(), []);
  useEffect(() => {
    setInvitations([]);
    setError("");
    if (!userId) return;
    let alive = true,
      loading = false,
      offset = 0;
    const session = crypto.randomUUID();
    const restored = new Set<string>();
    const pulse = async () => {
      try {
        await heartbeat(session, availableRef.current && document.visibilityState === "visible");
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Presence unavailable");
      }
    };
    const update = async () => {
      if (!alive || loading) return;
      loading = true;
      try {
        const before = Date.now(),
          data = await getInvitations();
        if (!alive) return;
        offset = Date.parse(data.server_now) - (before + Date.now()) / 2;
        setInvitations(data.invitations);
        setNow(Date.now() + offset);
        setError("");
        // Arena restores the authoritative active membership, including after refresh or missed events.
        const accepted = data.invitations.filter(
          (i) => i.status === "accepted" && !restored.has(i.id),
        );
        if (accepted.length) {
          accepted.forEach((i) => restored.add(i.id));
          void onMatchRef.current();
        }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : "Invitations unavailable");
      } finally {
        loading = false;
      }
    };
    refreshRef.current = update;
    pulseRef.current = pulse;
    const reconnect = () => {
      void pulse();
      void update();
    };
    reconnect();
    const unsubscribe = subscribeSocial(userId, () => {
      void update();
    });
    const poll = setInterval(() => {
      void update();
    }, 5000);
    const presence = setInterval(() => {
      void pulse();
    }, 10000);
    const clock = setInterval(() => setNow(Date.now() + offset), 1000);
    document.addEventListener("visibilitychange", reconnect);
    window.addEventListener("online", reconnect);
    window.addEventListener("focus", reconnect);
    return () => {
      alive = false;
      refreshRef.current = async () => {};
      pulseRef.current = async () => {};
      clearInterval(poll);
      clearInterval(presence);
      clearInterval(clock);
      unsubscribe();
      document.removeEventListener("visibilitychange", reconnect);
      window.removeEventListener("online", reconnect);
      window.removeEventListener("focus", reconnect);
      void heartbeat(session, false).catch(() => {});
    };
  }, [userId]);
  useEffect(() => {
    void pulseRef.current();
  }, [available]);
  return { invitations, error, now, refresh };
}
