import test from 'node:test'
import assert from 'node:assert/strict'
import { validAnswer, inputDeadline, roundPhase } from '../src/lib/rankedRules.ts'
import { eloDelta } from '../src/lib/game.ts'
import { parseJudgment, validateScores } from '../supabase/functions/_shared/judge.ts'

test('cross-mode clocks share thinking and have mode-specific deadlines', () => {
  const start = 10000
  assert.equal(roundPhase(9999,start,'voice'),'matched')
  for (const mode of ['voice','typing']) {
    assert.equal(roundPhase(start,start,mode),'think')
    assert.equal(roundPhase(start+9999,start,mode),'think')
    assert.equal(roundPhase(start+10000,start,mode),'input')
    assert.equal(roundPhase(start+11000,start,mode,true),'waiting')
  }
  assert.equal(inputDeadline(start,'voice'),45000)
  assert.equal(inputDeadline(start,'typing'),55000)
  assert.equal(roundPhase(45000,start,'voice'),'waiting')
  assert.equal(roundPhase(45000,start,'typing'),'input')
  assert.equal(roundPhase(55000,start,'typing'),'waiting')
})
test('editable answers accept backspace, deletion, middle edits, replacement and Unicode within the length limit', () => {
  for (const text of ['hell', 'Hello', 'heXllo', 'world hello', '', '你好世界', '😀!']) assert.equal(validAnswer(text),true)
  assert.equal(validAnswer('x'.repeat(12000)),true)
  assert.equal(validAnswer('x'.repeat(12001)),false)
})
test('ELO uses K=32 and one shared formula', () => {
  assert.equal(eloDelta(500,500,'win'),16)
  assert.equal(eloDelta(500,500,'loss'),-16)
  assert.equal(eloDelta(500,500,'draw'),0)
  assert.ok(eloDelta(500,900,'win')>16)
})
test('judge validates every category and rejects malformed or fabricated output', () => {
  const scores = { Logic: 7, Creativity: 6, Relevance: 8, Clarity: 7, Depth: 6 }
  assert.deepEqual(validateScores(scores),scores)
  const result = parseJudgment(JSON.stringify({ player1:{ scores }, player2:{ scores } }))
  assert.deepEqual(result.player1,scores)
  assert.deepEqual(result.player2,scores)
  for (const category of Object.keys(scores)) {
    for (const invalid of [6.5, -1, 11, '7', NaN, Infinity]) assert.throws(() => validateScores({ ...scores, [category]: invalid }))
    for (const valid of [0, 10]) assert.doesNotThrow(() => validateScores({ ...scores, [category]: valid }))
  }
  const lowercase = Object.fromEntries(Object.entries(scores).map(([key,value]) => [key.toLowerCase(),value]))
  assert.throws(() => validateScores(lowercase))
  for (const invalid of [null,[],{}, { ...scores, Logic:11 }, { ...scores, Logic:-1 }, { ...scores, Logic:'7' }, { ...scores, Logic:NaN }, { ...scores, extra:1 }]) assert.throws(() => validateScores(invalid))
  assert.throws(() => parseJudgment('not json'))
  assert.throws(() => parseJudgment('{"winner":"player1"}'))
})
