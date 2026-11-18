import { MODEL } from '../_shared/judge.ts'
import { DAILY_RUBRIC, digest, easternDate, issueCredential, parseDailyJudgment } from '../_shared/daily.ts'

class ApiError extends Error { constructor(message: string, public status: number) { super(message) } }

Deno.serve(async (request: Request) => {
  const origin = request.headers.get('origin')
  const allowed = (Deno.env.get('DAILY_ALLOWED_ORIGINS') || '').split(',').map((value) => value.trim()).filter(Boolean)
  const headers: Record<string,string> = { 'Content-Type':'application/json', 'Cache-Control':'no-store', Vary:'Origin', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'apikey, content-type, x-daily-token' }
  if (origin && allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers })
  if (origin && !allowed.includes(origin)) return respond({ error:'This origin is not allowed.' },403)
  if (request.method === 'OPTIONS') return new Response(null,{ status:204,headers })
  if (request.method !== 'POST') return respond({ error:'POST required' },405)
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  let hash: string | undefined, position: number | undefined, claimToken: string | undefined, rateLimited = false
  const rpc = async <T = any>(name: string, body: Record<string,unknown> = {}): Promise<T> => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method:'POST',headers:{ apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json' },body:JSON.stringify(body),signal:AbortSignal.timeout(12000) })
    if (!response.ok) {
      const error = await response.json().catch(() => ({}))
      const message = String(error.message || 'Daily Five is temporarily unavailable.')
      throw new ApiError(message, /rate limit|retry limit/i.test(message) ? 429 : error.code === '42501' ? 403 : /date changed/i.test(message) ? 409 : 400)
    }
    const text = await response.text()
    return (text ? JSON.parse(text) : null) as T
  }
  try {
    const secret = Deno.env.get('DAILY_TOKEN_SECRET')
    if (!secret || secret.length<32 || !allowed.length) throw new ApiError('Daily Five is not configured yet.',503)
    // IP buckets are advisory, never authorization. Global and per-question limits remain effective even if a forwarded header is spoofed.
    const ip = (request.headers.get('x-forwarded-for') || 'unavailable').split(',')[0].trim().slice(0,128)
    const abuseKey = await issueCredential(secret, `ip|${easternDate()}|${ip}`)
    await rpc('daily_take_budget',{ p_key:`api:${abuseKey}`,p_limit:600,p_seconds:60 })
    const raw = await request.text()
    if (raw.length>16000) throw new ApiError('Request is too large.',413)
    let body: Record<string,unknown>
    try { body=JSON.parse(raw) } catch { throw new ApiError('Invalid JSON.',400) }
    if (!body || typeof body!=='object' || Array.isArray(body)) throw new ApiError('Invalid request.',400)
    const action = body.action
    const fields: Record<string,string[]> = { today:['action'],start:['action','creationKey','date','mode'],state:['action'],save:['action','position','text'],submit:['action','position','text'],next:['action','position'],judge:['action','position'],distribution:['action'] }
    if (typeof action!=='string' || !fields[action] || Object.keys(body).some((key) => !fields[action].includes(key))) throw new ApiError('Invalid action or fields.',400)
    if (action==='today') return respond(await rpc('daily_today'))
    if (action==='start') {
      if (typeof body.creationKey!=='string' || !/^[a-f0-9]{64}$/.test(body.creationKey) || !['voice','typing'].includes(String(body.mode)) || !/^\d{4}-\d{2}-\d{2}$/.test(String(body.date))) throw new ApiError('Invalid attempt details.',400)
      const token = await issueCredential(secret, `attempt|${body.date}|${body.creationKey}`)
      const state = await rpc('daily_start',{ p_hash:await digest(token),p_mode:body.mode,p_abuse_key:abuseKey,p_date:body.date })
      return respond({ ...state,token })
    }
    const token = request.headers.get('x-daily-token') || ''
    if (!/^[a-f0-9]{64}$/.test(token)) throw new ApiError('Your attempt token is missing. Return to Daily Five.',403)
    hash=await digest(token)
    if (action==='state') return respond(await rpc('daily_state',{ p_hash:hash }))
    if (action==='distribution') return respond(await rpc('daily_distribution',{ p_hash:hash }))
    if (!Number.isInteger(body.position) || Number(body.position)<1 || Number(body.position)>5) throw new ApiError('Invalid question position.',400)
    position=Number(body.position)
    if (action==='save' || action==='submit') {
      if (typeof body.text!=='string' || body.text.length>12000) throw new ApiError('Invalid answer.',400)
      return respond(await rpc('daily_answer',{ p_hash:hash,p_position:position,p_text:body.text,p_final:action==='submit' }))
    }
    if (action==='next') return respond(await rpc('daily_next',{ p_hash:hash,p_position:position }))
    const claim = await rpc('daily_claim',{ p_hash:hash,p_position:position,p_abuse_key:abuseKey })
    if (claim.complete || claim.busy) return respond({ pending:!!claim.busy },claim.busy ? 202 : 200)
    claimToken=claim.token
    const groqKey=Deno.env.get('GROQ_API_KEY')
    if (!groqKey) throw new ApiError('Daily judging is not configured.',503)
    const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{ method:'POST',headers:{ Authorization:`Bearer ${groqKey}`,'Content-Type':'application/json' },signal:AbortSignal.timeout(45000),body:JSON.stringify({ model:MODEL,temperature:0.2,max_completion_tokens:3000,response_format:{ type:'json_object' },messages:[{ role:'system',content:DAILY_RUBRIC },{ role:'user',content:JSON.stringify({ question:claim.question,answer:claim.answer }) }] }) })
    rateLimited=response.status===429
    if (!response.ok) throw new ApiError('Daily judging is temporarily unavailable. Your answer is saved.',response.status===429 ? 429 : 503)
    const data=await response.json()
    const judgment=parseDailyJudgment(data.choices?.[0]?.message?.content || '')
    let state: unknown
    // A database retry reuses the one Groq response; the SQL claim makes scoring idempotent.
    for (let attempt=0;attempt<2;attempt++) {
      try { state=await rpc('daily_finish',{ p_hash:hash,p_position:position,p_claim:claimToken,p_scores:judgment.scores,p_explanation:judgment.explanation,p_model:MODEL }); break }
      catch (error) { if (attempt===1) throw error }
    }
    return respond(state)
  } catch (error) {
    const message=error instanceof Error ? error.message : 'Daily Five is temporarily unavailable.'
    if (hash && position && claimToken) {
      try { await rpc('daily_fail',{ p_hash:hash,p_position:position,p_claim:claimToken,p_error:message,p_rate_limited:rateLimited }) } catch { /* Lease expiry permits recovery if the worker lost its database connection. */ }
    }
    return respond({ error:message },error instanceof ApiError ? error.status : 503)
  }
})
