import { requestMicrophone } from "../lib/speech";
import { useState } from "react";
import { Avatar, Banner, Button, Card } from "./ui";
import type { InputMode } from "../lib/game";
import { respondChallenge, type Invitation } from "../lib/socialService";

export function InputChoice({
  mode,
  setMode,
}: {
  mode: InputMode;
  setMode: (mode: InputMode) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm text-mute">
      Answer with
      <select
        aria-label="Challenge answer mode"
        value={mode}
        onChange={(e) => setMode(e.target.value as InputMode)}
        className="rounded-lg border border-line bg-card2 px-3 py-2 text-ink"
      >
        <option value="typing">Typing</option>
        <option value="voice">Voice</option>
      </select>
    </label>
  );
}
export function Invitations({
  invitations,
  userId,
  now,
  available,
  onUpdate,
  compact = false,
}: {
  invitations: Invitation[];
  userId: string;
  now: number;
  available: boolean;
  onUpdate: () => Promise<void>;
  compact?: boolean;
}) {
  const [mode, setMode] = useState<InputMode>("typing");
  const [busy, setBusy] = useState(""),
    [error, setError] = useState("");
  const [dismissed, setDismissed] = useState<string[]>([]);
  const statusOf = (i: Invitation) =>
    i.status === "pending" && Date.parse(i.expires_at) <= now ? "expired" : i.status;
  const visible = compact
    ? invitations.filter((i) => {
        const status = statusOf(i);
        return (
          status === "pending" ||
          (status !== "accepted" &&
            Date.parse(i.created_at) > now - 120000 &&
            !dismissed.includes(`${i.id}:${status}`))
        );
      })
    : invitations.slice(0, 10);
  const act = async (i: Invitation, action: "accept" | "decline" | "cancel") => {
    setBusy(i.id);
    setError("");
    try {
      if (action === "accept" && mode === "voice") {
        await requestMicrophone();
      }
      await respondChallenge(i.id, action, mode);
      await onUpdate();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not respond. Retry.");
    } finally {
      setBusy("");
    }
  };
  if (!visible.length)
    return compact ? null : (
      <p className="text-sm text-mute">No invitations yet. Challenge an available friend.</p>
    );
  return (
    <div aria-live="polite" className="space-y-3">
      {error && (
        <Banner tone="error" title="Invitation failed">
          {error}
        </Banner>
      )}
      {visible.map((i) => {
        const incoming = i.recipient_id === userId;
        const status = statusOf(i);
        return (
          <Card key={i.id} className="p-4 shadow-lg">
            {compact && status !== "pending" && (
              <Button
                size="sm"
                variant="ghost"
                className="float-right"
                aria-label="Dismiss invitation status"
                onClick={() => setDismissed((previous) => [...previous, `${i.id}:${status}`])}
              >
                Dismiss
              </Button>
            )}
            <div className="flex items-center gap-3">
              <Avatar name={incoming ? i.sender_name : i.recipient_name} size={34} />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-semibold">
                  {incoming
                    ? `${i.sender_name} challenged you`
                    : `Invitation to ${i.recipient_name}`}
                </p>
                <p className="mt-1 text-xs text-mute">
                  Unranked Arena ·{" "}
                  {status === "pending"
                    ? `Expires in ${Math.max(0, Math.ceil((Date.parse(i.expires_at) - now) / 1000))}s`
                    : status}
                </p>
              </div>
            </div>
            {status === "pending" && (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {incoming ? (
                  <>
                    <InputChoice mode={mode} setMode={setMode} />
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={!!busy || !available}
                      onClick={() => {
                        void act(i, "accept");
                      }}
                    >
                      Accept
                    </Button>
                    <Button
                      size="sm"
                      disabled={!!busy}
                      onClick={() => {
                        void act(i, "decline");
                      }}
                    >
                      Decline
                    </Button>
                    {!available && (
                      <p className="text-xs text-mute">
                        Leave matchmaking or finish your match to accept.
                      </p>
                    )}
                  </>
                ) : (
                  <Button
                    size="sm"
                    disabled={!!busy}
                    onClick={() => {
                      void act(i, "cancel");
                    }}
                  >
                    Cancel invitation
                  </Button>
                )}
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}
