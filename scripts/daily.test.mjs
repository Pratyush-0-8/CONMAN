import test from 'node:test'
import assert from 'node:assert/strict'
import { easternDate, issueCredential, digest, parseDailyJudgment } from '../supabase/functions/_shared/daily.ts'
import { numericalResult, copyDailyResult } from '../src/lib/dailyRules.ts'
import { validateScores } from '../supabase/functions/_shared/judge.ts'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as dailyRules from '../src/lib/dailyRules.ts'
import * as navigation from '../src/lib/navigation.ts'

const scores={ Logic:8,Creativity:7,Relevance:8,Clarity:7,Depth:8 }
test('Eastern dates use actual midnight and DST boundaries',() => {
  assert.equal(easternDate(new Date('2026-11-18T04:59:59Z')),'2026-11-17')
  assert.equal(easternDate(new Date('2026-11-18T05:00:00Z')),'2026-11-18')
  assert.equal(easternDate(new Date('2026-07-01T03:59:59Z')),'2026-06-30')
  assert.equal(easternDate(new Date('2026-07-01T04:00:00Z')),'2026-07-01')
  assert.equal(easternDate(new Date('2026-03-08T06:59:59Z')),'2026-03-08')
  assert.equal(easternDate(new Date('2026-03-08T07:00:00Z')),'2026-03-08')
})
test('server-issued credentials recover one attempt and separate dates/nonces',async () => {
  const secret='a-test-secret-with-at-least-32-characters'
  const first=await issueCredential(secret,'attempt|2026-11-17|nonce-one')
  assert.match(first,/^[a-f0-9]{64}$/)
  assert.equal(await issueCredential(secret,'attempt|2026-11-17|nonce-one'),first)
  assert.notEqual(await issueCredential(secret,'attempt|2026-11-17|nonce-two'),first)
  assert.notEqual(await issueCredential(secret,'attempt|2026-11-18|nonce-one'),first)
  assert.notEqual(await digest(first),first)
})
test('daily rubric accepts only exact integer categories and bounded explanation',() => {
  const judged=parseDailyJudgment(JSON.stringify({ scores,explanation:'Reasoning '.repeat(200) }))
  assert.deepEqual(judged.scores,scores); assert.equal(judged.explanation.length,800)
  for (const category of Object.keys(scores)) for (const invalid of [7.5,-1,11,'8',NaN]) assert.throws(() => validateScores({ ...scores,[category]:invalid }))
  assert.throws(() => parseDailyJudgment(JSON.stringify({ scores,explanation:42 })))
})
test('Copy Result writes only the plain numeric score',async () => {
  const original=Object.getOwnPropertyDescriptor(globalThis,'navigator'),written=[]
  Object.defineProperty(globalThis,'navigator',{ configurable:true,value:{ clipboard:{ writeText:async (value) => written.push(value) } } })
  try {
    for (const score of [0,175,200,250]) { assert.equal(numericalResult(score),String(score)); await copyDailyResult(score) }
    assert.deepEqual(written,['0','175','200','250'])
    for (const invalid of [-1,251,7.5]) assert.throws(() => numericalResult(invalid))
  } finally { if (original) Object.defineProperty(globalThis,'navigator',original); else delete globalThis.navigator }
})

function appHarness(path = '/', gameState = { match:null,queue:null }) {
  let slots=[],cursor=0,pending=[],tree
  const components=new Map()
  const component=(name) => { if (!components.has(name)) components.set(name,Object.defineProperty(() => {},'name',{ value:name })); return components.get(name) }
  const react={
    useState(initial) { const i=cursor++; if (!(i in slots)) slots[i]=typeof initial==='function' ? initial() : initial; return [slots[i],(next) => { slots[i]=typeof next==='function' ? next(slots[i]) : next }] },
    useRef(initial) { const i=cursor++; return slots[i] ||= { current:initial } },
    useCallback(fn,deps) { const i=cursor++,old=slots[i]; if (!old || deps.some((d,k) => d!==old.deps[k])) slots[i]={ fn,deps }; return slots[i].fn },
    useEffect(fn,deps) { const i=cursor++,old=slots[i]; if (!old || deps.some((d,k) => d!==old.deps[k])) { slots[i]={ deps,cleanup:old?.cleanup }; pending.push(() => { slots[i].cleanup?.(); slots[i].cleanup=fn() }) } },
  }
  const listeners=new Map(),entries=[{ path,state:null }]
  let index=0
  const browser={ location:{ pathname:path },scrollTo() {},addEventListener:(name,fn) => listeners.set(name,fn),removeEventListener:(name) => listeners.delete(name) }
  const update=(entry) => { browser.location.pathname=entry.path; browser.history.state=entry.state }
  browser.history={ state:null,pushState:(state,_title,url) => { entries.splice(index+1); entries.push({ path:url,state }); index++; update(entries[index]) },replaceState:(state,_title,url) => { entries[index]={ path:url,state }; update(entries[index]) } }
  const localRequire=(name) => {
    if (name==='react') return react
    if (name==='react/jsx-runtime') return { jsx:(type,props) => ({ type,props }),jsxs:(type,props) => ({ type,props }),Fragment:'Fragment' }
    if (name==='./lib/dailyRules') return dailyRules
    if (name==='./lib/navigation') return navigation
    if (name==='./lib/useAnswerReceipt') return { useAnswerReceipt:()=>null }
    if (name==='./lib/useSocial') return { useSocial:() => ({ invitations:[],error:'',now:Date.now(),refresh:async () => {} }) }
    if (name==='./lib/useRankedGame') return { useRankedGame:(id) => ({ player:id ? { id,name:'tester',elo:500,wins:0,losses:0,draws:0 } : null,history:[],state:gameState,error:'',refresh:async () => {},reloadAccount:async () => {} }) }
    if (name==='./lib/supabase') return { supabase:{ auth:{ getUser:async () => ({ data:{ user:null } }),onAuthStateChange:() => ({ data:{ subscription:{ unsubscribe() {} } } }) } } }
    return new Proxy({},{ get:(_,key) => component(String(key)) })
  }
  const exports={}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/App.tsx',import.meta.url),'utf8'),{ compilerOptions:{ module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX } }).outputText,{ exports,require:localRequire,Date,window:browser,sessionStorage:{ getItem:() => 'arena' },setTimeout,clearTimeout,setInterval,clearInterval })
  return { path:() => browser.location.pathname,move(delta) { index=Math.max(0,Math.min(entries.length-1,index+delta)); update(entries[index]); listeners.get('popstate')?.() },render() { cursor=0; tree=exports.default(); for (const effect of pending.splice(0)) effect(); return tree },close() { for (const slot of slots) slot?.cleanup?.() } }
}
function find(node,name) {
  if (!node || typeof node!=='object') return
  if (Array.isArray(node)) { for (const child of node) { const result=find(child,name); if (result) return result }; return }
  if (node.type?.name===name) return node
  return find(node.props?.children,name)
}
test('actual App opens Daily Five without login and retains Arena auth and signed-in Daily access',async () => {
  const app=appHarness()
  try {
    let tree=app.render(); assert.ok(find(tree,'DailyFive')); assert.equal(find(tree,'SignIn'),undefined)
    await new Promise((resolve) => setImmediate(resolve))
    tree=app.render(); find(tree,'Nav').props.go('home'); tree=app.render(); assert.ok(find(tree,'Landing')); assert.equal(app.path(),'/arena'); assert.equal(find(tree,'Arena'),undefined)
    find(tree,'Landing').props.go('signin'); tree=app.render(); assert.ok(find(tree,'SignIn'))
    find(tree,'SignIn').props.onSignedIn({ id:'test-user',username:'tester',email:'test@example.test',verified:true })
    tree=app.render(); assert.ok(find(tree,'Home')); assert.equal(app.path(),'/arena')
    find(tree,'Nav').props.go('daily'); tree=app.render(); assert.ok(find(tree,'DailyFive')); assert.equal(find(tree,'Nav').props.player.name,'tester'); assert.equal(app.path(),'/')
    app.move(-1); tree=app.render(); assert.ok(find(tree,'Home'))
    app.move(1); tree=app.render(); assert.ok(find(tree,'DailyFive'))
  } finally { app.close() }
})

