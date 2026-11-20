import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import * as rules from "../src/lib/rankedRules.ts";

const tick = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function harness(overrides = {}) {
  let time = 10000,
    slots = [],
    cursor = 0,
    effects = [],
    sequence = 0,
    state,
    refreshed = 0,
    uuid = 0;
  const timers = new Map(),
    listeners = new Map(),
    writes = [];
  const snapshot = (extra = {}) => ({
    status: "ready",
    answer_text: "Saved text",
    revision: 4,
    writer_id: "writer-1",
    locked_at: null,
    server_now: "",
    ...extra,
  });
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        slots[i],
        (next) => {
          slots[i] = typeof next === "function" ? next(slots[i]) : next;
        },
      ];
    },
    useRef(initial) {
      const i = cursor++;
      return (slots[i] ||= { current: initial });
    },
    useCallback(fn, deps) {
      const i = cursor++,
        old = slots[i];
      if (!old || deps.some((d, k) => d !== old.deps[k])) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++,
        old = slots[i];
      if (!old || deps.some((d, k) => d !== old.deps[k])) {
        slots[i] = { deps, cleanup: old?.cleanup, fn };
        effects.push(i);
      }
    },
  };
  const receipts = new Map();
  if (overrides.receipt) receipts.set("match:alice", overrides.receipt);
  const receiptService = {
    readReceipt: (key) => receipts.get(key) || null,
    writeReceipt: (key, value) => {
      if (value) receipts.set(key, value);
      else receipts.delete(key);
    },
    reconcileReceipt: (key, text, locked) => {
      const r = receipts.get(key);
      if (r && locked)
        receipts.set(key, {
          text: r.text,
          confirmed: r.text === text,
          error: r.text === text ? undefined : "Final answer not saved",
        });
    },
  };
  const service = {
    openAnswerSession: overrides.open || (async () => snapshot()),
    saveAnswer: async (...args) => {
      writes.push(args);
      return overrides.save
        ? overrides.save(...args)
        : snapshot({
            status: args[2] ? "locked" : "saved",
            answer_text: args[1],
            revision: args[3],
            locked_at: args[2] ? "locked" : null,
          });
    },
  };
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/lib/useAnswerSync.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name) =>
        name === "react"
          ? react
          : name === "./rankedRules"
            ? rules
            : name === "./answerReceipt"
              ? receiptService
              : service,
      Date: class extends Date {
        static now() {
          return time;
        }
      },
      crypto: { randomUUID: () => `writer-${++uuid}` },
      Error,
      window: {
        addEventListener: (name, fn) => listeners.set(name, fn),
        removeEventListener: (name) => listeners.delete(name),
      },
      setInterval: (fn, ms) => {
        const id = ++sequence;
        timers.set(id, { fn, ms });
        return id;
      },
      clearInterval: (id) => timers.delete(id),
    },
  );
  const mine = {
    player_id: "alice",
    input_mode: overrides.mode || "typing",
    answer_text: "Saved text",
    answer_revision: 4,
    answer_writer: null,
    locked_at: null,
    deadline: new Date(20000).toISOString(),
  };
  const render = () => {
    cursor = 0;
    state = exports.useAnswerSync("match", mine, new Date(0).toISOString(), time, async () => {
      refreshed++;
    });
    for (const i of effects.splice(0)) {
      slots[i].cleanup?.();
      slots[i].cleanup = slots[i].fn();
    }
    return state;
  };
  return {
    render,
    mine,
    writes,
    receipts,
    timers,
    listeners,
    snapshot,
    now: () => time,
    time: (next) => {
      time = next;
    },
    event: (name) => listeners.get(name)?.(),
    pulse: () => {
      for (const timer of timers.values()) timer.fn();
    },
    strict: () => {
      for (const slot of slots)
        if (slot?.fn && "cleanup" in slot) {
          slot.cleanup?.();
          slot.cleanup = slot.fn();
        }
    },
    close: () => {
      for (const slot of slots) slot?.cleanup?.();
    },
    refreshed: () => refreshed,
  };
}
async function ready(h) {
  h.render();
  await tick();
  return h.render();
}

