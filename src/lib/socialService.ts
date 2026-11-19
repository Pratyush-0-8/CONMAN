import { supabase } from "./supabase";
import type { InputMode } from "./game";

export interface PublicPlayer {
  id: string;
  username: string;
  display_name: string | null;
  elo: number;
  wins: number;
  losses: number;
  draws: number;
  matches_played: number;
  followers: number;
  following: number;
  friends: number;
  is_following: boolean;
  follows_you: boolean;
  is_friend: boolean;
  available: boolean;
}
export type PlayerView = "friends" | "followers" | "following" | "search";
export interface Invitation {
  id: string;
  sender_id: string;
  recipient_id: string;
  sender_name: string;
  recipient_name: string;
  sender_mode: InputMode;
  status: "pending" | "accepted" | "declined" | "cancelled" | "expired";
  created_at: string;
  expires_at: string;
  match_id: string | null;
}
async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}
export const getPublicPlayer = (id: string) =>
  rpc<PublicPlayer | null>("social_profile", { p_player: id });
export const getPlayers = (view: PlayerView, query = "", player?: string, offset = 0) =>
  rpc<PublicPlayer[]>("social_players", {
    p_view: view,
    p_query: query,
    p_player: player || null,
    p_offset: offset,
  });
export const followPlayer = (id: string, follow: boolean) =>
  rpc<void>("social_follow", { p_player: id, p_follow: follow });
export const setDisplayName = (name: string) =>
  rpc<void>("social_set_display_name", { p_name: name });
export const heartbeat = (session: string, available: boolean) =>
  rpc<void>("social_heartbeat", { p_session: session, p_available: available });
export const getInvitations = () =>
  rpc<{ server_now: string; invitations: Invitation[] }>("social_invitations");
export const sendChallenge = (id: string, mode: InputMode) =>
  rpc<string>("social_send_challenge", { p_player: id, p_mode: mode });
export const respondChallenge = (
  id: string,
  action: "accept" | "decline" | "cancel",
  mode: InputMode,
) =>
  rpc<string | null>("social_respond_challenge", {
    p_challenge: id,
    p_action: action,
    p_mode: mode,
  });
export function subscribeSocial(id: string, refresh: () => void) {
  const channel = supabase
    .channel(`social:${id}`)
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "friend_challenges", filter: `sender_id=eq.${id}` },
      refresh,
    )
    .on(
      "postgres_changes",
      { event: "*", schema: "public", table: "friend_challenges", filter: `recipient_id=eq.${id}` },
      refresh,
    )
    .subscribe((status) => {
      if (status === "SUBSCRIBED") refresh();
    });
  return () => {
    void supabase.removeChannel(channel);
  };
}
