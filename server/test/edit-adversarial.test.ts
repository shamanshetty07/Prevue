import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyOps } from "../src/edit/engine.js";
import type { EditErrorCode, EditResult } from "../src/edit/types.js";
import { validateSpec } from "../src/spec/validate.js";

/**
 * Black-box adversarial and invariant tests for the Phase 3a edit engine. They use only the public contract
 * (applyOps, validateSpec) and assert on error codes and op indexes, never on message text.
 */

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const example = (): any => JSON.parse(exampleText);
const hashOf = (v: unknown): string => {
  const r = validateSpec(v);
  assert.equal(r.ok, true);
  return (r as any).hash;
};
const BASE_HASH = hashOf(example());

const ALL_CODES: readonly EditErrorCode[] = [
  "invalid_json",
  "too_large",
  "too_complex",
  "duplicate_key",
  "invalid_proposal",
  "unknown_key",
  "unknown_op",
  "invalid_base_hash",
  "too_many_ops",
  "invalid_path",
  "property_not_allowed",
  "invalid_value",
  "invalid_component",
  "invalid_base",
  "stale_base",
  "path_unresolved",
  "type_mismatch",
  "invalid_parent",
  "index_out_of_range",
  "not_removable",
  "not_movable",
  "move_into_self",
  "invalid_result",
  "internal_error",
];

/** applyOps must never throw; this wrapper turns a throw into a test failure with a clear name. */
function run(base: unknown, proposal: unknown): EditResult {
  let r: EditResult;
  try {
    r = applyOps(base, proposal);
  } catch (e) {
    assert.fail(`applyOps threw: ${String((e as Error)?.name)}`);
  }
  assert.ok(r && typeof r === "object", "applyOps returned a non-object");
  return r;
}
const failCode = (r: EditResult): { code: string; op?: number } => {
  assert.equal(r.ok, false, `expected failure, got ok (hash ${(r as any).hash})`);
  const e = (r as any).error;
  assert.ok(e && typeof e === "object");
  assert.ok(ALL_CODES.includes(e.code), `unknown code ${String(e.code)}`);
  return e;
};
const expectCode = (r: EditResult, code: EditErrorCode, op?: number, label = ""): void => {
  const e = failCode(r);
  assert.equal(e.code, code, label);
  if (op !== undefined) assert.equal(e.op, op, label);
};
const prop = (ops: unknown[], baseHash: string = BASE_HASH) => ({ baseHash, ops });

const setOp = (path: unknown) => ({ op: "set", path, expect: "main", prop: "gap", value: "sm" });
const insertOp = (parent: unknown) => ({ op: "insert", parent, parentExpect: "main", index: 0, node: { type: "text", content: "x" } });
const moveOp = (parent: unknown) => ({ op: "move", path: "main.1", expect: "text", parent, parentExpect: "main", index: 0 });

function deepFreeze<T>(v: T): T {
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (x && typeof x === "object" && !Object.isFrozen(x)) {
      Object.freeze(x);
      for (const c of Object.values(x)) stack.push(c);
    }
  }
  return v;
}
function objectsIn(v: unknown): Set<object> {
  const out = new Set<object>();
  const stack: unknown[] = [v];
  while (stack.length) {
    const x = stack.pop();
    if (x && typeof x === "object" && !out.has(x)) {
      out.add(x);
      for (const c of Object.values(x)) stack.push(c);
    }
  }
  return out;
}

// ---- 1. malformed and non-canonical paths ---------------------------------------------------------------------

const BAD_PATHS: unknown[] = [
  "",
  "main.",
  "main.01",
  "main.-1",
  "main.+1",
  "main.1e0",
  "main.0x1",
  "main. 1",
  "main.1.",
  "main..1",
  "MAIN.0",
  " main.0",
  "main.0 ",
  "main.１",
  "main.__proto__",
  "header.actions.constructor",
  "sidebar.items.0",
  "header.actions",
  "layout.main",
  "/layout/main/children/0",
  "__proto__",
  "constructor",
  "main.length",
  `main${".0".repeat(9)}`,
  "x".repeat(10000),
  0,
  {},
  ["main.0"],
  null,
];

test("edit adversarial: malformed or non-canonical set paths are rejected as invalid_path", () => {
  for (const p of BAD_PATHS) expectCode(run(example(), prop([setOp(p)])), "invalid_path", 0, `set path ${JSON.stringify(p)?.slice(0, 40)}`);
});

