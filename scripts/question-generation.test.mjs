import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as prompt from '../supabase/functions/_shared/questionPrompt.ts'
import * as cloudflare from '../supabase/functions/_shared/cloudflareAI.ts'

const questions=[
  'What is the strongest reason a quiet museum might invite visitors to rearrange its signs?',
  'How could a town benefit from requiring every shop to close during its busiest hour?',
  'Why might a school replace one weekly examination with a competition to ask better questions?',
  'Why might a theater sell its worst seats first, even when better ones remain available?',
  'How could an elevator that occasionally takes a longer route make office life more productive?',
  'A village holds a contest for the least impressive invention; what useful behavior could it encourage?',
  'When could putting an empty shelf in a crowded grocery store help its customers choose well?',
  'A sports team selects its captain by listening quietly; what important ability might this reveal?',
  'What useful problem could a library solve by letting readers invent new titles for books?',
  'Why might a gardener deliberately leave one corner of a perfectly arranged garden completely untidy?',
]
const payload=(count) => ({ questions:questions.slice(0,count) })
test('batch inspiration stays sparse, mixes abstract/concrete cues, and changes with the random source',() => {
  const first=prompt.questionInspiration(() => 0),second=prompt.questionInspiration(() => 0.999)
  assert.notDeepEqual(first,second)
  assert.equal(Object.keys(first).length,2)
  assert.equal(Object.keys(first).filter((key) => ['subjects','constraints','concepts'].includes(key)).length,1)
  assert.equal(Object.keys(first).filter((key) => ['settings','objects','professions'].includes(key)).length,1)
  for (const values of Object.values(first)) {
    assert.equal(values.length,1)
    assert.ok(values.every((value) => typeof value==='string' && value.length>0))
  }
  assert.deepEqual(prompt.questionInspiration(() => 0),first, 'sampling must not mutate the palettes')
  assert.match(prompt.QUESTION_PROMPT,/optional sparks, NOT a checklist/)
  assert.match(prompt.QUESTION_PROMPT,/several defensible answers/)
})
test('whole-batch validation accepts five/ten and rejects malformed/incorrect/duplicate outputs',() => {
  assert.equal(prompt.validateQuestionBatch(JSON.stringify(payload(5)),5).length,5)
  assert.equal(prompt.validateQuestionBatch(payload(10),10).length,10)
  for (const invalid of ['not JSON',{ questions:questions.slice(0,4) },{ questions:[...questions.slice(0,4),questions[0]] },{ ...payload(5),extra:true }]) assert.throws(() => prompt.validateQuestionBatch(invalid,5))
  assert.throws(() => prompt.validateQuestionBatch(payload(5),5,[questions[0]]))
  assert.equal(prompt.normalizeQuestion('ＷＨＹ — remove CLOCKS?!'),'why remove clocks')
  assert.ok(prompt.questionsNear('A busy museum invites visitors to rearrange its signs; why might this improve their experience?', 'Why might visitors improve their experience when a busy museum invites them to rearrange signs?'))
})
test('model history gives bounded recurring details without archived question examples',() => {
  const archived='A quiet teapot rings beside a velvet curtain; what should the stagehand do next?'
  const details=prompt.recentQuestionDetails([archived,archived,...Array(58).fill('one person using a single ordinary thing'),...Array(10).fill('zebraplume zebraplume')])
  assert.ok(details.includes('teapot')); assert.ok(details.includes('curtain'))
  assert.ok(!details.includes('person')); assert.ok(!details.includes('single')); assert.ok(!details.includes('zebraplume'))
  assert.ok(details.length<=24); assert.ok(details.every((word) => !word.includes(' ') && word.length<=30))
  assert.deepEqual(prompt.recentQuestionDetails([archived]),[])
})
test('Cloudflare client preserves the successful configuration and caps historical context',async (t) => {
  let calls=0
  const timeout=AbortSignal.timeout,timeouts=[]
  t.mock.method(AbortSignal,'timeout',(ms) => { timeouts.push(ms); return timeout.call(AbortSignal,ms) })
  const output=await cloudflare.runQuestionModel({ accountId:'test-account',apiToken:'server-only-token',model:'@cf/meta/llama-3.1-8b-instruct',count:5,history:Array(200).fill('a'.repeat(1000)),feedback:'Duplicate question: The velvet puppet rules the shoelace kingdom?',fetcher:async (url,options) => {
    calls++; assert.ok(url.endsWith('@cf/meta/llama-3.1-8b-instruct')); assert.equal(options.headers.Authorization,'Bearer server-only-token')
    const body=JSON.parse(options.body),user=JSON.parse(body.messages[1].content)
    assert.equal(user.count,5); assert.equal(user.historicalQuestions,undefined); assert.ok(Array.isArray(user.recentlyUsedDetails)); assert.ok(user.recentlyUsedDetails.length<=24); assert.ok(!options.body.includes('a'.repeat(220))); assert.ok(options.body.length<20000)
    assert.ok(!options.body.includes('velvet puppet')); assert.ok(user.correction.length<=300)
    assert.equal(body.max_tokens,4096); assert.equal(body.temperature,0.7); assert.equal(body.chat_template_kwargs.enable_thinking,false); assert.equal(body.stream,false); assert.ok(options.signal instanceof AbortSignal);
    assert.equal(Object.keys(user.creativeInspiration).length,2);
    assert.ok(Object.values(user.creativeInspiration).every((values) => values.length===1)); assert.equal(body.response_format.type,'json_object')
    return Response.json({ success:true,result:{ response:payload(5),usage:{ total_tokens:500 } } },{ headers:{ 'cf-ray':'test-ray' } })
  } })
  assert.equal(calls,1); assert.equal(output.requestId,'test-ray'); assert.equal(output.usage.total_tokens,500); assert.equal(prompt.validateQuestionBatch(output.output,5).length,5)
  assert.deepEqual(timeouts,[70000]); assert.equal(cloudflare.DEFAULT_QUESTION_MODEL,'@cf/google/gemma-4-26b-a4b-it')
})
test('Cloudflare quota exhaustion, rate limits, timeout/network, and malformed responses are classified',async () => {
  for (const [status,data,quota,retryable] of [
    [429,{ success:false,errors:[{ code:3036,message:'Daily free allocation used up' }] },true,false],
    [429,{ success:false,errors:[{ code:4006,message:'You have used up your daily free allocation of 10,000 neurons' }] },true,false],
    [429,{ errors:[{ code:3040,message:'Capacity temporarily exceeded' }] },false,true],
    [403,{ errors:[{ code:5035,message:'Model requires Workers Paid plan' }] },false,false],
  ]) {
    await assert.rejects(cloudflare.runQuestionModel({ accountId:'x',apiToken:'x',count:5,history:[],fetcher:async () => Response.json(data,{ status,headers:{ 'Retry-After':'120' } }) }), (error) => error instanceof cloudflare.CloudflareError && error.quotaExhausted===quota && error.retryable===retryable)
  }
  await assert.rejects(cloudflare.runQuestionModel({ accountId:'x',apiToken:'x',count:5,history:[],fetcher:async () => { throw new Error('network') } }), (error) => error.retryable)
  await assert.rejects(cloudflare.runQuestionModel({ accountId:'x',apiToken:'x',count:5,history:[],fetcher:async () => new Response('invalid JSON') }), (error) => error.retryable)
})