test("edited drafts preserve backspace, middle changes, deletion, selection replacement and rapid input", async () => {
  const h = harness();
  let s = await ready(h);
  assert.equal(s.text, "Saved text");
  for (const value of ["Saved tex", "Edited tex", "", "Replacement"]) {
    s.change(value);
    h.pulse();
    await tick();
    s = h.render();
    assert.equal(h.writes.at(-1)[1], value);
  }
  s.change("first");
  s.change("latest before render");
  await s.submit();
  await tick();
  s = h.render();
  assert.equal(h.writes.at(-1)[1], "latest before render");
  assert.equal(s.done, true);
  h.close();
});
test("final submission overtakes an unresolved autosave and late draft errors cannot replace its status", async () => {
  const draft = deferred(),
    h = harness({
      save: async (_id, text, final, revision) =>
        final
          ? h.snapshot({ status: "locked", answer_text: text, revision, locked_at: "locked" })
          : draft.promise,
    });
  let s = await ready(h);
  s.change("Old draft");
  h.pulse();
  await tick();
  assert.equal(h.writes.length, 1);
  s.change("New final edit");
  const final = s.submit();
  assert.equal(h.writes.length, 2);
  assert.ok(h.writes[1][3] > h.writes[0][3]);
  assert.equal(h.writes[1][1], "New final edit");
  await final;
  draft.reject(Error("Old autosave failed"));
  await tick();
  s = h.render();
  assert.equal(s.done, true);
  assert.equal(s.error, "");
  h.close();
});
test("lost final responses retry the same immutable text/revision and never reopen editing", async () => {
  let fail = true;
  const h = harness({
    save: async (_id, text, final, revision) => {
      if (final && fail) throw Error("Network timeout");
      return h.snapshot({ status: "locked", answer_text: text, revision, locked_at: "locked" });
    },
  });
  let s = await ready(h);
  s.change("Final selected answer");
  await s.submit();
  await tick();
  s = h.render();
  assert.equal(s.finalizing, true);
  assert.match(s.error, /Network timeout/);
  s.change("A conflicting new answer");
  await tick();
  assert.equal(h.render().text, "Final selected answer");
  fail = false;
  h.event("online");
  await tick();
  s = h.render();
  assert.equal(s.done, true);
  assert.deepEqual(h.writes[0], h.writes[1]);
  h.close();
});
test("draft retry saves a draft rather than prematurely submitting it; deadlines block late input", async () => {
  let fail = true;
  const h = harness({
    save: async (_id, text, final, revision) => {
      if (fail) throw Error("Offline");
      return h.snapshot({
        status: final ? "locked" : "saved",
        answer_text: text,
        revision,
        locked_at: final ? "locked" : null,
      });
    },
  });
  let s = await ready(h);
  s.change("An editable draft");
  h.pulse();
  await tick();
  s = h.render();
  assert.match(s.error, /Offline/);
  fail = false;
  await s.retry();
  assert.equal(h.writes.at(-1)[2], false);
  s = h.render();
  assert.equal(s.finalizing, false);
  h.time(20000);
  s.change("Too late");
  await tick();
  assert.equal(h.render().text, "An editable draft");
  await s.submit();
  assert.equal(h.writes.at(-1)[1], "An editable draft");
  h.close();
});
test("refresh acquisition fences old editors, waits for canonical text, and tolerates StrictMode effects", async () => {
  const opening = deferred(),
    h = harness({ open: () => opening.promise });
  let s = h.render();
  assert.equal(s.ready, false);
  s.change("Must not edit before recovery");
  h.strict();
  opening.resolve(h.snapshot({ answer_text: "Recovered server text", revision: 19 }));
  await tick();
  s = h.render();
  assert.equal(s.text, "Recovered server text");
  assert.equal(s.ready, true);
  s.change("New edit after refresh");
  await s.submit();
  assert.equal(h.writes[0][3], 20);
  h.close();
  assert.equal(h.timers.size, 0);
  assert.equal(h.listeners.size, 0);
  const other = harness({ open: async () => h.snapshot({ status: "superseded" }) });
  s = await ready(other);
  assert.equal(s.superseded, true);
  s.change("Cannot write");
  await s.submit();
  assert.equal(other.writes.length, 0);
  other.close();
});
test("duplicate clicks share one final; server-expired or superseded drafts never look successfully synced", async () => {
  const final = deferred(),
    h = harness({ save: () => final.promise });
  let s = await ready(h);
  s.change("One final");
  const one = s.submit(),
    two = s.submit();
  assert.equal(h.writes.length, 1);
  final.resolve(h.snapshot({ status: "locked", answer_text: "One final", locked_at: "locked" }));
  await Promise.all([one, two]);
  h.close();
  const expired = harness({
    save: async () =>
      expired.snapshot({ status: "expired", answer_text: "Last server text", locked_at: "locked" }),
  });
  s = await ready(expired);
  s.change("Unsynced last edit");
  await s.submit();
  s = expired.render();
  assert.equal(s.done, false);
  assert.match(s.error, /final answer was not saved/);
  expired.close();
  const stolen = harness({ save: async () => stolen.snapshot({ status: "superseded" }) });
  s = await ready(stolen);
  s.change("Local edit");
  stolen.pulse();
  await tick();
  s = stolen.render();
  assert.equal(s.superseded, true);
  stolen.close();
});
test("voice transcript corrections and final recognition results use the same versioned path", async () => {
  const h = harness({ mode: "voice" });
  let s = await ready(h);
  s.change("An interim transcrip");
  h.pulse();
  await tick();
  s = h.render();
  s.change("A corrected transcript");
  h.pulse();
  await tick();
  h.time(20500);
  await s.submit("Final recognition result");
  assert.equal(h.writes.at(-1)[1], "Final recognition result");
  assert.equal(h.writes.at(-1)[2], true);
  h.close();
});

