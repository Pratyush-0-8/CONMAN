import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
const settle = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
const transpile = (file) =>
  ts.transpileModule(fs.readFileSync(file, "utf8"), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
function loadSession(service) {
  const exports = {};
  vm.runInNewContext(transpile("src/lib/dailySession.ts"), {
    exports,
    require: () => service,
    Date,
    Error,
    Math,
  });
  return exports;
}
const attempt = (date, id = "current", extra = {}) => ({
  id,
  date,
  mode: "typing",
  position: 1,
  status: "active",
  server_now: date + "T15:00:00Z",
  rounds: [
    {
      position: 1,
      question: "Question " + date,
      started_at: date + "T14:59:54Z",
      deadline: date + "T15:00:20Z",
      answer_text: "Saved answer",
      state: "active",
      locked_at: null,
    },
  ],
  ...extra,
});
test("November 18 unfinished active pointer cannot hijack November 20; refresh resumes only November 20 progress", async () => {
  const old = { date: "2026-11-18", token: "old", mode: "typing" },
    current = { date: "2026-11-20", token: "new", mode: "typing" },
    saved = new Map([
      ["active", old],
      ["2026-11-18", old],
      ["2026-11-20", current],
    ]),
    calls = [],
    reads = [];
  const helper = loadSession({
    dailyRequest: async (action, _args, token) => {
      calls.push([action, token]);
      return action === "today"
        ? { date: "2026-11-20", available: true }
        : attempt(token === "old" ? "2026-11-18" : "2026-11-20");
    },
    readDailySession: async (key) => {
      reads.push(key);
      return saved.get(key);
    },
  });
  for (let i = 0; i < 2; i++) {
    const recovered = await helper.loadCurrentDaily();
    assert.equal(recovered.attempt.date, "2026-11-20");
    assert.equal(recovered.session.token, "new");
  }
  assert.deepEqual(reads, ["2026-11-20", "2026-11-20"]);
  assert.ok(!calls.some((c) => c[1] === "old"));
  assert.equal(saved.get("active"), old);
  assert.equal(saved.size, 3);
  saved.delete("2026-11-20");
  const fresh = await helper.loadCurrentDaily();
  assert.equal(fresh.attempt, null);
  assert.equal(fresh.session, null);
});
test("misfiled credentials and a mismatched recovered date cannot install a historical game", async () => {
  const helper = loadSession({
    dailyRequest: async (action) =>
      action === "today" ? { date: "2026-11-20" } : attempt("2026-11-18"),
    readDailySession: async () => ({ date: "2026-11-18", token: "old" }),
  });
  assert.equal((await helper.loadCurrentDaily()).session, null);
  const mismatch = loadSession({
    dailyRequest: async (action) =>
      action === "today" ? { date: "2026-11-20" } : attempt("2026-11-18"),
    readDailySession: async () => ({ date: "2026-11-20", token: "wrong" }),
  });
  await assert.rejects(mismatch.loadCurrentDaily(), /does not match/);
});
test("rollover uses authoritative Eastern midnight, server clock offset and DST rather than the browser timezone", () => {
  const helper = loadSession({}),
    now = Date.parse("2026-11-20T04:59:59Z");
  assert.equal(
    helper.dailyRolloverDelay(
      { date: "2026-11-19", next_date_at: "2026-11-20T05:00:00Z", clockOffset: 300 },
      now,
    ),
    725,
  );
  assert.equal(
    helper.dailyRolloverDelay({ next_date_at: "2026-11-20T05:00:00Z" }, now + 10000),
    25,
  );
  assert.equal(
    helper.dailyRolloverDelay(
      { next_date_at: "2026-03-09T04:00:00Z" },
      Date.parse("2026-03-08T05:00:00Z"),
    ),
    23 * 3600000 + 25,
  );
  assert.equal(
    helper.dailyRolloverDelay(
      { next_date_at: "2026-11-02T05:00:00Z" },
      Date.parse("2026-11-01T04:00:00Z"),
    ),
    25 * 3600000 + 25,
  );
});
function screenHarness() {
  let day = "2026-11-20",
    slots = [],
    cursor = 0,
    pending = [],
    tree,
    receipt = null,
    delay = false,
    release = null;
  const listeners = new Map(),
    timers = new Map(),
    calls = [];
  let sequence = 0;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = typeof initial === "function" ? initial() : initial;
      return [
        slots[i],
        (v) => {
          slots[i] = typeof v === "function" ? v(slots[i]) : v;
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
        pending.push(i);
      }
    },
  };
  const service = {
    dailyRequest: async (action, args, token) => {
      calls.push({ action, args, token });
      const date = token || day;
      const response =
        action === "today"
          ? {
              date: day,
              available: true,
              next_date_at: day === "2026-11-20" ? "2026-11-21T05:00:00Z" : "2026-11-22T05:00:00Z",
            }
          : attempt(date, date, {
              rounds: [
                {
                  ...attempt(date).rounds[0],
                  state: receipt ? "locked" : "active",
                  locked_at: receipt ? "locked" : null,
                  answer_text: receipt ? "" : "Saved answer",
                },
              ],
            });
      if (delay && action === "state") {
        delay = false;
        return new Promise((resolve) => {
          release = () => resolve(response);
        });
      }
      return response;
    },
    readDailySession: async (date) => ({ date, token: date, mode: "typing" }),
    dailyAnswerTransport: () => ({}),
    prepareDailySession: async () => {},
    storeDailySession: async () => {},
  };
  const session = loadSession(service),
    components = new Map(),
    component = (name) => {
      if (!components.has(name))
        components.set(
          name,
          Object.defineProperty(() => {}, "name", { value: name }),
        );
      return components.get(name);
    };
  const exports = {},
    eventTarget = {
      addEventListener: (name, fn) => {
        const set = listeners.get(name) || new Set();
        set.add(fn);
        listeners.set(name, set);
      },
      removeEventListener: (name, fn) => listeners.get(name)?.delete(fn),
      visibilityState: "visible",
    };
  vm.runInNewContext(transpile("src/screens/DailyFive.tsx"), {
    exports,
    require: (name) =>
      name === "react"
        ? react
        : name === "react/jsx-runtime"
          ? { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }
          : name.endsWith("dailyService")
            ? service
            : name.endsWith("dailySession")
              ? session
              : name.endsWith("useAnswerReceipt")
                ? { useAnswerReceipt: () => receipt }
                : new Proxy({}, { get: (_, name) => component(String(name)) }),
    Date: class extends Date {
      static now() {
        return Date.parse(day + "T15:00:00Z");
      }
    },
    Math,
    Error,
    window: eventTarget,
    document: eventTarget,
    setTimeout: (fn, ms) => {
      const id = ++sequence;
      timers.set(id, { fn, ms });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: (fn, ms) => {
      const id = ++sequence;
      timers.set(id, { fn, ms });
      return id;
    },
    clearInterval: (id) => timers.delete(id),
  });
  const render = () => {
    cursor = 0;
    tree = exports.DailyFive();
    for (const i of pending.splice(0)) {
      slots[i].cleanup?.();
      slots[i].cleanup = slots[i].fn();
    }
    return tree;
  };
  const find = (node, name) => {
    if (!node || typeof node !== "object") return;
    if (Array.isArray(node)) {
      for (const c of node) {
        const r = find(c, name);
        if (r) return r;
      }
    } else if (node.type?.name === name) return node;
    else return find(node.props?.children, name);
  };
  return {
    render,
    find,
    calls,
    delayNextState: () => {
      delay = true;
    },
    releaseOldState: () => release?.(),
    setDay: (value) => {
      day = value;
    },
    setReceipt: (value) => {
      receipt = value;
    },
    event: (name) => {
      for (const fn of [...(listeners.get(name) || [])]) fn();
    },
    close: () => {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}
test("actual Daily Five screen switches days on focus and resumes the new date; stale attempt state cannot win", async () => {
  const h = screenHarness();
  h.render();
  await settle();
  let tree = h.render();
  assert.equal(h.find(tree, "DailyInput").props.attemptId, "2026-11-20");
  h.delayNextState();
  h.event("online");
  await settle();
  h.setDay("2026-11-21");
  h.event("focus");
  await settle();
  tree = h.render();
  await settle();
  tree = h.render();
  assert.equal(h.find(tree, "DailyInput").props.attemptId, "2026-11-21");
  h.releaseOldState();
  await settle();
  tree = h.render();
  assert.equal(h.find(tree, "DailyInput").props.attemptId, "2026-11-21");
  h.close();
});
test("actual Daily Five pauses auto-grading when a nonempty final is not confirmed instead of silently grading an empty draft", async () => {
  const h = screenHarness();
  h.setReceipt({ text: "Visible nonempty answer", confirmed: false, error: "Final failed" });
  h.render();
  await settle();
  const tree = h.render();
  await settle();
  assert.ok(h.find(tree, "Banner"));
  assert.ok(!h.calls.some((c) => c.action === "judge"));
  h.close();
});
test("final receipts survive refresh and distinguish a true empty submission from a lost nonempty final", () => {
  const stored = new Map(),
    listeners = [];
  const load = () => {
    const exports = {};
    vm.runInNewContext(transpile("src/lib/answerReceipt.ts"), {
      exports,
      Map,
      Set,
      JSON,
      sessionStorage: {
        getItem: (k) => stored.get(k) || null,
        setItem: (k, v) => stored.set(k, v),
        removeItem: (k) => stored.delete(k),
      },
    });
    return exports;
  };
  let r = load();
  r.writeReceipt("attempt:1", { text: "Nonempty final", confirmed: false });
  r = load();
  assert.equal(r.readReceipt("attempt:1").text, "Nonempty final");
  r.reconcileReceipt("attempt:1", "", true);
  assert.equal(r.readReceipt("attempt:1").confirmed, false);
  assert.match(r.readReceipt("attempt:1").error, /different draft/);
  r.reconcileReceipt("attempt:1", "Nonempty final", true);
  assert.equal(r.readReceipt("attempt:1").confirmed, true);
  r.writeReceipt("empty", { text: "", confirmed: false });
  r.reconcileReceipt("empty", "", true);
  assert.equal(r.readReceipt("empty").confirmed, true);
});

test("midnight crossing during a slow restore reselects today instead of displaying the prior date", async () => {
  let reads = 0;
  const helper = loadSession({
    dailyRequest: async (action, _body, token) =>
      action === "today"
        ? { date: ++reads === 1 ? "2026-11-19" : "2026-11-20" }
        : attempt(token, token, { server_now: "2026-11-20T05:00:01Z" }),
    readDailySession: async (date) => ({ date, token: date }),
  });
  assert.equal((await helper.loadCurrentDaily()).attempt.date, "2026-11-20");
  assert.equal(reads, 2);
});
test("actual Daily transport forwards revisions and only acknowledges the exact frozen final", async () => {
  const exports = {},
    calls = [];
  let corrupt = false;
  const source = fs
    .readFileSync("src/lib/dailyService.ts", "utf8")
    .replaceAll("import.meta.env.VITE_SUPABASE_URL", JSON.stringify("https://db.test"))
    .replaceAll("import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY", JSON.stringify("public-test"));
  vm.runInNewContext(
    ts.transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      Date,
      Error,
      AbortSignal,
      JSON,
      fetch: async (_url, options) => {
        const body = JSON.parse(options.body);
        calls.push(body);
        return {
          ok: true,
          json: async () =>
            body.action === "open-answer"
              ? {
                  status: "ready",
                  answer_text: "",
                  revision: 0,
                  writer_id: body.writer,
                  locked_at: null,
                }
              : {
                  status: "locked",
                  answer_text: corrupt ? "" : body.text,
                  final_answer_text: corrupt ? "" : body.text,
                  revision: body.revision,
                  final_revision: body.revision,
                  locked_at: "locked",
                },
        };
      },
    },
  );
  const transport = exports.dailyAnswerTransport("private-token", 3);
  await transport.open("ignored", "writer", null);
  assert.equal(calls[0].action, "open-answer");
  assert.equal(calls[0].position, 3);
  const saved = await transport.save("ignored", "Nonempty visible final", true, 7, "writer");
  assert.equal(saved.final_answer_text, "Nonempty visible final");
  assert.equal(calls[1].revision, 7);
  corrupt = true;
  await assert.rejects(
    transport.save("ignored", "Nonempty visible final", true, 8, "writer"),
    /final answer was not saved/,
  );
});
