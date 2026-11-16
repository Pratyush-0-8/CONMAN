import { MODEL, RUBRIC, parseJudgment } from '../_shared/judge.ts'

const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' }
const respond = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } })

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: cors })
  if (request.method !== 'POST') return respond({ error: 'POST required' }, 405)
  const url = Deno.env.get('SUPABASE_URL')!
  const key = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const authorization = request.headers.get('authorization') || ''
  let matchId: string | undefined, token: string | undefined
  const rpc = async (name: string, body: Record<string, unknown>) => {
    const response = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(12000) })
    if (!response.ok) throw new Error(`Database operation ${name} failed (${response.status})`)
    const text = await response.text()
    return text ? JSON.parse(text) : null
  }
  try {
    if (!authorization.startsWith('Bearer ')) return respond({ error: 'Sign in required' }, 401)
    const auth = await fetch(`${url}/auth/v1/user`, { headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY')!, Authorization: authorization }, signal: AbortSignal.timeout(10000) })
    if (!auth.ok) return respond({ error: 'Invalid session' }, 401)
    const user = await auth.json()
    if (!user.id || !user.email_confirmed_at) return respond({ error: 'Verified account required' }, 403)
    const body = await request.json()
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).length !== 1 || typeof body.matchId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.matchId)) return respond({ error: 'Only a valid matchId is accepted' }, 400)
    matchId = body.matchId
    // RLS-enforced membership check before using the service role for the atomic claim.
    const membership = await fetch(`${url}/rest/v1/ranked_players?match_id=eq.${matchId}&player_id=eq.${user.id}&select=match_id`, { headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY')!, Authorization: authorization }, signal: AbortSignal.timeout(10000) })
    if (!membership.ok || !(await membership.json()).length) return respond({ error: 'Match not found' }, 403)
    const claim = await rpc('ranked_claim', { p_match: matchId, p_requester: user.id })
    if (claim.complete) return respond(claim.result)
    if (claim.busy) return respond({ pending: true }, 202)
    token = claim.token
    const apiKey = Deno.env.get('GROQ_API_KEY')
    if (!apiKey) throw new Error('Judge is not configured')
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(45000),
      body: JSON.stringify({ model: MODEL, temperature: 0.2, max_completion_tokens: 3000, response_format: { type: 'json_object' }, messages: [
        { role: 'system', content: RUBRIC },
        { role: 'user', content: JSON.stringify({ question: claim.question, player1Answer: claim.answers[claim.player1_id], player2Answer: claim.answers[claim.player2_id] }) },
      ] }),
    })
    if (!response.ok) throw new Error(`Judge service unavailable (${response.status}). Please retry.`)
    const output = await response.json()
    const scores = parseJudgment(output.choices?.[0]?.message?.content || '')
    // Retry only database finalization, never another Groq call in this invocation.
    let result: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try { result = await rpc('ranked_finalize', { p_match: matchId, p_token: token, p_scores1: scores.player1, p_scores2: scores.player2, p_model: MODEL }); break }
      catch (error) { if (attempt === 1) throw error }
    }
    return respond(result)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Judge temporarily unavailable'
    if (matchId && token) {
      try { await rpc('ranked_judge_failed', { p_match: matchId, p_token: token, p_error: message }) } catch { /* The claim lease allows recovery after a worker failure. */ }
    }
    return respond({ error: message, pending: true }, 503)
  }
})