test("actual AppendInput permits editing and blocks paste/drop, including beforeinput variants", () => {
  const exports = {},
    changes = [],
    components = new Map();
  const localRequire = (name) => {
    if (name === "react/jsx-runtime")
      return { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) };
    return new Proxy(
      {},
      {
        get: (_, key) => {
          if (!components.has(key)) components.set(key, () => {});
          return components.get(key);
        },
      },
    );
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/screens/Arena.tsx", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    { exports, require: localRequire },
  );
  const tree = exports.AppendInput({
    text: "Full answer",
    onChange: (value) => changes.push(value),
    disabled: false,
  });
  const textarea = tree.props.children.find((child) => child.type === "textarea").props;
  for (const value of ["Full answe", "Middle edit", "", "Replaced"])
    textarea.onChange({ currentTarget: { value } });
  assert.deepEqual(changes, ["Full answe", "Middle edit", "", "Replaced"]);
  assert.equal(textarea.disabled, false);
  let blocked = 0;
  textarea.onPaste({ preventDefault: () => blocked++ });
  textarea.onDrop({ preventDefault: () => blocked++ });
  for (const inputType of ["insertFromPaste", "insertFromDrop"])
    textarea.onBeforeInput({ nativeEvent: { inputType }, preventDefault: () => blocked++ });
  for (const inputType of [
    "deleteContentBackward",
    "deleteContentForward",
    "insertReplacementText",
    "insertCompositionText",
  ])
    textarea.onBeforeInput({
      nativeEvent: { inputType },
      preventDefault: () => {
        throw Error("Ordinary editing was blocked");
      },
    });
  assert.equal(blocked, 4);
});

