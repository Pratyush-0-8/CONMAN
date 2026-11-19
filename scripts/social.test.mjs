import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import { readNavigation, navigationPath } from "../src/lib/navigation.ts";

function harness() {
  let slots = [],
    cursor = 0,
    pending = [],
    source = [],
    calls = [],
    handlers = {},
    online = true,
    fail = false,
    restores = 0;
  const intervals = new Map(),
    listeners = new Map();
  let sequence = 0,
    subscription;
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in slots)) slots[i] = initial;
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
        prior = slots[i];
      if (!prior || deps.some((d, k) => d !== prior.deps[k])) slots[i] = { fn, deps };
      return slots[i].fn;
    },
    useEffect(fn, deps) {
      const i = cursor++,
        prior = slots[i];
      if (!prior || deps.some((d, k) => d !== prior.deps[k])) {
        slots[i] = { deps, cleanup: prior?.cleanup };
        pending.push(() => {
          slots[i].cleanup?.();
          slots[i].cleanup = fn();
        });
      }
    },
  };
  const document = {
    visibilityState: "visible",
    addEventListener: (n, f) => listeners.set(n, f),
    removeEventListener: (n) => listeners.delete(n),
  };
  const window = {
    addEventListener: (n, f) => listeners.set(n, f),
    removeEventListener: (n) => listeners.delete(n),
  };
  const service = {
    getInvitations: async () => {
      if (fail) throw Error("Connection lost");
      return { server_now: new Date().toISOString(), invitations: source };
    },
    heartbeat: async (session, available) => {
      calls.push({ session, available });
      if (!online) throw Error("Offline");
    },
    subscribeSocial: (_id, refresh) => {
      subscription = refresh;
      return () => {
        subscription = undefined;
      };
    },
  };
  const exports = {};
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/lib/useSocial.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      exports,
      require: (name) => (name === "react" ? react : service),
      Date,
      Error,
      Set,
      crypto: { randomUUID: () => `session-${++sequence}` },
      document,
      window,
      setInterval: (fn, ms) => {
        const id = ++sequence;
        intervals.set(id, { fn, ms });
        return id;
      },
      clearInterval: (id) => intervals.delete(id),
    },
  );
  return {
    render(id = "alice", available = true) {
      cursor = 0;
      const result = exports.useSocial(id, available, async () => {
        restores++;
      });
      for (const effect of pending.splice(0)) effect();
      return result;
    },
    source(value) {
      source = value;
    },
    fail(value) {
      fail = value;
    },
    calls,
    intervals,
    listeners,
    event(name) {
      listeners.get(name)?.();
    },
    visibility(value) {
      document.visibilityState = value;
    },
    notify() {
      subscription?.();
    },
    restores: () => restores,
    close() {
      for (const slot of slots) slot?.cleanup?.();
    },
  };
}
const settle = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
test("presence heartbeats follow visibility, match availability and cleanup without sharing tab sessions", async () => {
  const h = harness();
  h.render();
  await settle();
  assert.ok(h.calls.some((c) => c.available));
  const session = h.calls[0].session;
  h.visibility("hidden");
  h.event("visibilitychange");
  await settle();
  assert.equal(h.calls.at(-1).available, false);
  h.visibility("visible");
  h.event("focus");
  await settle();
  assert.equal(h.calls.at(-1).available, true);
  h.render("alice", false);
  await settle();
  assert.equal(h.calls.at(-1).available, false);
  h.close();
  await settle();
  assert.equal(h.calls.at(-1).available, false);
  assert.equal(h.intervals.size, 0);
  assert.equal(h.listeners.size, 0);
  h.render("bob", true);
  await settle();
  assert.notEqual(h.calls.at(-1).session, session);
  h.close();
});
test("Realtime and polling recover invitations and accepted matches across refresh; failures preserve saved invitations", async () => {
  const h = harness();
  h.source([{ id: "one", status: "pending" }]);
  h.render();
  await settle();
  assert.equal(h.render().invitations[0].status, "pending");
  h.source([{ id: "one", status: "accepted", match_id: "shared" }]);
  h.notify();
  await settle();
  assert.equal(h.restores(), 1);
  h.notify();
  await settle();
  assert.equal(h.restores(), 1);
  h.fail(true);
  h.notify();
  await settle();
  let state = h.render();
  assert.equal(state.invitations[0].match_id, "shared");
  assert.match(state.error, /Connection lost/);
  h.fail(false);
  h.source([{ id: "one", status: "expired" }]);
  h.event("online");
  await settle();
  state = h.render();
  assert.equal(state.invitations[0].status, "expired");
  assert.equal(state.error, "");
  h.close();
  const refreshed = harness();
  refreshed.source([{ id: "one", status: "accepted", match_id: "shared" }]);
  refreshed.render();
  await settle();
  assert.equal(refreshed.restores(), 1);
  refreshed.close();
});
test("stable profile paths round-trip and invalid profile ids do not enter profile routing", () => {
  const id = "20000000-0000-4000-8000-000000000001";
  const next = readNavigation(`/players/${id}`);
  assert.deepEqual(next, { page: "social", route: "app", profileId: id });
  assert.equal(navigationPath(next), `/players/${id}`);
  assert.equal(navigationPath({ page: "social", route: "app" }), "/friends");
  assert.deepEqual(readNavigation("/players/private-email"), { page: "daily", route: "app" });
});

