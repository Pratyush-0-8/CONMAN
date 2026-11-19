import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'
import * as population from '../src/lib/population.ts'
import { readNavigation, navigationPath } from '../src/lib/navigation.ts'

const bins=(entries) => Array.from({ length:25 },(_,i) => ({ from:i*10,to:i===24 ? 250 : i*10+9,count:entries[i] || 0 }))
function renderPopulation(data,score) {
  const exports={}
  const component=(name) => Object.defineProperty(() => {},'name',{ value:name })
  const localRequire=(name) => {
    if (name==='react/jsx-runtime') return { jsx:(type,props) => ({ type,props }),jsxs:(type,props) => ({ type,props }) }
    if (name==='../lib/population') return population
    return new Proxy({},{ get:(_,key) => component(String(key)) })
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/screens/DailyFive.tsx',import.meta.url),'utf8'),{ compilerOptions:{ target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX } }).outputText,{ exports,require:localRequire })
  return exports.Population({ population:data,score })
}
const flatten=(node) => node==null || typeof node==='boolean' ? '' : typeof node!=='object' ? String(node) : Array.isArray(node) ? node.map(flatten).join('') : flatten(node.props?.children)
function elements(node,type) {
  if (!node || typeof node!=='object') return []
  if (Array.isArray(node)) return node.flatMap((child) => elements(child,type))
  return [...(node.type===type ? [node] : []),...elements(node.props?.children,type)]
}
test('strictly-below comparison excludes ties, rounds, and requires two completions',() => {
  assert.equal(population.strictlyBelowPercent(4,1),25) // 100, 200, 200, 250; user 200.
  assert.equal(population.strictlyBelowPercent(3,1),33)
  assert.equal(population.strictlyBelowPercent(2,0),0)
  assert.equal(population.strictlyBelowPercent(1,0),null)
  assert.equal(population.strictlyBelowPercent(4,undefined),null) // Never substitute the old midpoint percentile.
})
test('smoothing follows real bucket weights and preserves separated populations',() => {
  const data=bins({ 4:2,20:2 }),curve=population.populationCurve(data,4)
  assert.ok(curve.line.includes(' C')); assert.ok(curve.area.endsWith(' Z'))
  assert.equal(curve.samples.length,101)
  // The existing 35-point smoothing keeps two clear peaks without requiring a near-zero valley.
  assert.ok(curve.samples[18].density>curve.samples[50].density*5)
  assert.ok(curve.samples[82].density>curve.samples[50].density*5)
  const shifted=population.populationCurve(bins({ 4:20,20:2 }),22)
  assert.ok(shifted.samples[18].density>shifted.samples[82].density*9)
  assert.equal(population.populationCurve(data,1),null)
  assert.equal(population.populationCurve(bins({}),5),null)
})
test('small population renders neither a curve nor a misleading percentage',() => {
  const tree=renderPopulation({ count:1,below_count:0,percentile:50,bins:bins({ 20:1 }) },200)
  assert.ok(flatten(tree).includes('Not enough players to compare yet.'))
  assert.equal(elements(tree,'svg').length,0)
  assert.equal(flatten(tree).includes('Better than'),false)
})
test('player marker stays at its exact 0–250 position and comparison is beneath the curve',() => {
  for (const [score,x] of [[0,38],[125,350],[250,662]]) {
    const tree=renderPopulation({ count:4,below_count:1,percentile:50,bins:bins({ 4:1,20:2,24:1 }) },score)
    const marker=elements(tree,'line').find((line) => line.props.stroke==='#38C994')
    assert.equal(marker.props.x1,x); assert.equal(marker.props.x2,x)
    assert.ok(flatten(tree).includes('Better than 25% of players'))
    assert.equal(elements(tree,'rect').length,0)
  }
})
test('root always means Daily Five; auth return destinations and page paths survive refresh',() => {
  assert.deepEqual(readNavigation('/', 'home'),{ page:'daily',route:'app' })
  assert.deepEqual(readNavigation('/arena'),{ page:'home',route:'app' })
  assert.deepEqual(readNavigation('/signin','home'),{ page:'home',route:'signin' })
  assert.equal(navigationPath({ page:'leaderboard',route:'app' }),'/leaderboard')
})

test('navigation exposes Daily Five, Arena, Leaderboard, and a logo link home for guests and members',() => {
  const exports={}
  const component=(name) => Object.defineProperty(() => {},'name',{ value:name })
  const localRequire=(name) => {
    if (name==='react/jsx-runtime') return { jsx:(type,props) => ({ type,props }),jsxs:(type,props) => ({ type,props }),Fragment:'Fragment' }
    if (name==='../lib/navigation') return { pagePath:(page) => navigationPath({ page,route:'app' }) }
    return new Proxy({},{ get:(_,key) => component(String(key)) })
  }
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(new URL('../src/components/Nav.tsx',import.meta.url),'utf8'),{ compilerOptions:{ target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX } }).outputText,{ exports,require:localRequire })
  for (const player of [null,{ name:'tester',elo:500 }]) {
    const visited=[]
    const tree=exports.Nav({ page:'daily',player,go:(page) => visited.push(page),onSignIn() {},onSignUp() {} })
    const logo=elements(tree,'a').find((link) => link.props['aria-label']==='CONMAN home')
    assert.equal(logo.props.href,'/')
    logo.props.onClick({ button:0,preventDefault() {} }); assert.deepEqual(visited,['daily'])
    for (const nav of elements(tree,'nav').filter((nav) => nav.props['aria-label']==='Main navigation')) {
      for (const name of ['Daily Five','Arena','Leaderboard']) assert.ok(flatten(nav).includes(name))
    }
    if (!player) { assert.ok(flatten(tree).includes('Sign In')); assert.ok(flatten(tree).includes('Create Account')) }
  }
})
