import {
  dailyRequest,
  readDailySession,
  type DailyAttempt,
  type DailySession,
  type DailyToday,
} from "./dailyService";

// Normal Daily Five selects the server's current Eastern date, never the legacy active pointer.
export async function loadCurrentDaily(
  request = dailyRequest,
  read = readDailySession,
): Promise<{ today: DailyToday; session: DailySession | null; attempt: DailyAttempt | null }> {
  for (let pass = 0; pass < 2; pass++) {
    const today = await request<DailyToday>("today");
    const saved = await read(today.date);
    const session = saved?.date === today.date ? saved : null;
    const attempt = session?.token ? await request<DailyAttempt>("state", {}, session.token) : null;
    if (attempt && attempt.date !== today.date)
      throw new Error("Saved progress does not match today’s challenge. Retry Daily Five.");
    if (attempt?.server_now) {
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: "America/New_York",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(new Date(attempt.server_now));
      const part = (name: string) => parts.find((p) => p.type === name)!.value;
      if (`${part("year")}-${part("month")}-${part("day")}` !== today.date) continue; // Midnight crossed while restoring.
    }
    return { today, session, attempt };
  }
  throw new Error("The daily challenge date changed while restoring. Retry Daily Five.");
}
export function dailyRolloverDelay(today: DailyToday, now = Date.now()) {
  return today.next_date_at
    ? Math.max(25, Date.parse(today.next_date_at) - now - (today.clockOffset || 0) + 25)
    : 60000;
}