test("edit adversarial: malformed or non-canonical insert parents are rejected as invalid_path", () => {
  for (const p of BAD_PATHS) expectCode(run(example(), prop([insertOp(p)])), "invalid_path", 0, `insert parent ${JSON.stringify(p)?.slice(0, 40)}`);
});

test("edit adversarial: malformed or non-canonical move parents are rejected as invalid_path", () => {
  for (const p of BAD_PATHS) expectCode(run(example(), prop([moveOp(p)])), "invalid_path", 0, `move parent ${JSON.stringify(p)?.slice(0, 40)}`);
});

test("edit adversarial: the controls for the path tests succeed (so the rejections above are about the path)", () => {
  assert.equal(run(example(), prop([setOp("main")])).ok, true);
  assert.equal(run(example(), prop([insertOp("main")])).ok, true);
  assert.equal(run(example(), prop([moveOp("main")])).ok, true);
});

// ---- 2. syntactically valid but unresolved --------------------------------------------------------------------

test("edit adversarial: syntactically valid paths that name nothing are path_unresolved", () => {
  const cases: Array<[string, string, string, string]> = [
    ["main.9", "text", "content", "x"],
    ["main.0.7", "stat-card", "label", "x"],
    ["main.1.0", "text", "content", "x"],
    ["header.actions.3", "button", "label", "x"],
  ];
  for (const [path, expect, p, value] of cases) {
    expectCode(run(example(), prop([{ op: "set", path, expect, prop: p, value }])), "path_unresolved", 0, path);
  }
  expectCode(run(example(), prop([{ op: "remove", path: "main.9", expect: "text" }])), "path_unresolved", 0, "remove main.9");
  expectCode(run(example(), prop([{ op: "insert", parent: "main.1.0", parentExpect: "stack", index: 0, node: { type: "text", content: "x" } }])), "path_unresolved", 0, "insert under text child");
});

test("edit adversarial: header and sidebar paths on a base without them are path_unresolved", () => {
  const noHeader = example();
  delete noHeader.layout.header;
  const hHash = hashOf(noHeader);
  expectCode(run(noHeader, prop([{ op: "set", path: "header", expect: "header", prop: "title", value: "x" }], hHash)), "path_unresolved", 0, "header");
  expectCode(run(noHeader, prop([{ op: "set", path: "header.actions.0", expect: "button", prop: "label", value: "x" }], hHash)), "path_unresolved", 0, "header.actions.0");
  expectCode(run(noHeader, prop([{ op: "insert", parent: "header", parentExpect: "header", index: 0, node: { type: "button", label: "x" } }], hHash)), "path_unresolved", 0, "insert header");
  const noSidebar = example();
  delete noSidebar.layout.sidebar;
  const sHash = hashOf(noSidebar);
  expectCode(run(noSidebar, prop([{ op: "set", path: "sidebar", expect: "sidebar", prop: "title", value: "x" }], sHash)), "path_unresolved", 0, "sidebar");
});

// ---- 3. prototype pollution -----------------------------------------------------------------------------------

const notPolluted = (): void => {
  assert.equal(({} as any).polluted, undefined);
  assert.equal(Object.hasOwn(Object.prototype, "polluted"), false);
  assert.equal(Object.hasOwn(Array.prototype, "polluted"), false);
};

test("edit adversarial: __proto__, constructor and prototype are never settable properties", () => {
  for (const [path, expect] of [["main.1", "text"], ["main", "main"], ["header", "header"], ["main.0", "grid"]]) {
    for (const p of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"]) {
      expectCode(run(example(), prop([{ op: "set", path, expect, prop: p, value: "x" }])), "property_not_allowed", 0, `${path} ${p}`);
      expectCode(run(example(), prop([{ op: "set", path, expect, prop: p, value: 1 }])), "property_not_allowed", 0, `${path} ${p} number`);
    }
  }
  notPolluted();
});

