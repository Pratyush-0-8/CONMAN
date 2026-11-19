import { requestMicrophone } from "../lib/speech";
import { useCallback, useEffect, useRef, useState } from "react";
import { Avatar, Banner, Button, Card, Eyebrow, RatingBadge, Spinner } from "../components/ui";
import { InputChoice, Invitations } from "../components/Social";
import type { InputMode } from "../lib/game";
import {
  followPlayer,
  getPlayers,
  getPublicPlayer,
  sendChallenge,
  setDisplayName,
  type PlayerView,
  type PublicPlayer,
} from "../lib/socialService";
import type { useSocial } from "../lib/useSocial";

export function Social({
  userId,
  profileId,
  openProfile,
  social,
  available,
  onMatch,
}: {
  userId?: string;
  profileId?: string;
  openProfile: (id?: string) => void;
  social: ReturnType<typeof useSocial>;
  available: boolean;
  onMatch: () => Promise<void>;
}) {
  const [view, setView] = useState<PlayerView>("friends"),
    [query, setQuery] = useState("");
  const [players, setPlayers] = useState<PublicPlayer[]>([]),
    [profile, setProfile] = useState<PublicPlayer | null>(null);
  const [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [busy, setBusy] = useState("");
  const [name, setName] = useState(""),
    [mode, setMode] = useState<InputMode>("typing");
  const [offset, setOffset] = useState(0),
    [hasMore, setHasMore] = useState(false);
  const request = useRef(0);
  const reload = useCallback(
    async (quiet = false) => {
      const version = ++request.current;
      if (!quiet) setLoading(true);
      try {
        const [list, player] = await Promise.all([
          getPlayers(view, query, profileId, offset),
          profileId ? getPublicPlayer(profileId) : Promise.resolve(null),
        ]);
        if (version !== request.current) return;
        setPlayers(list);
        setHasMore(list.length === 30);
        setProfile(player);
        setError("");
      } catch (e) {
        if (version === request.current)
          setError(e instanceof Error ? e.message : "Could not load players.");
      } finally {
        if (version === request.current) setLoading(false);
      }
    },
    [view, query, profileId, offset],
  );
  useEffect(() => {
    const debounce = setTimeout(() => {
      void reload();
    }, 250);
    const poll = setInterval(() => {
      void reload(true);
    }, 10000);
    return () => {
      request.current++;
      clearTimeout(debounce);
      clearInterval(poll);
    };
  }, [reload]);
  useEffect(() => {
    setName(profile?.display_name || "");
  }, [profile?.id, profile?.display_name]);
  useEffect(() => {
    setOffset(0);
    setView("friends");
    setQuery("");
  }, [profileId]);
  const mutate = async (id: string, action: () => Promise<unknown>) => {
    setBusy(id);
    setError("");
    try {
      await action();
      await reload(true);
      await social.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save. Retry.");
    } finally {
      setBusy("");
    }
  };
  const challenge = async (p: PublicPlayer) => {
    if (mode === "voice") await requestMicrophone();
    await sendChallenge(p.id, mode);
  };
  const actions = (p: PublicPlayer) =>
    userId &&
    p.id !== userId && (
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          disabled={!!busy}
          onClick={() => {
            void mutate(p.id, () => followPlayer(p.id, !p.is_following));
          }}
        >
          {p.is_friend
            ? "Unfollow friend"
            : p.is_following
              ? "Following · Unfollow"
              : p.follows_you
                ? "Follow back"
                : "Follow"}
        </Button>
        {p.is_friend && (
          <Button
            size="sm"
            variant="primary"
            disabled={
              !!busy ||
              !p.available ||
              !available ||
              social.invitations.some(
                (i) => i.status === "pending" && Date.parse(i.expires_at) > social.now,
              )
            }
            onClick={() => {
              void mutate(p.id, () => challenge(p));
            }}
          >
            Challenge
          </Button>
        )}
      </div>
    );
  const chooseView = (next: PlayerView) => {
    setView(next);
    setOffset(0);
  };
  return (
    <main className="mx-auto max-w-5xl px-4 pb-28 pt-8 sm:px-6 sm:pt-12">
      <Eyebrow>CONMAN Social</Eyebrow>
      <h1 className="mt-2 text-3xl font-semibold sm:text-4xl">
        {profileId ? "Player profile" : "Friends"}
      </h1>
      <p className="mt-3 text-sm text-mute">
        Follow players. Follow each other to become friends, then meet in an unranked Arena match.
      </p>
      {profileId && (
        <Button className="mt-4" size="sm" onClick={() => openProfile()}>
          Back to friends
        </Button>
      )}
      {(error || social.error) && (
        <div className="mt-5">
          <Banner
            tone="error"
            title="Social unavailable"
            action={
              <Button
                size="sm"
                onClick={() => {
                  void reload();
                  void social.refresh();
                }}
              >
                Retry
              </Button>
            }
          >
            {error || social.error}
          </Banner>
        </div>
      )}
      {profileId && profile && (
        <Card className="mt-6 p-5 sm:p-7">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div className="flex min-w-0 items-center gap-4">
              <Avatar name={profile.username} size={56} />
              <div className="min-w-0">
                <h2 className="break-words text-xl font-semibold">
                  {profile.display_name || profile.username}
                </h2>
                <p className="break-words text-sm text-mute">
                  @{profile.username}
                  {profile.is_friend ? " · Friend" : profile.follows_you ? " · Follows you" : ""}
                </p>
                {profile.is_friend && (
                  <p className={`mt-1 text-xs ${profile.available ? "text-win" : "text-mute"}`}>
                    ● {profile.available ? "Online · Available" : "Offline or busy"}
                  </p>
                )}
              </div>
            </div>
            <RatingBadge elo={profile.elo} showRank />
          </div>
          <div className="my-5 grid grid-cols-3 gap-3 text-center">
            {[
              [profile.wins, "Ranked wins"],
              [profile.losses, "Ranked losses"],
              [profile.matches_played, "Ranked matches"],
            ].map(([value, label]) => (
              <div key={label}>
                <div className="text-2xl font-semibold tabular">{value}</div>
                <div className="mt-1 text-xs text-mute">{label}</div>
              </div>
            ))}
          </div>
          <div className="mb-5 flex flex-wrap gap-3">
            {(["friends", "followers", "following"] as const).map((v) => (
              <button
                key={v}
                onClick={() => chooseView(v)}
                className="text-sm text-accent hover:underline"
              >
                {profile[v]} {v}
              </button>
            ))}
          </div>
          {actions(profile)}
          {userId === profile.id && (
            <form
              className="mt-5 flex flex-wrap items-end gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void mutate(profile.id, () => setDisplayName(name));
              }}
            >
              <label className="flex-1 text-sm text-mute">
                Display name (optional)
                <input
                  maxLength={60}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="mt-2 block w-full rounded-xl border border-line bg-card2 px-4 py-3 text-ink"
                />
              </label>
              <Button type="submit" disabled={!!busy}>
                Save name
              </Button>
            </form>
          )}
          <a
            href={`/players/${profile.id}`}
            className="mt-4 block break-all text-xs text-mute underline"
          >
            Permanent profile link
          </a>
        </Card>
      )}
      {profileId && !loading && !profile && !error && (
        <p className="mt-6 text-mute">Player not found.</p>
      )}
      <div className="mt-7 flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Player lists">
          {(["friends", "followers", "following", "search"] as const).map((v) => (
            <Button
              key={v}
              size="sm"
              variant={view === v ? "primary" : "secondary"}
              onClick={() => chooseView(v)}
            >
              {v === "search" ? "Find players" : v[0].toUpperCase() + v.slice(1)}
            </Button>
          ))}
        </div>
        {userId && <InputChoice mode={mode} setMode={setMode} />}
      </div>
      {view === "search" && (
        <label className="mt-5 block text-sm text-mute">
          Search by username
          <input
            type="search"
            placeholder="At least 2 characters"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setOffset(0);
            }}
            className="mt-2 w-full rounded-xl border border-line bg-card px-4 py-3 text-ink outline-none focus:border-accent"
          />
        </label>
      )}
      {userId && !profileId && (
        <Button className="mt-4" size="sm" variant="ghost" onClick={() => openProfile(userId)}>
          View my public profile
        </Button>
      )}
      <div className="mt-5 space-y-3" aria-busy={loading}>
        {loading ? (
          <Spinner />
        ) : players.length ? (
          players.map((p) => (
            <Card key={p.id} className="flex flex-wrap items-center justify-between gap-4 p-4">
              <a
                href={`/players/${p.id}`}
                onClick={(e) => {
                  if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    openProfile(p.id);
                  }
                }}
                className="flex min-w-0 items-center gap-3 hover:text-accent"
              >
                <Avatar name={p.username} size={40} />
                <div className="min-w-0">
                  <div className="break-words font-medium">{p.display_name || p.username}</div>
                  <div className="break-words text-xs text-mute">
                    @{p.username} · {p.elo} ELO
                  </div>
                  {p.is_friend && (
                    <div className={`mt-1 text-xs ${p.available ? "text-win" : "text-mute"}`}>
                      ● {p.available ? "Online · Available" : "Offline or busy"}
                    </div>
                  )}
                </div>
              </a>
              {actions(p)}
            </Card>
          ))
        ) : (
          <Card className="p-8 text-center text-sm text-mute">
            {view === "search" ? "Enter a username to find players." : `No ${view} yet.`}
          </Card>
        )}
      </div>
      {(offset > 0 || hasMore) && (
        <div className="mt-4 flex gap-2">
          <Button disabled={!offset} onClick={() => setOffset((o) => Math.max(0, o - 30))}>
            Previous
          </Button>
          <Button disabled={!hasMore} onClick={() => setOffset((o) => o + 30)}>
            Next
          </Button>
        </div>
      )}
      {userId && !profileId && (
        <section className="mt-10">
          <h2 className="mb-4 text-xl font-semibold">Invitations</h2>
          <Invitations
            invitations={social.invitations}
            userId={userId}
            now={social.now}
            available={available}
            onUpdate={async () => {
              await social.refresh();
              await onMatch();
            }}
          />
        </section>
      )}
      {!userId && (
        <p className="mt-6 text-sm text-mute">
          <a className="text-accent underline" href="/signin">
            Sign in
          </a>{" "}
          to follow and challenge players.
        </p>
      )}
    </main>
  );
}