test('anonymous URL navigation survives back/forward and refresh without a stale Arena preference',async () => {
  const app=appHarness('/')
  try {
    let tree=app.render(); assert.ok(find(tree,'DailyFive'))
    await new Promise((resolve) => setImmediate(resolve))
    find(tree,'Nav').props.go('home'); tree=app.render(); assert.ok(find(tree,'Landing'))
    find(tree,'Nav').props.go('leaderboard'); tree=app.render(); assert.ok(find(tree,'Leaderboard')); assert.equal(app.path(),'/leaderboard')
    app.move(-1); tree=app.render(); assert.ok(find(tree,'Landing'))
    app.move(-1); tree=app.render(); assert.ok(find(tree,'DailyFive'))
    app.move(1); tree=app.render(); assert.ok(find(tree,'Landing'))
  } finally { app.close() }
  for (const path of ['/','/arena','/leaderboard']) {
    const fresh=appHarness(path)
    try { fresh.render(); await new Promise((resolve) => setImmediate(resolve)); const tree=fresh.render(); assert.ok(find(tree,path==='/' ? 'DailyFive' : path==='/arena' ? 'Landing' : 'Leaderboard')) }
    finally { fresh.close() }
  }
})

test('public player links survive signed-in auth restoration and social navigation',async () => {
  const id='20000000-0000-4000-8000-000000000001',app=appHarness('/players/'+id)
  try {
    let tree=app.render(); assert.ok(find(tree,'Social')); assert.equal(find(tree,'Social').props.profileId,id)
    // Use the existing sign-in callback while retaining the profile destination.
    find(tree,'Nav').props.onSignIn(); tree=app.render()
    await new Promise(resolve => setImmediate(resolve)); tree=app.render()
    find(tree,'SignIn').props.onSignedIn({ id:'test-user',username:'tester',verified:true })
    tree=app.render(); assert.equal(find(tree,'Social').props.profileId,id); assert.equal(app.path(),'/players/'+id)
    find(tree,'Social').props.openProfile(); tree=app.render(); assert.equal(app.path(),'/friends')
    app.move(-1); tree=app.render(); assert.equal(find(tree,'Social').props.profileId,id)
  } finally { app.close() }
})
test('a friend match takes over Daily Five and restores the existing Arena view',async () => {
  const state={ match:null,queue:null },app=appHarness('/',state)
  try {
    app.render(); await new Promise(resolve => setImmediate(resolve))
    let tree=app.render(); find(tree,'Nav').props.go('home'); tree=app.render(); find(tree,'Landing').props.go('signin'); tree=app.render()
    find(tree,'SignIn').props.onSignedIn({ id:'test-user',username:'tester',verified:true }); tree=app.render()
    find(tree,'Nav').props.go('daily'); tree=app.render(); assert.ok(find(tree,'DailyFive'))
    state.match={ id:'test-match',state:'active',round_start:new Date(Date.now()-6000).toISOString(),question:'A question?',players:[{ player_id:'test-user',username:'tester',input_mode:'typing' },{ player_id:'friend',username:'friend',input_mode:'typing' }] }
    tree=app.render(); assert.ok(find(tree,'Arena')); assert.equal(find(tree,'DailyFive'),undefined)
  } finally { app.close() }
})
