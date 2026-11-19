import { CloudflareError, DEFAULT_QUESTION_MODEL, runQuestionModel } from '../_shared/cloudflareAI.ts'
import { questionOutputCount, validateQuestionBatch } from '../_shared/questionPrompt.ts'

class DatabaseError extends Error { constructor(message: string,public status: number) { super(message) } }
const pause=(ms: number) => new Promise<void>((resolve) => setTimeout(resolve,ms))
async function authorized(header: string | null,secret: string) {
  if (!header?.startsWith('Bearer ') || header.length>512) return false
  const digest=(value: string) => crypto.subtle.digest('SHA-256',new TextEncoder().encode(value))
  const [a,b]=await Promise.all([digest(header.slice(7)),digest(secret)])
  const left=new Uint8Array(a),right=new Uint8Array(b)
  return left.reduce((difference,value,i) => difference | (value^right[i]),0)===0
}
interface Context {
  history: string[]; daily_unused: number; arena_active: number; daily_request_limit: number; requests_today: number
  quota_exhausted_on: string | null; cooldown_until: string | null
}

// Dependency injection is only for local tests; production uses the platform's fetch/env/timers.
export function questionGenerator({ env,fetcher=fetch,wait=pause }: { env:(name: string) => string | undefined; fetcher?:typeof fetch; wait?:(ms: number) => Promise<void> }) {
  return async (request: Request): Promise<Response> => {
    const respond=(data: unknown,status=200) => new Response(JSON.stringify(data),{ status,headers:{ 'Content-Type':'application/json','Cache-Control':'no-store' } })
    if (request.method!=='POST') return respond({ error:'POST required' },405)
    const secret=env('QUESTION_GENERATION_SECRET') || ''
    if (secret.length<32) return respond({ error:'Question generation invocation secret is not configured' },503)
    if (!(await authorized(request.headers.get('authorization'),secret))) return respond({ error:'Unauthorized' },401)
    if (request.headers.has('origin')) return respond({ error:'This endpoint is for server/operator invocation only' },403)
    const url=env('SUPABASE_URL'),serviceKey=env('SUPABASE_SERVICE_ROLE_KEY')
    if (!url || !serviceKey) return respond({ error:'Database configuration is missing' },503)
    const workDeadline=Date.now()+110000
    const rpc=async <T=any>(name: string,args: Record<string,unknown>={}): Promise<T> => {
      const remaining=workDeadline-Date.now()
      if (remaining<=0) throw new DatabaseError('Invocation time budget reached; retry after the job lease expires',503)
      const response=await fetcher(`${url}/rest/v1/rpc/${name}`,{ method:'POST',headers:{ apikey:serviceKey,Authorization:`Bearer ${serviceKey}`,'Content-Type':'application/json' },body:JSON.stringify(args),signal:AbortSignal.timeout(Math.max(1,Math.min(12000,remaining))) })
      const text=await response.text()
      let result: any
      try { result=text ? JSON.parse(text) : null } catch { throw new DatabaseError(`Database returned invalid JSON for ${name}`,503) }
      if (!response.ok) throw new DatabaseError(String(result?.message || `Database call ${name} failed`).slice(0,500),response.status>=500 ? 503 : 400)
      return result as T
    }
    let run: string | undefined,token: string | undefined
    try {
      const raw=await request.text()
      if (raw.length>2048) return respond({ error:'Request too large' },413)
      let body: any
      try { body=JSON.parse(raw) } catch { return respond({ error:'Invalid JSON' },400) }
      if (!body || typeof body!=='object' || Array.isArray(body) || !['daily_refill','daily_publish','arena_rotate','arena_fill','dry_run'].includes(body.action)
        || Object.keys(body).some((field) => !['action','force','target','date'].includes(field)) || (body.force!==undefined && typeof body.force!=='boolean')
        || (body.target!==undefined && (body.action!=='dry_run' || !['daily','arena'].includes(body.target)))
        || (body.date!==undefined && (body.action!=='daily_publish' || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)))) return respond({ error:'Invalid job arguments' },400)
      const model=env('QUESTION_GENERATION_MODEL') || DEFAULT_QUESTION_MODEL
      const credentials={ accountId:env('CLOUDFLARE_ACCOUNT_ID') || '',apiToken:env('CLOUDFLARE_API_TOKEN') || '',model,fetcher }
      if (body.action==='dry_run') {
        const context=await rpc<Context>('qgen_context')
        if (context.requests_today>=context.daily_request_limit || context.quota_exhausted_on===new Date().toISOString().slice(0,10) || (context.cooldown_until && Date.parse(context.cooldown_until)>Date.now())) return respond({ error:'Recorded Cloudflare budget/cooldown is exhausted' },429)
        // Strict dry-run: one intended request, read-only context, no claims/logs/budget/database writes.
        const count=body.target==='arena' ? 10 : 5
        const output=await runQuestionModel({ ...credentials,count,history:context.history })
        return respond({ dry_run:true,model,questions:validateQuestionBatch(output.output,count,context.history),usage:output.usage,provider_request_id:output.requestId,
          note:'No database writes. This operator-only call consumes Cloudflare usage but is not added to the persisted request counter.' })
      }
      const job=body.action==='arena_fill' ? 'arena_rotate' : body.action
      const lease=await rpc<{ run_id?: string; token?: string; skip?: string }>('qgen_claim',{ p_job:job,p_force:body.force===true || body.action==='arena_fill',p_fill:body.action==='arena_fill' })
      if (lease.skip) return respond({ job,skipped:lease.skip })
      run=lease.run_id; token=lease.token
      if (!run || !token) throw new Error('The database returned an invalid job lease')
      if (job==='daily_publish') {
        const result=await rpc('qgen_publish',{ p_run:run,p_token:token,p_date:body.date || null })
        let warning: string | undefined
        try { await rpc('qgen_finish_job',{ p_run:run,p_token:token,p_details:result }) } catch { warning='Publication committed; job lease cleanup will recover after expiry' }
        return respond({ job,...result,warning })
      }
      const count=job==='daily_refill' ? 5 : 10
      let context=await rpc<Context>('qgen_context'),feedback=''
      for (let attempt=0;attempt<3;attempt++) {
        if (workDeadline-Date.now()<30000) throw new DatabaseError('Not enough invocation time for another model attempt',503)
        const requestId=await rpc<string>('qgen_request_begin',{ p_run:run,p_token:token,p_model:model,p_count:count })
        let output: Awaited<ReturnType<typeof runQuestionModel>> | undefined
        try {
          if (workDeadline-Date.now()<25000) throw new DatabaseError('Not enough invocation time for a model request',503)
          output=await runQuestionModel({ ...credentials,count,history:context.history,feedback })
          const questions=validateQuestionBatch(output.output,count,context.history)
          await rpc('qgen_request_end',{ p_request:requestId,p_status:output.status,p_count:questions.length,p_usage:output.usage,p_error:null,p_provider_id:output.requestId })
          let inserted: number
          try { inserted=await rpc<number>('qgen_commit_batch',{ p_run:run,p_token:token,p_request:requestId,p_questions:questions }) }
          catch (error) {
            // Retry an ambiguous database/network failure using the same model response.
            if (!(error instanceof DatabaseError) || error.status===503) inserted=await rpc<number>('qgen_commit_batch',{ p_run:run,p_token:token,p_request:requestId,p_questions:questions })
            else throw error
          }
          let warning: string | undefined
          try { await rpc('qgen_finish_job',{ p_run:run,p_token:token,p_details:{ model,inserted } }) } catch { warning='Batch committed; job lease cleanup will recover after expiry' }
          return respond({ job,run_id:run,model,inserted,warning })
        } catch (error) {
          const cf=error instanceof CloudflareError ? error : null
          feedback=error instanceof Error ? error.message : 'Generation validation failed'
          const cooldown=cf?.status===429 ? Math.max(60,cf.retryAfter) : cf?.retryAfter || 0
          await rpc('qgen_request_end',{ p_request:requestId,p_status:cf?.status ?? output?.status ?? null,p_count:output ? questionOutputCount(output.output) : 0,
            p_usage:cf?.usage ?? output?.usage ?? null,p_error:feedback,p_provider_id:cf?.requestId ?? output?.requestId ?? null,p_quota:cf?.quotaExhausted || false,p_cooldown:cooldown })
          const invalid=!(error instanceof DatabaseError) || /duplicate|batch|question format|question.*word/i.test(feedback)
          if (attempt===2 || cf?.quotaExhausted || cf?.status===429 || (cf && !cf.retryable) || !invalid || (error instanceof DatabaseError && error.status===503)) throw error
          await wait(1000*2**attempt)
          context=await rpc<Context>('qgen_context')
        }
      }
      throw new Error('Question generation retry limit reached')
    } catch (error) {
      const message=error instanceof Error ? error.message : 'Question generation failed'
      if (run && token) {
        try { await rpc('qgen_finish_job',{ p_run:run,p_token:token,p_error:message }) } catch { /* The lease expires; persisted request reservations still count toward quota. */ }
      }
      return respond({ error:message,run_id:run },error instanceof CloudflareError && (error.quotaExhausted || error.status===429) ? 429 : error instanceof DatabaseError ? error.status : 503)
    }
  }
}

Deno.serve(questionGenerator({ env:(name) => Deno.env.get(name) }))
