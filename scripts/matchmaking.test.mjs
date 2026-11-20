import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function load(file, modules, globals = {}) {
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText, { exports, require: name => modules[name] || {}, Date, ...globals })
  return exports
}
const walk = (node, predicate) => {
  if (!node || typeof node !== 'object') return undefined
  if (predicate(node)) return node
  for (const child of [node.props?.children].flat(Infinity)) { const found = walk(child, predicate); if (found) return found }
}

test('actual matchmaking screen starts at 00:00 and displays terminal copy and working retry/home controls', () => {
  let retry = 0, home = 0
  const fixed = Date.now(), Button = () => {}
  const { Matchmaking } = load('src/screens/Matchmaking.tsx', {
    react: { useState: () => [fixed, () => {}], useEffect: () => {} },
    'react/jsx-runtime': { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) },
    '../components/ui': { Button },
  })
  const props = { player: { name: 'Alice', elo: 500 }, opp: null, joinedAt: new Date(fixed).toISOString(), clockOffset: 0, onCancel: () => home++, onRetry: () => retry++ }
  const search = Matchmaking(props)
  assert.ok(walk(search, n => n.props?.children === '00:00'))
  const expired = Matchmaking({ ...props, expired: true })
  for (const text of ['No opponents available right now.', "Looks like nobody's searching for a match. Try again in a bit!"])
    assert.ok(walk(expired, n => n.props?.children === text))
  walk(expired, n => n.type === Button && n.props.children === 'Try Again').props.onClick()
  walk(expired, n => n.type === Button && n.props.children === 'Back to Home').props.onClick()
  assert.equal(retry, 1); assert.equal(home, 1)
})

test('matchmaking transport uses server attempt/CAS tokens and token-scoped cancellation', async () => {
  const calls = []
  const { searchMatch, cancelQueue } = load('src/lib/matchService.ts', {
    './supabase': { supabase: { rpc: async (name, args) => { calls.push({ name, args }); return { data: null } } } },
  })
  await searchMatch('typing', 'new', true, 'old')
  await searchMatch('typing', 'new')
  await cancelQueue('old')
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { name: 'ranked_search', args: { p_mode: 'typing', p_join: true, p_attempt: 'new', p_previous: 'old' } },
    { name: 'ranked_search', args: { p_mode: 'typing', p_join: false, p_attempt: 'new', p_previous: null } },
    { name: 'ranked_cancel_search', args: { p_attempt: 'old' } },
  ])
})

test('forward timeout upgrade preserves existing queue start/mode and all historical gameplay rows', async () => {
  const { PGlite } = await import('@electric-sql/pglite')
  const { createLegacyFixture } = await import('./sql-fixture.mjs')
  const db = new PGlite(), target = '202611200003_matchmaking_timeout.sql'
  try {
    await createLegacyFixture(db)
    for (const file of fs.readdirSync('supabase/migrations').filter(f => f.endsWith('.sql') && f < target).sort())
      await db.exec(fs.readFileSync('supabase/migrations/'+file,'utf8'))
    await db.exec(`insert into auth.users(id,email,email_confirmed_at) values('82000000-0000-4000-8000-000000000001','upgrade@example.test',now());
      insert into public.profiles(id,username) values('82000000-0000-4000-8000-000000000001','upgrade_player');
      select set_config('request.jwt.claim.sub','82000000-0000-4000-8000-000000000001',false);
      select public.ranked_queue_match('typing',true);`)
    const before = (await db.query('select to_jsonb(q) old_queue from public.ranked_queue q')).rows[0].old_queue
    const profiles = (await db.query('select to_jsonb(p) profile from public.profiles p')).rows
    await db.exec(fs.readFileSync('supabase/migrations/'+target,'utf8'))
    assert.deepEqual((await db.query("select to_jsonb(q)-'attempt_id'-'expires_at' old_queue from public.ranked_queue q")).rows[0].old_queue, before)
    assert.deepEqual((await db.query('select to_jsonb(p) profile from public.profiles p')).rows, profiles)
    const { rows } = await db.query('select public.ranked_state() state')
    assert.equal(rows[0].state.search.status,'searching')
    assert.equal(rows[0].state.search.attempt_id,rows[0].state.queue.attempt_id)
  } finally { await db.close() }
})
