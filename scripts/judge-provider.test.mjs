import test from 'node:test'
import assert from 'node:assert/strict'
import { judgeWithProviders, JudgeProviderError } from '../supabase/functions/_shared/judgeProvider.ts'
import { MODEL, RUBRIC, parseJudgment } from '../supabase/functions/_shared/judge.ts'
const scores={Logic:8,Creativity:7,Relevance:8,Clarity:7,Depth:8}
const content=JSON.stringify({player1:{scores},player2:{scores}})
const config={AZURE_OPENAI_ENDPOINT:'https://test.services.ai.azure.com',AZURE_OPENAI_API_KEY:'azure-secret',AZURE_OPENAI_DEPLOYMENT:'gpt-4.1-mini',GROQ_API_KEY:'groq-secret'}
const options={prompt:RUBRIC,input:{question:'Question?',player1Answer:'First final',player2Answer:'Second final'},parse:parseJudgment,env:n=>config[n]}
const ok=()=>Response.json({choices:[{message:{content}}]})
test('Azure v1 uses api-key, deployment name and the exact existing prompt and joint payload',async()=>{
 let calls=0
 for(const endpoint of [config.AZURE_OPENAI_ENDPOINT,config.AZURE_OPENAI_ENDPOINT+'/openai/v1/',config.AZURE_OPENAI_ENDPOINT+'/openai/v1/responses',config.AZURE_OPENAI_ENDPOINT+'/openai/v1/chat/completions']){
  const result=await judgeWithProviders({...options,env:n=>n==='AZURE_OPENAI_ENDPOINT'?endpoint:config[n],fetcher:async(url,request)=>{
   calls++;assert.equal(url,'https://test.services.ai.azure.com/openai/v1/chat/completions')
   assert.equal(request.headers['api-key'],'azure-secret');assert.equal(request.headers.Authorization,undefined)
   const body=JSON.parse(request.body)
   assert.equal(body.model,'gpt-4.1-mini');assert.equal(body.temperature,0.2);assert.equal(body.max_completion_tokens,3000)
   assert.deepEqual(body.response_format,{type:'json_object'})
   assert.equal(body.messages[0].content,RUBRIC);assert.deepEqual(JSON.parse(body.messages[1].content),options.input)
   return ok()
  }})
  assert.equal(result.model,'azure:gpt-4.1-mini');assert.equal(result.provider,'azure');assert.deepEqual(result.judgment,{player1:scores,player2:scores})
 }
 assert.equal(calls,4)
})
test('transient Azure errors fall back once, evaluating BOTH players together with Groq',async()=>{
 for(const failure of [408,429,500,502,503,504,'network','timeout']){
  const calls=[]
  const result=await judgeWithProviders({...options,fetcher:async(url,request)=>{
   calls.push({url,request,body:JSON.parse(request.body)})
   if(calls.length===1){
    if(typeof failure==='string')throw new Error('private-azure-key must never escape')
    return new Response('private provider diagnostics',{status:failure})
   }
   assert.equal(request.headers.Authorization,'Bearer groq-secret');assert.equal(request.headers['api-key'],undefined)
   return ok()
  }})
  assert.equal(calls.length,2);assert.equal(calls[1].body.model,MODEL)
  assert.deepEqual(calls[0].body.messages,calls[1].body.messages)
  assert.equal(result.provider,'groq');assert.equal(result.model,MODEL)
 }
})
test('permanent Azure errors and invalid scoring JSON do not silently downgrade or fabricate results',async()=>{
 for(const status of [400,401,403,404,422,200]){
  let calls=0
  await assert.rejects(judgeWithProviders({...options,fetcher:async()=>{
   calls++;return status===200?Response.json({choices:[{message:{content:'{"player1":{"scores":{"Logic":12}}}'}}]}):new Response('azure-secret',{status})
  }}),error=>error instanceof JudgeProviderError&&!error.message.includes('azure-secret'))
  assert.equal(calls,1)
 }
})
test('both providers rate limiting stays recoverable and exposes no credential or raw provider body',async()=>{
 let calls=0
 await assert.rejects(judgeWithProviders({...options,fetcher:async()=>{calls++;return new Response('azure-secret groq-secret',{status:429})}}),error=>error.status===429&&!/azure-secret|groq-secret/.test(error.message))
 assert.equal(calls,2)
})
test('provider timeouts share the original 45-second inference budget',async(t)=>{
 const timeouts=[],original=AbortSignal.timeout
 t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return original(ms)})
 let calls=0
 await judgeWithProviders({...options,fetcher:async()=>++calls===1?new Response('',{status:503}):ok()})
 assert.deepEqual(timeouts,[20000,25000])
})