test("edit adversarial: JSON-parsed __proto__ keys in a proposal, an op or an inserted node are rejected and pollute nothing", () => {
  const top = JSON.parse(`{"baseHash":"${BASE_HASH}","ops":[{"op":"set","path":"main","expect":"main","prop":"gap","value":"sm"}],"__proto__":{"polluted":1}}`);
  expectCode(run(example(), top), "unknown_key");
  const inOp = JSON.parse(`{"baseHash":"${BASE_HASH}","ops":[{"op":"set","path":"main","expect":"main","prop":"gap","value":"sm","__proto__":{"polluted":1}}]}`);
  expectCode(run(example(), inOp), "unknown_key", 0);
  const inNode = JSON.parse(
    `{"baseHash":"${BASE_HASH}","ops":[{"op":"insert","parent":"main","parentExpect":"main","index":0,"node":{"type":"text","content":"x","__proto__":{"polluted":1}}}]}`,
  );
  const e = failCode(run(example(), inNode));
  assert.ok(["unknown_key", "invalid_component"].includes(e.code), e.code);
  assert.equal(e.op, 0);
  const nested = JSON.parse(
    `{"baseHash":"${BASE_HASH}","ops":[{"op":"insert","parent":"main","parentExpect":"main","index":0,"node":{"type":"stack","children":[{"type":"text","content":"x","__proto__":{"polluted":1}}]}}]}`,
  );
  const e2 = failCode(run(example(), nested));
  assert.ok(["unknown_key", "invalid_component"].includes(e2.code), e2.code);
  const constructorKey = JSON.parse(
    `{"baseHash":"${BASE_HASH}","ops":[{"op":"insert","parent":"main","parentExpect":"main","index":0,"node":{"type":"text","content":"x","constructor":{"prototype":{"polluted":1}}}}]}`,
  );
  const e3 = failCode(run(example(), constructorKey));
  assert.ok(["unknown_key", "invalid_component"].includes(e3.code), e3.code);
  // a base carrying __proto__ is not a valid specification
  const base = JSON.parse(exampleText.replace(`"schemaVersion": 1,`, `"schemaVersion": 1, "__proto__": {"polluted": 1},`));
  expectCode(run(base, prop([setOp("main")])), "invalid_base");
  notPolluted();
});

// ---- 4. hostile JS inputs -------------------------------------------------------------------------------------

const MARK = "SECRETMARKER";
const throwingGetter = (target: Record<string, unknown>, key: string): Record<string, unknown> => {
  Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      throw new Error(MARK);
    },
  });
  return target;
};
const hostileProxy = (): object =>
  new Proxy(
    {},
    {
      get() {
        throw new Error(MARK);
      },
      has() {
        throw new Error(MARK);
      },
      ownKeys() {
        throw new Error(MARK);
      },
      getOwnPropertyDescriptor() {
        throw new Error(MARK);
      },
      getPrototypeOf() {
        throw new Error(MARK);
      },
      set() {
        throw new Error(MARK);
      },
      defineProperty() {
        throw new Error(MARK);
      },
    },
  );

const assertSafeFailure = (label: string, mk: () => [unknown, unknown]): void => {
  const [b1, p1] = mk();
  const r1 = run(b1, p1);
  assert.equal(r1.ok, false, label);
  const e = failCode(r1);
  const json = JSON.stringify(r1);
  assert.ok(!json.includes(MARK), `${label}: result echoes the marker: ${json.slice(0, 300)}`);
  const [b2, p2] = mk();
  assert.equal(failCode(run(b2, p2)).code, e.code, `${label}: code is not stable`);
};

