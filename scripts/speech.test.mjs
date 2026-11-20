import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import ts from 'typescript'

function harness({ supported = true, media } = {}) {
  let slots = [], cursor = 0, cleanup, effect, rec
  const timers = new Map()
  let timerId = 0
  class Recognition {
    constructor() { rec = this }
    start() { this.onstart?.() }
    stop() { this.stopped = true }
    abort() { this.aborted = true }
  }
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], v => { slots[i] = typeof v === 'function' ? v(slots[i]) : v }] },
    useRef(initial) { return slots[cursor++] ||= { current: initial } },
    useCallback: f => f,
    useEffect(fn) { if (!effect) effect = fn },
  }
  const exports = {}
  vm.runInNewContext(ts.transpileModule(fs.readFileSync('src/lib/speech.ts', 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText, { exports, require: () => react, window: supported ? { SpeechRecognition: Recognition } : {}, navigator: { mediaDevices: { getUserMedia: media } }, Error, DOMException,
    setTimeout(fn, ms) { const id = ++timerId; timers.set(id, { fn, ms }); return id }, clearTimeout(id) { timers.delete(id) },
  })
  return { exports, timers, rec: () => rec,
    render() { cursor = 0; const value = exports.useSpeech('Saved words'); if (!cleanup && effect) cleanup = effect(); return value },
    close() { cleanup?.() },
  }
}
test('voice preflight rejects unsupported recognition before a player joins an unwinnable voice round', async () => {
  let opened = false
  const h = harness({ supported: false, media: async () => { opened = true } })
  await assert.rejects(h.exports.requestMicrophone(), /Choose Typing/)
  assert.equal(opened, false)
})
test('microphone preflight releases tracks and explains permission failures', async () => {
  let stopped = false
  await harness({ media: async () => ({ getAudioTracks: () => [{ readyState: 'live' }], getTracks: () => [{ stop() { stopped = true } }] }) }).exports.requestMicrophone()
  assert.equal(stopped, true)
  await assert.rejects(harness({ media: async () => { throw new DOMException('Denied', 'NotAllowedError') } }).exports.requestMicrophone(), /Allow microphone access/)
})
test('voice stop ends capture immediately, permits final pre-stop speech delivery for 1s, and cleans up on navigation', async () => {
  const h = harness()
  h.render()
  assert.equal(h.render().status, 'listening')
  h.rec().onresult({ results: [[{ transcript: 'Recognized speech' }]] })
  const state = h.render(), final = state.finish()
  assert.equal(h.rec().stopped, true)
  assert.equal([...h.timers.values()][0].ms, 1000)
  h.rec().onresult({ results: [[{ transcript: 'Final recognized speech' }]] })
  h.rec().onend()
  assert.equal(await final, 'Saved words Final recognized speech')
  h.close()
  assert.equal(h.rec().aborted, true)
  assert.equal(h.timers.size, 0)
})
test('failed transcription has an explicit error state and teardown prevents late speech changes', () => {
  const h = harness()
  h.render()
  h.rec().onerror({ error: 'network' })
  assert.equal(h.render().status, 'error')
  h.close()
  h.rec().onresult({ results: [[{ transcript: 'Late speech' }]] })
  assert.equal(h.render().text, 'Saved words')
})