const edgeExports={}
vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../supabase/functions/generate-questions/index.ts',import.meta.url),'utf8'),{ compilerOptions:{ module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022 } }).outputText,{
  exports:edgeExports,require:(name) => name.endsWith('cloudflareAI.ts') ? cloudflare : prompt,Deno:{ env:{ get() {} },serve() {} },crypto,TextEncoder,Error,Response,Request,AbortSignal,setTimeout,fetch,
})
function endpoint({ outputs=[payload(5)],quota=false,rate=false,providerError=false,skip,commitFailure=false,cleanupFailure=false }={}) {
  const secret='test-generator-secret-with-more-than-thirty-two-characters',calls=[],waits=[]
  let apiCalls=0,commits=0
  const env={ QUESTION_GENERATION_SECRET:secret,SUPABASE_URL:'https://db.test',SUPABASE_SERVICE_ROLE_KEY:'server-db-key',CLOUDFLARE_ACCOUNT_ID:'test-account',CLOUDFLARE_API_TOKEN:'server-ai-key' }
  const handler=edgeExports.questionGenerator({ env:(name) => env[name],wait:async (ms) => { waits.push(ms) },fetcher:async (url,options) => {
    if (url.includes('api.cloudflare.com')) {
      const content=outputs[Math.min(apiCalls,outputs.length-1)]; apiCalls++
      if (quota || rate) return Response.json({ success:false,errors:[{ code:quota ? 3036 : 3040,message:quota ? 'Daily free allocation used up' : 'Capacity temporarily exceeded' }] },{ status:429,headers:{ 'Retry-After':'60' } })
      if (providerError) return Response.json({ success:false,errors:[{ message:'Temporary server error' }] },{ status:503 })
      return Response.json({ success:true,result:{ choices:[{ message:{ content:JSON.stringify(content) } }],usage:{ total_tokens:500 } } })
    }
    const name=url.split('/').at(-1),body=JSON.parse(options.body); calls.push({ name,body })
    if (name==='qgen_context') return Response.json({ history:[],daily_unused:0,arena_active:6,daily_request_limit:80,requests_today:0,quota_exhausted_on:null,cooldown_until:null })
    if (name==='qgen_claim') return Response.json(skip ? { skip } : { run_id:'run',token:'claim' })
    if (name==='qgen_request_begin') return Response.json(`request-${apiCalls}`)
    if (name==='qgen_commit_batch') { commits++; if (commitFailure && commits===1) return Response.json({ message:'Temporary database outage' },{ status:503 }); return Response.json(body.p_questions.length) }
    if (name==='qgen_publish') return Response.json({ published:true,date:'2026-11-19' })
    if (name==='qgen_finish_job' && cleanupFailure) return Response.json({ message:'Cleanup unavailable' },{ status:503 })
    if (name==='qgen_request_end' || name==='qgen_finish_job') return Response.json(null)
    throw new Error(`Unexpected RPC ${name}`)
  } })
  return { invoke:(body,credential=secret) => handler(new Request('https://fn.test',{ method:'POST',headers:{ Authorization:`Bearer ${credential}`,'Content-Type':'application/json' },body:JSON.stringify(body) })),stats:() => ({ calls,apiCalls,commits,waits }) }
}
test('unauthenticated/anon-key invocation does no database or Cloudflare work',async () => {
  const api=endpoint(); assert.equal((await api.invoke({ action:'daily_refill' },'public-anon-key')).status,401); assert.equal(api.stats().calls.length,0); assert.equal(api.stats().apiCalls,0)
})
test('strict dry-run generates five/ten without any database writes',async () => {
  for (const [target,count] of [['daily',5],['arena',10]]) {
    const api=endpoint({ outputs:[payload(count)] }),response=await api.invoke({ action:'dry_run',target })
    assert.equal(response.status,200); const result=await response.json(); assert.equal(result.questions.length,count)
    assert.equal(api.stats().apiCalls,1); assert.ok(api.stats().calls.every((call) => call.name==='qgen_context'))
  }
})
test('scheduled Daily/Arena batches are five/ten and database retries reuse the model result',async () => {
  for (const [action,count] of [['daily_refill',5],['arena_rotate',10],['arena_fill',10]]) {
    const api=endpoint({ outputs:[payload(count)],commitFailure:true }),response=await api.invoke({ action })
    assert.equal(response.status,200); assert.equal(api.stats().apiCalls,1); assert.equal(api.stats().commits,2)
    assert.equal(api.stats().calls.find((call) => call.name==='qgen_request_begin').body.p_count,count)
  }
})
test('invalid batches retry with backoff and never partially commit',async () => {
  const api=endpoint({ outputs:[{ questions:questions.slice(0,3) },payload(5)] })
  assert.equal((await api.invoke({ action:'daily_refill' })).status,200)
  assert.equal(api.stats().apiCalls,2); assert.equal(api.stats().commits,1); assert.deepEqual(api.stats().waits,[1000])
  assert.equal(api.stats().calls.find((call) => call.name==='qgen_request_end').body.p_count,3)
  const failing=endpoint({ outputs:[{ questions:[] }] }); assert.equal((await failing.invoke({ action:'daily_refill' })).status,503)
  assert.equal(failing.stats().apiCalls,3); assert.equal(failing.stats().commits,0); assert.deepEqual(failing.stats().waits,[1000,2000])
})
test('quota/rate-limit responses stop the invocation and persist the account-level block',async () => {
  for (const options of [{ quota:true },{ rate:true }]) {
    const api=endpoint(options); assert.equal((await api.invoke({ action:'daily_refill' })).status,429)
    assert.equal(api.stats().apiCalls,1); assert.equal(api.stats().commits,0); assert.equal(api.stats().waits.length,0)
    const end=api.stats().calls.find((call) => call.name==='qgen_request_end'); assert.equal(end.body.p_quota,!!options.quota); assert.equal(end.body.p_cooldown,60)
  }
})
test('stock/due skips and publishing never call Cloudflare',async () => {
  const full=endpoint({ skip:'reserve full' }); assert.equal((await full.invoke({ action:'daily_refill' })).status,200); assert.equal(full.stats().apiCalls,0)
  const publish=endpoint(); assert.equal((await publish.invoke({ action:'daily_publish' })).status,200); assert.equal(publish.stats().apiCalls,0)
})

test('provider outages stay bounded and post-commit cleanup never regenerates a successful batch',async () => {
  const outage=endpoint({ providerError:true }); assert.equal((await outage.invoke({ action:'daily_refill' })).status,503); assert.equal(outage.stats().apiCalls,3); assert.equal(outage.stats().commits,0)
  const committed=endpoint({ cleanupFailure:true }); const response=await committed.invoke({ action:'daily_refill' }); assert.equal(response.status,200); assert.match((await response.json()).warning,/Batch committed/); assert.equal(committed.stats().apiCalls,1); assert.equal(committed.stats().commits,1)
})