test("invitation controls accept only pending incoming requests and preserve sender cancellation", async () => {
  const calls = [],
    exports = {};
  const component = (name) => Object.defineProperty(() => {}, "name", { value: name });
  const service = {
    respondChallenge: async (...args) => {
      calls.push(args);
      return "match";
    },
  };
  const localRequire = (name) => {
    if (name === "react") return { useState: (initial) => [initial, () => {}] };
    if (name === "react/jsx-runtime")
      return {
        jsx: (type, props) => ({ type, props }),
        jsxs: (type, props) => ({ type, props }),
        Fragment: "fragment",
      };
    if (name.endsWith("socialService")) return service;
    return new Proxy({}, { get: (_, key) => component(String(key)) });
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/components/Social.tsx", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
    }).outputText,
    { exports, require: localRequire, Date, Math, Error },
  );
  function buttons(node) {
    if (!node || typeof node !== "object") return [];
    if (Array.isArray(node)) return node.flatMap(buttons);
    return [
      ...(node.type?.name === "Button" ? [node.props] : []),
      ...buttons(node.props?.children),
    ];
  }
  const props = {
    invitations: [
      {
        id: "invite",
        sender_id: "alice",
        recipient_id: "bob",
        sender_name: "Alice",
        recipient_name: "Bob",
        status: "pending",
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 60000).toISOString(),
      },
    ],
    userId: "bob",
    now: Date.now(),
    available: true,
    onUpdate: async () => {},
  };
  let controls = buttons(exports.Invitations(props));
  controls.find((b) => b.children === "Accept").onClick();
  await settle();
  assert.deepEqual(calls[0], ["invite", "accept", "typing"]);
  controls = buttons(exports.Invitations({ ...props, available: false }));
  assert.equal(controls.find((b) => b.children === "Accept").disabled, true);
  controls = buttons(exports.Invitations({ ...props, now: Date.now() + 120000 }));
  assert.equal(controls.length, 0);
  controls = buttons(exports.Invitations({ ...props, userId: "alice" }));
  assert.deepEqual(
    controls.map((b) => b.children),
    ["Cancel invitation"],
  );
  controls[0].onClick();
  await settle();
  assert.deepEqual(calls[1], ["invite", "cancel", "typing"]);
  const declined = {
    ...props,
    compact: true,
    invitations: props.invitations.map((i) => ({
      ...i,
      status: "declined",
      created_at: new Date().toISOString(),
    })),
  };
  controls = buttons(exports.Invitations(declined));
  assert.equal(controls[0].children, "Dismiss");
  controls[0].onClick();
});

test("username availability escapes underscores while preserving case-insensitive comparison", async () => {
  const exports = {},
    filters = [];
  const query = {
    select: () => query,
    ilike: (...args) => {
      filters.push(args);
      return query;
    },
    limit: async () => ({ data: [], error: null }),
  };
  vm.runInNewContext(
    ts.transpileModule(fs.readFileSync("src/lib/auth.ts", "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS },
    }).outputText,
    { exports, require: () => ({ supabase: { from: () => query } }), Error },
  );
  assert.equal(await exports.checkUsername("some_name"), true);
  assert.deepEqual(filters[0], ["username", "some\\_name"]);
});