test("edit adversarial: hostile proposals (getters, proxies, cycles, BigInt, functions, inherited props) fail safely", () => {
  const cases: Array<[string, () => unknown]> = [
    ["getter on ops", () => throwingGetter({ baseHash: BASE_HASH }, "ops")],
    ["getter on baseHash", () => throwingGetter({ ops: [setOp("main")] }, "baseHash")],
    ["getter inside op", () => prop([throwingGetter({ op: "set", path: "main", expect: "main", prop: "gap" }, "value")])],
    ["getter inside inserted node", () => prop([{ ...insertOp("main"), node: throwingGetter({ type: "text" }, "content") }])],
    ["proxy proposal", () => hostileProxy()],
    ["proxy ops", () => ({ baseHash: BASE_HASH, ops: hostileProxy() })],
    ["proxy op", () => prop([hostileProxy()])],
    ["proxy node", () => prop([{ ...insertOp("main"), node: hostileProxy() }])],
    [
      "circular proposal",
      () => {
        const p: any = prop([setOp("main")]);
        p.self = p;
        return p;
      },
    ],
    [
      "circular op list",
      () => {
        const ops: any[] = [setOp("main")];
        ops.push(ops);
        return prop(ops);
      },
    ],
    [
      "circular node",
      () => {
        const node: any = { type: "stack", children: [] };
        node.children.push(node);
        return prop([{ ...insertOp("main"), node }]);
      },
    ],
    ["BigInt value", () => prop([{ ...setOp("main"), value: BigInt(1) }])],
    ["BigInt index", () => prop([{ ...insertOp("main"), index: BigInt(0) }])],
    ["function value", () => prop([{ ...setOp("main"), value: () => MARK }])],
    ["function proposal", () => Object.assign(() => MARK, prop([setOp("main")]))],
    ["inherited node props", () => prop([{ ...insertOp("main"), node: Object.create({ type: "text", content: "x" }) }])],
    ["inherited op props", () => prop([Object.create(setOp("main"))])],
    ["inherited proposal props", () => Object.create(prop([setOp("main")]))],
    ["symbol value", () => prop([{ ...setOp("main"), value: Symbol(MARK) }])],
  ];
  for (const [label, mk] of cases) assertSafeFailure(label, () => [example(), mk()]);
  notPolluted();
});

test("edit adversarial: hostile bases (getters, proxies, cycles, BigInt, functions) fail safely and never echo", () => {
  const p = () => prop([setOp("main")]);
  const cases: Array<[string, () => unknown]> = [
    ["getter on layout", () => throwingGetter(example(), "layout")],
    [
      "getter deep in main",
      () => {
        const b = example();
        throwingGetter(b.layout.main.children[1], "content");
        return b;
      },
    ],
    ["proxy base", () => hostileProxy()],
    [
      "proxy main",
      () => {
        const b = example();
        b.layout.main = hostileProxy();
        return b;
      },
    ],
    [
      "circular base",
      () => {
        const b = example();
        b.layout.main.children.push(b);
        return b;
      },
    ],
    [
      "BigInt in base",
      () => {
        const b = example();
        b.layout.main.children[0].columns = BigInt(3);
        return b;
      },
    ],
    [
      "function in base",
      () => {
        const b = example();
        b.layout.main.children[1].content = () => MARK;
        return b;
      },
    ],
  ];
  const failures: string[] = [];
  for (const [label, mk] of cases) {
    try {
      assertSafeFailure(label, () => [mk(), p()]);
    } catch (e) {
      failures.push(String((e as Error).message).split("\n")[0]!);
    }
  }
  assert.deepEqual(failures, []);
});

test("edit adversarial: a base whose properties are inherited is rejected (the engine reads the base only as plain JSON)", () => {
  // validateSpec alone would read inherited properties; the engine's JSON snapshot sees none, so nothing on a prototype counts.
  const p = prop([{ op: "set", path: "main.1", expect: "text", prop: "content", value: "Changed" }]);
  expectCode(run(Object.create(example()), p), "invalid_base");
});

test("edit adversarial: long attacker strings in prop, value, path or node are never echoed", () => {
  const big = (c: string) => `${c.repeat(3000)}${MARK}`;
  const cases: unknown[] = [
    prop([{ op: "set", path: "main.1", expect: "text", prop: big("p"), value: "x" }]),
    prop([{ op: "set", path: "header", expect: "header", prop: "title", value: big("v") }]),
    prop([{ op: "set", path: "main.0", expect: "grid", prop: "columns", value: big("v") }]),
    prop([{ op: "set", path: "main.1", expect: "text", prop: "variant", value: `${MARK}` }]),
    prop([setOp(big("a"))]),
    prop([setOp(`main.${MARK}`)]),
    prop([insertOp(big("b"))]),
    prop([{ ...insertOp("main"), node: { type: "text", content: big("c") } }]),
    prop([{ ...insertOp("main"), node: { type: MARK, content: "x" } }]),
    prop([{ ...insertOp("main"), node: { type: "text", content: "x", [big("k")]: 1 } }]),
    prop([{ op: big("o"), path: "main" }]),
    prop([{ ...setOp("main"), [big("k")]: 1 }]),
    prop([{ ...setOp("main"), expect: MARK }]),
    { baseHash: big("h"), ops: [setOp("main")] },
    { ...prop([setOp("main")]), [big("t")]: 1 },
    { baseHash: BASE_HASH, ops: MARK },
  ];
  for (const c of cases) {
    const r = run(example(), c);
    failCode(r);
    const json = JSON.stringify(r);
    assert.ok(!json.includes(MARK), `echoed: ${json.slice(0, 300)}`);
    assert.ok(json.length < 4000, `result is ${json.length} bytes`);
  }
});