function arenaHarness(mode = "typing") {
  let slots = [],
    cursor = 0,
    effects = [],
    calls = 0,
    retries = 0;
  const react = {
    useRef(initial) {
      const i = cursor++;
      return (slots[i] ||= { current: initial });
    },
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
      return [slots[i], () => {}];
    },
    useEffect(fn, deps) {
      const i = cursor++,
        old = slots[i];
      if (!old || deps.some((d, k) => d !== old[k])) {
        slots[i] = deps;
        effects.push(fn);
      }
    },
  };
  const sync = {
    text: "Most recent input",
    ready: true,
    done: false,
    finalizing: false,
    submitting: false,
    superseded: false,
    error: "",
    change: () => {},
    submit: (...args) => {
      assert.equal(args.length, 0);
      calls++;
    },
    retry: () => {
      retries++;
    },
  };
  const exports = {},
    components = new Map();
  const component = (name) => {
    if (!components.has(name))
      components.set(
        name,
        Object.defineProperty(() => {}, "name", { value: name }),
      );
    return components.get(name);
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/screens/Arena.tsx", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    {
      exports,
      require: (name) =>
        name === "react"
          ? react
          : name === "../lib/useAnswerSync"
            ? { useAnswerSync: () => sync }
            : name === "react/jsx-runtime"
              ? {
                  jsx: (type, props) => ({ type, props }),
                  jsxs: (type, props) => ({ type, props }),
                }
              : new Proxy({}, { get: (_, key) => component(String(key)) }),
      Math,
      Date,
      window: { location: { reload() {} } },
    },
  );
  const mine = {
    player_id: "alice",
    input_mode: mode,
    deadline: new Date(20000).toISOString(),
    locked_at: null,
  };
  const render = (now) => {
    cursor = 0;
    const tree = exports.Arena({
      player: { name: "Alice" },
      opp: { name: "Bob" },
      match: {
        id: "match",
        round_start: new Date(0).toISOString(),
        question: "Shared question",
        players: [mine],
      },
      mine,
      now,
      onRefresh: async () => {},
    });
    for (const effect of effects.splice(0)) effect();
    return tree;
  };
  const find = (node, name) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const child of node) {
        const result = find(child, name);
        if (result) return result;
      }
    } else if (node.type?.name === name) return node;
    else return find(node.props?.children, name);
  };
  return { sync, render, find, calls: () => calls, retries: () => retries };
}
test("actual Arena auto-submits at the typing deadline using the synchronous latest-text reference", () => {
  const h = arenaHarness();
  h.render(19999);
  assert.equal(h.calls(), 0);
  h.render(20000);
  assert.equal(h.calls(), 1);
  h.render(20050);
  assert.equal(h.calls(), 1);
});
test("actual Arena does not start a microphone when recovery finishes after the deadline, but preserves an already-running final transcript", () => {
  const h = arenaHarness("voice");
  h.sync.ready = false;
  let tree = h.render(19999);
  assert.equal(h.find(tree, "VoiceInput"), undefined);
  h.sync.ready = true;
  tree = h.render(20000);
  assert.equal(h.find(tree, "VoiceInput"), undefined);
  const live = arenaHarness("voice");
  assert.ok(live.find(live.render(19000), "VoiceInput"));
  assert.ok(live.find(live.render(20000), "VoiceInput"));
});
test("actual Arena draft-error Retry calls recovery without submitting the answer", () => {
  const h = arenaHarness();
  h.sync.error = "Autosave offline";
  const banner = h.find(h.render(19000), "Banner");
  banner.props.action.props.onClick();
  assert.equal(h.retries(), 1);
  assert.equal(h.calls(), 0);
});

test("refresh retries an unresolved final from its receipt rather than replacing it with a stale server draft", async () => {
  const h = harness({
    receipt: { text: "Nonempty answer visible before refresh", confirmed: false },
  });
  h.render();
  await tick();
  h.render();
  await tick();
  const state = h.render();
  assert.equal(h.writes.length, 1);
  assert.equal(h.writes[0][1], "Nonempty answer visible before refresh");
  assert.equal(h.writes[0][2], true);
  assert.equal(state.done, true);
  h.close();
});

test("refresh restores an unsent draft without submitting early, while newer server revisions beat stale caches", async () => {
  const draft = harness({
    receipt: { text: "Unsent recent edit", phase: "draft", revision: 5, confirmed: false },
  });
  draft.render();
  await tick();
  let state = draft.render();
  await tick();
  assert.equal(draft.writes.length, 0);
  assert.equal(state.text, "Unsent recent edit");
  draft.pulse();
  await tick();
  assert.equal(draft.writes[0][2], false);
  draft.close();
  const stale = harness({
    receipt: { text: "Old cached final", phase: "final", revision: 3, confirmed: false },
  });
  stale.render();
  await tick();
  state = stale.render();
  await tick();
  assert.equal(state.text, "Saved text");
  assert.equal(stale.writes.length, 0);
  stale.close();
});
test("a local edit is retained as a draft receipt before autosave or the deadline callback can run", async () => {
  const h = harness();
  const state = await ready(h);
  state.change("Visible nonempty draft");
  h.close();
  // The hook wrote the expectation synchronously; canonical timeout mismatch is also covered by receipt tests.
  assert.equal(h.writes.length, 0);
  assert.equal(h.receipts.get("match:alice").text, "Visible nonempty draft");
  assert.equal(h.receipts.get("match:alice").phase, "draft");
});
