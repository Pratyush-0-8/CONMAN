import type { AnswerSnapshot } from './matchService'
import type { AnswerTransport } from './useAnswerSync'
import type { InputMode, Scores } from './game'

export interface DailyRound {
  thinking_seconds?: number; answer_seconds?: number;
  answer_revision?: number; answer_writer?: string | null; locked_at?: string | null; final_answer_text?: string | null;
  position: number; question: string | null; started_at: string | null; deadline: string | null; answer_text: string | null
  state: 'active' | 'locked' | 'judging' | 'error' | 'graded' | null
  scores: Scores | null; total: number | null; explanation: string | null; judge_error: string | null
  retry_at: string | null; judge_lease_until: string | null; judge_attempts: number | null
}
export interface DailyAttempt {
  id: string; date: string; mode: InputMode; position: number; status: 'active' | 'complete'; final_score: number | null
  rounds: DailyRound[]; server_now: string; clockOffset: number
}
export interface DailyToday { next_date_at?: string; clockOffset?: number; date: string; available: boolean; server_now: string }
export interface DailyDistribution { date: string; count: number; below_count?: number; percentile: number; bins: { from: number; to: number; count: number }[] }
export interface DailySession { date: string; mode: InputMode; creationKey: string; token?: string }

export async function dailyRequest<T>(action: string, body: Record<string,unknown> = {}, token?: string): Promise<T> {
  const before = Date.now()
  const response = await fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/daily-five`, {
    method:'POST',credentials:'omit',cache:'no-store',headers:{ apikey:import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,'Content-Type':'application/json',...(token ? { 'x-daily-token':token } : {}) },
    body:JSON.stringify({ action,...body }),signal:AbortSignal.timeout(action==='judge' ? 90000 : 15000),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || 'Daily Five could not connect. Your saved progress is preserved; retry when online.')
  return { ...data,...(data.server_now ? { clockOffset:Date.parse(data.server_now)-(before+Date.now())/2 } : {}) } as T
}

// Cross-origin Edge Functions cannot reliably use third-party HttpOnly cookies.
// Store the capability in origin-isolated IndexedDB, never URLs or localStorage flags.
function openVault(): Promise<IDBDatabase> {
  return new Promise((resolve,reject) => {
    const request=indexedDB.open('conman-daily-five',1)
    request.onupgradeneeded=() => request.result.createObjectStore('attempts')
    request.onsuccess=() => resolve(request.result)
    request.onerror=() => reject(new Error('Enable browser site storage to start or recover Daily Five.'))
  })
}
export async function readDailySession(date = 'active'): Promise<DailySession | undefined> {
  const db=await openVault()
  return new Promise((resolve,reject) => {
    const tx=db.transaction('attempts','readonly'), request=tx.objectStore('attempts').get(date)
    tx.oncomplete=() => { db.close(); resolve(request.result) }
    tx.onerror=() => { db.close(); reject(new Error('Could not read your saved attempt credential.')) }
  })
}
export async function prepareDailySession(date: string, mode: InputMode): Promise<DailySession> {
  const db=await openVault()
  return new Promise((resolve,reject) => {
    const tx=db.transaction('attempts','readwrite'), store=tx.objectStore('attempts'), request=store.get(date)
    let session: DailySession
    request.onsuccess=() => {
      // A read/write transaction makes two tabs use the same creation nonce.
      session=request.result ? { ...request.result,...(!request.result.token ? { mode } : {}) } : { date,mode,creationKey:Array.from(crypto.getRandomValues(new Uint8Array(32)),(b) => b.toString(16).padStart(2,'0')).join('') }
      store.put(session,date); store.put(session,'active')
    }
    tx.oncomplete=() => { db.close(); resolve(session) }
    tx.onerror=tx.onabort=() => { db.close(); reject(new Error('Could not save your attempt credential. Check browser site storage.')) }
  })
}
export async function storeDailySession(session: DailySession) {
  const db=await openVault()
  return new Promise<void>((resolve,reject) => {
    const tx=db.transaction('attempts','readwrite'), store=tx.objectStore('attempts')
    store.put(session,session.date); store.put(session,'active')
    tx.oncomplete=() => { db.close(); resolve() }
    tx.onerror=tx.onabort=() => { db.close(); reject(new Error('Could not save your recovery token. Keep this tab open and retry.')) }
  })
}

export function dailyAnswerTransport(token: string, position: number): AnswerTransport {
  return {
    open: (_id, writer, previous) => dailyRequest<AnswerSnapshot>('open-answer', { position, writer, previousWriter: previous }, token),
    save: async (_id, text, final, revision, writer) => {
      const snapshot = await dailyRequest<AnswerSnapshot>(final ? 'submit' : 'save', { position, text, revision, writer }, token)
      if (snapshot.status==='superseded' || snapshot.status==='stale') return snapshot
      if (final && (snapshot.answer_text !== text || !snapshot.locked_at || snapshot.final_answer_text !== text || snapshot.final_revision !== snapshot.revision)) throw new Error('Your final answer was not saved. The last received draft is locked; retry to confirm its status.')
      return snapshot
    },
  }
}