// ---- 5. atomicity and immutability ----------------------------------------------------------------------------

test("edit adversarial: a failing op at any position fails the whole proposal and leaves frozen inputs untouched", () => {
  const good = [
    { op: "set", path: "main.1", expect: "text", prop: "content", value: "Changed" },
    { op: "set", path: "header", expect: "header", prop: "title", value: "New title" },
    { op: "set", path: "main.0", expect: "grid", prop: "gap", value: "sm" },
  ];
  const base = deepFreeze(example());
  const before = JSON.stringify(base);
  const ok = run(base, deepFreeze(prop(good)));
  assert.equal(ok.ok, true);
  for (let k = 0; k < 3; k++) {
    const withFailure = (bad: unknown): unknown[] => good.map((o, i) => (i === k ? bad : { ...o }));
    const proposal = deepFreeze(prop(withFailure({ op: "set", path: "main.9", expect: "text", prop: "content", value: "x" })));
    const proposalBefore = JSON.stringify(proposal);
    const r = run(base, proposal);
    expectCode(r, "path_unresolved", k, `failing op at ${k}`);
    assert.equal(Object.hasOwn(r, "spec"), false);
    assert.equal(Object.hasOwn(r, "hash"), false);
    assert.equal(JSON.stringify(proposal), proposalBefore);
    // a type mismatch at k as well
    const r2 = run(base, deepFreeze(prop(withFailure({ op: "remove", path: "main.1", expect: "table" }))));
    expectCode(r2, "type_mismatch", k, `type mismatch at ${k}`);
    assert.equal(Object.hasOwn(r2, "spec"), false);
  }
  assert.equal(JSON.stringify(base), before);
});

// ---- 6. determinism fuzz --------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test("edit adversarial: seeded fuzz of op sequences is deterministic, valid or cleanly rejected, and never mutates the base", () => {
  const rnd = mulberry32(0x5eed1234);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const PATHS = ["header", "header.actions.0", "header.actions.1", "header.actions.3", "sidebar", "main", "main.0", "main.0.0", "main.0.1", "main.0.2", "main.0.3", "main.1", "main.2", "main.3", "main.0.0.0", "main.12"];
  const PARENTS = ["main", "main.0", "main.1", "main.2", "header", "header.actions.0", "main.0.0", "sidebar"];
  const TARGETS = ["main", "header", "sidebar", "stack", "grid", "text", "button", "stat-card", "table"];
  const NODE_TYPES = ["stack", "grid", "text", "button", "stat-card", "table"];
  const PARENT_TYPES = ["main", "stack", "grid", "header"];
  const PROPS = ["gap", "padding", "title", "subtitle", "width", "direction", "align", "columns", "content", "variant", "tone", "label", "note", "value", "hint", "caption", "emptyText", "id", "type", "children", "items"];
  const VALUES: Array<string | number> = ["sm", "lg", "none", "row", "column", "center", "narrow", "heading", "muted", "primary", "danger", "Hello", "  spaced  ", "x".repeat(70), "", 1, 2, 4, 5, 0, -1, 1.5];
  const NODES: unknown[] = [
    { type: "text", content: "Inserted" },
    { type: "button", label: "Go" },
    { type: "stat-card", label: "L", value: "V" },
    { type: "stack", children: [{ type: "text", content: "in stack" }] },
    { type: "grid", columns: 2, children: [] },
    { type: "table", columns: [{ key: "a", header: "A" }], rows: [["1"]] },
    { type: "text", content: "bad", id: "x" },
    { type: "button" },
  ];
  const INDEXES = [0, 0, 1, 2, 3, 12, 13, -1];
  const randomOp = (): unknown => {
    switch (Math.floor(rnd() * 4)) {
      case 0:
        return { op: "set", path: pick(PATHS), expect: pick(TARGETS), prop: pick(PROPS), value: pick(VALUES) };
      case 1:
        return { op: "insert", parent: pick(PARENTS), parentExpect: pick(PARENT_TYPES), index: pick(INDEXES), node: structuredClone(pick(NODES)) };
      case 2:
        return { op: "remove", path: pick(PATHS), expect: pick(NODE_TYPES) };
      default:
        return { op: "move", path: pick(PATHS), expect: pick(NODE_TYPES), parent: pick(PARENTS), parentExpect: pick(PARENT_TYPES), index: pick(INDEXES) };
    }
  };
  const base = example();
  const before = JSON.stringify(base);
  let oks = 0;
  for (let it = 0; it < 300; it++) {
    const n = 1 + Math.floor(rnd() * 6);
    const ops = Array.from({ length: n }, randomOp);
    const proposal = prop(ops);
    const proposalText = JSON.stringify(proposal);
    const r = run(base, proposal);
    const again = run(base, JSON.parse(proposalText));
    assert.equal(JSON.stringify(again), JSON.stringify(r), `nondeterministic at iteration ${it}`);
    assert.equal(JSON.stringify(proposal), proposalText, `proposal mutated at iteration ${it}`);
    if (r.ok) {
      oks++;
      const v = validateSpec(r.spec);
      assert.equal(v.ok, true, `iteration ${it}: result does not validate`);
      assert.equal((v as any).hash, r.hash, `iteration ${it}: hash mismatch`);
      assert.equal(JSON.stringify((v as any).spec), JSON.stringify(r.spec), `iteration ${it}: result is not normalized`);
      assert.equal(r.baseHash, BASE_HASH);
      assert.equal(r.changed, r.hash !== BASE_HASH);
    } else {
      const e = failCode(r);
      if (e.op !== undefined) assert.ok(Number.isInteger(e.op) && e.op >= 0 && e.op < n, `iteration ${it}: op ${e.op} out of range`);
    }
  }
  assert.equal(JSON.stringify(base), before);
  assert.ok(oks > 0, "the fuzz never produced a successful edit; the generator is not exercising the engine");
});

