import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as judge from '../supabase/functions/_shared/judge.ts'
import * as daily from '../supabase/functions/_shared/daily.ts'

const scores={ Logic:8,Creativity:8,Relevance:8,Clarity:8,Depth:8 }
function endpoint({ busy=false,graded=false,invalid=false,rateLimited=false,quota=false }={}) {
  let handler,groqCalls=0,finished=0
  const calls=[],attempts=new Map(),env={ DAILY_TOKEN_SECRET:'daily-test-secret-with-more-than-32-characters',DAILY_ALLOWED_ORIGINS:'https://conman.test',SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'server-only',GROQ_API_KEY:'server-groq' }
  const code=ts.transpileModule(fs.readFileSync(new URL('../supabase/functions/daily-five/index.ts',import.meta.url),'utf8'),{ compilerOptions:{ target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS } }).outputText
  vm.runInNewContext(code,{
    exports:{},require:(name) => name.endsWith('/judge.ts') ? judge : daily,Error,Response,Request,AbortSignal,crypto,
    Deno:{ env:{ get:(name) => env[name] },serve:(fn) => { handler=fn } },
    fetch:async (url,options) => {
      const body=JSON.parse(options.body)
      if (url.includes('api.groq.com')) {
        groqCalls++; assert.equal(body.model,judge.MODEL); assert.equal(body.messages.length,2)
        assert.equal(options.headers.Authorization,'Bearer server-groq')
        assert.deepEqual(JSON.parse(body.messages[1].content),{ question:'Saved question',answer:'Actual persisted answer' })
        return rateLimited ? new Response('',{ status:429 }) : Response.json({ choices:[{ message:{ content:JSON.stringify({ scores:invalid ? { ...scores,Logic:7.5 } : scores,explanation:'Clear reasoning.' }) } }] })
      }
      const name=url.split('/').at(-1); calls.push({ name,body }); assert.equal(options.headers.Authorization,'Bearer server-only')
      if (name==='daily_take_budget') return quota ? Response.json({ message:'Daily rate limit reached' },{ status:400 }) : Response.json(null)
      if (name==='daily_today') return Response.json({ date:daily.easternDate(),available:true,server_now:new Date().toISOString() })
      if (name==='daily_start') {
        if (!attempts.has(body.p_hash)) attempts.set(body.p_hash,{ id:crypto.randomUUID(),date:body.p_date,mode:body.p_mode,position:1,rounds:[],status:'active' })
        return Response.json(attempts.get(body.p_hash))
      }
      if (!attempts.has(body.p_hash)) return Response.json({ code:'42501',message:'Invalid attempt token' },{ status:403 })
      if (name==='daily_state') return Response.json(attempts.get(body.p_hash))
      if (name==='daily_claim') return Response.json(graded ? { complete:true } : busy ? { busy:true } : { token:crypto.randomUUID(),question:'Saved question',answer:'Actual persisted answer' })
      if (name==='daily_finish') { finished++; assert.deepEqual(body.p_scores,scores); return Response.json(attempts.get(body.p_hash)) }
      if (name==='daily_fail') return Response.json(null)
      throw new Error('Unexpected endpoint')
    },
  })
  return { call:(body,token,origin='https://conman.test') => handler(new Request('https://daily.test',{ method:'POST',headers:{ Origin:origin,'Content-Type':'application/json','x-forwarded-for':'198.51.100.10',...(token ? { 'x-daily-token':token } : {}) },body:JSON.stringify(body) })),stats:() => ({ groqCalls,finished,calls }) }
}
async function start(api,key='a'.repeat(64)) {
  const response=await api.call({ action:'start',date:daily.easternDate(),mode:'typing',creationKey:key })
  assert.equal(response.status,200); return response.json()
}
test('public endpoint creates and recovers a server-issued attempt without Auth or email',async () => {
  const api=endpoint(),first=await start(api),again=await start(api)
  assert.equal(first.id,again.id); assert.equal(first.token,again.token); assert.match(first.token,/^[a-f0-9]{64}$/)
  const state=await api.call({ action:'state' },first.token); assert.equal(state.status,200); assert.equal((await state.json()).id,first.id)
  const other=await start(api,'b'.repeat(64)); assert.notEqual(first.id,other.id); assert.notEqual(first.token,other.token)
  assert.equal((await api.call({ action:'state' },'c'.repeat(64))).status,403)
  assert.equal((await api.call({ action:'state' })).status,403)
  assert.ok(api.stats().calls.every(({ name }) => name.startsWith('daily_')))
})
test('one intended Groq call uses persisted question/answer and never Arena/ELO',async () => {
  const api=endpoint(),attempt=await start(api)
  assert.equal((await api.call({ action:'judge',position:1 },attempt.token)).status,200)
  assert.equal(api.stats().groqCalls,1); assert.equal(api.stats().finished,1)
  assert.ok(api.stats().calls.every(({ name }) => !/ranked|elo/.test(name)))
  assert.equal((await api.call({ action:'judge',position:1,scores },attempt.token)).status,400)
})
test('concurrent claim or previously graded result does not call Groq',async () => {
  for (const options of [{ busy:true },{ graded:true }]) {
    const api=endpoint(options),attempt=await start(api)
    await api.call({ action:'judge',position:1 },attempt.token)
    assert.equal(api.stats().groqCalls,0); assert.equal(api.stats().finished,0)
  }
})
test('malformed scores and provider rate limits remain recoverable without finalization',async () => {
  for (const options of [{ invalid:true },{ rateLimited:true }]) {
    const api=endpoint(options),attempt=await start(api)
    const response=await api.call({ action:'judge',position:1 },attempt.token)
    assert.equal(response.status,options.rateLimited ? 429 : 503); assert.equal(api.stats().finished,0)
    const failed=api.stats().calls.find(({ name }) => name==='daily_fail'); assert.ok(failed)
    assert.equal(failed.body.p_rate_limited,!!options.rateLimited)
  }
})
test('quota gate blocks work and foreign browser origins are rejected',async () => {
  const api=endpoint({ quota:true }); assert.equal((await api.call({ action:'today' })).status,429); assert.equal(api.stats().groqCalls,0)
  assert.equal((await endpoint().call({ action:'today' },undefined,'https://untrusted.test')).status,403)
})