// ---- 7. base hash ---------------------------------------------------------------------------------------------

test("edit adversarial: the hash of a different valid design is stale_base; an uppercase right hash is invalid_base_hash", () => {
  const other = example();
  other.theme.mode = "dark";
  const otherHash = hashOf(other);
  assert.notEqual(otherHash, BASE_HASH);
  expectCode(run(example(), prop([setOp("main")], otherHash)), "stale_base");
  expectCode(run(other, prop([setOp("main")], BASE_HASH)), "stale_base");
  expectCode(run(example(), prop([setOp("main")], BASE_HASH.toUpperCase())), "invalid_base_hash");
  expectCode(run(example(), prop([setOp("main")], "0".repeat(64))), "stale_base");
  for (const h of [`${BASE_HASH} `, BASE_HASH.slice(1), `${BASE_HASH}0`, "", 1, null]) expectCode(run(example(), prop([setOp("main")], h as any)), "invalid_base_hash");
  assert.equal(run(example(), prop([setOp("main")])).ok, true);
});

// ---- 8. purity / isolation (static) ---------------------------------------------------------------------------

test("edit adversarial: the compiled edit modules import only the allowlist and use no ambient authority", () => {
  const dir = join(import.meta.dirname, "..", "src", "edit");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.deepEqual(files.sort(), ["engine.js", "paths.js", "proposal.js", "types.js"]);
  const allowed = new Set(["zod", "../spec/schema.js", "../spec/validate.js", "../spec/dupkeys.js", "./types.js", "./paths.js", "./proposal.js"]);
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    const specs = [...raw.matchAll(/(?:\bfrom|\bimport)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!);
    for (const s of specs) assert.ok(allowed.has(s), `${f} imports ${s}`);
    // ignore comments so documentation may mention what the code must not do
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const [re, what] of [
      [/["']node:/, "node: specifier"],
      [/\bprocess\./, "process."],
      [/\bDate\b/, "Date"],
      [/Math\.random/, "Math.random"],
      [/\bfetch\s*\(/, "fetch("],
      [/\brequire\s*\(/, "require("],
      [/\bimport\s*\(/, "dynamic import"],
      [/\beval\s*\(|\bnew\s+Function\b/, "eval/Function"],
      [/\b(approve|registerDesign|registerLocked|registerCanonical|initIfMissing|reset|withLock)\s*\(/, "state-changing call"],
      [/\bload\(/, "load("],
    ] as Array<[RegExp, string]>) {
      assert.ok(!re.test(src), `${f} contains ${what}`);
    }
  }
});

// ---- 9. grammar drift guard -----------------------------------------------------------------------------------

test("edit adversarial: the server path grammar and resolver are identical to the preview's", () => {
  const preview = readFileSync(join(repoRoot, "preview", "src", "render", "paths.ts"), "utf8");
  const server = readFileSync(join(repoRoot, "server", "src", "edit", "paths.ts"), "utf8");
  const line = (src: string, prefix: string): string => {
    const l = src.split("\n").find((x) => x.startsWith(prefix));
    assert.ok(l, `missing ${prefix}`);
    return l!;
  };
  const fn = (src: string, header: string): string => {
    const start = src.indexOf(header);
    assert.ok(start >= 0, `missing ${header}`);
    const end = src.indexOf("\n}\n", start);
    assert.ok(end > start, `unterminated ${header}`);
    return src.slice(start, end + 2);
  };
  for (const p of ["const INDEX = ", "const PATH = ", "const MAX_PATH = ", "export const isPathSyntax = "]) assert.equal(line(server, p), line(preview, p), p);
  assert.equal(fn(server, "export function resolvePath("), fn(preview, "export function resolvePath("));
  assert.equal(fn(server, "function at<T>("), fn(preview, "function at<T>("));
});

// ---- 10. no shared references ---------------------------------------------------------------------------------

test("edit adversarial: a successful result shares no object with the base or the proposal", () => {
  const proposals: unknown[] = [
    prop([setOp("main")]),
    prop([{ op: "set", path: "main.1", expect: "text", prop: "content", value: "Recent expenses" }]), // no-op edit
    prop([{ op: "insert", parent: "main", parentExpect: "main", index: 1, node: { type: "stack", children: [{ type: "text", content: "nested" }] } }]),
    prop([{ op: "insert", parent: "header", parentExpect: "header", index: 1, node: { type: "button", label: "Export" } }]),
    prop([{ op: "move", path: "main.2", expect: "table", parent: "main", parentExpect: "main", index: 0 }]),
    prop([{ op: "remove", path: "main.0.1", expect: "stat-card" }]),
  ];
  for (const p of proposals) {
    const base = example();
    const r = run(base, p);
    assert.equal(r.ok, true, JSON.stringify(r).slice(0, 200));
    if (!r.ok) continue;
    assert.notEqual(r.spec, base);
    const out = objectsIn(r.spec);
    for (const o of objectsIn(base)) assert.equal(out.has(o), false, "result shares an object with the base");
    for (const o of objectsIn(p)) assert.equal(out.has(o), false, "result shares an object with the proposal");
    // and mutating the result does not reach the base
    const before = JSON.stringify(base);
    (r.spec.layout.main.children as any[]).length = 0;
    assert.equal(JSON.stringify(base), before);
  }
  // a second call on the same base returns a distinct result object graph
  const base = example();
  const a = run(base, prop([setOp("main")]));
  const b = run(base, prop([setOp("main")]));
  assert.ok(a.ok && b.ok);
  if (a.ok && b.ok) {
    const sa = objectsIn(a.spec);
    for (const o of objectsIn(b.spec)) assert.equal(sa.has(o), false, "two results share an object");
  }
});

test("edit adversarial: an error pointer never carries a caller's control or bidi-override characters", () => {
  const r = run(example(), { ...prop([{ op: "set", path: "main", expect: "main", prop: "gap", value: "lg" }]), "‮evil\u0007": 1 });
  expectCode(r, "unknown_key");
  assert.ok(!/[\u0000-\u001F‪-‮⁦-⁩]/.test(JSON.stringify((r as any).error.at)));
});

test("edit adversarial: oversized in-process proposals and bases are rejected by serialized size", () => {
  const huge = "x".repeat(200 * 1024);
  expectCode(run(example(), prop([{ op: "set", path: "main.1", expect: "text", prop: "content", value: huge }])), "too_large");
  const base = example();
  base.screen.purpose = huge;
  expectCode(run(base, prop([{ op: "set", path: "main", expect: "main", prop: "gap", value: "lg" }])), "invalid_base");
});
