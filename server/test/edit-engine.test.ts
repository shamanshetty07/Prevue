import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { applyOps } from "../src/edit/engine.js";
import type { EditResult } from "../src/edit/types.js";
import { LIMITS } from "../src/spec/schema.js";
import { parseSpecText, validateSpec } from "../src/spec/validate.js";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const example = (): any => JSON.parse(exampleText);
const hashOf = (spec: unknown): string => {
  const r = validateSpec(spec);
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 300));
  return (r as any).hash;
};
const BASE_HASH = hashOf(example());

/** Applies ops to `base` (the example by default) with the correct base hash. */
const run = (ops: unknown[], base: any = example()): EditResult => applyOps(base, { baseHash: hashOf(base), ops });
const ok = (r: EditResult): Extract<EditResult, { ok: true }> => {
  assert.equal(r.ok, true, JSON.stringify(r).slice(0, 400));
  const s = r as Extract<EditResult, { ok: true }>;
  assert.equal(s.hash, hashOf(s.spec)); // the reported hash is the hash of the candidate itself
  return s;
};
const err = (r: EditResult, code: string, op?: number) => {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 400));
  if (r.ok) return r;
  assert.equal(r.error.code, code, JSON.stringify(r.error).slice(0, 400));
  assert.equal(r.error.op, op);
  assert.ok(!("spec" in r) && !("hash" in r));
  return r;
};

const set = (path: string, expect: string, prop: string, value: string | number) => ({ op: "set", path, expect, prop, value });
const insert = (parent: string, parentExpect: string, index: number, node: unknown) => ({ op: "insert", parent, parentExpect, index, node });
const remove = (path: string, expect: string) => ({ op: "remove", path, expect });
const move = (path: string, expect: string, parent: string, parentExpect: string, index: number) => ({ op: "move", path, expect, parent, parentExpect, index });
const text = (content: string) => ({ type: "text", content });
const stack = (children: unknown[] = []) => ({ type: "stack", children });
const withMain = (children: unknown[]) => {
  const s = example();
  s.layout.main.children = children;
  return s;
};
const reverseKeys = (v: any): any =>
  Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
const deepFreeze = <T>(v: T): T => {
  if (v && typeof v === "object") {
    for (const x of Object.values(v)) deepFreeze(x);
    Object.freeze(v);
  }
  return v;
};
const types = (list: Array<{ type: string }>) => list.map((n) => n.type);

// ---- set ---------------------------------------------------------------------------------------------------------

test("edit: set reaches every target kind and the hash is the candidate's", () => {
  const cases: Array<[ReturnType<typeof set>, (s: any) => unknown, unknown]> = [
    [set("main", "main", "gap", "lg"), (s) => s.layout.main.gap, "lg"],
    [set("header", "header", "title", "Spending"), (s) => s.layout.header.title, "Spending"],
    [set("sidebar", "sidebar", "width", "narrow"), (s) => s.layout.sidebar.width, "narrow"],
    [set("main.0", "grid", "columns", 2), (s) => s.layout.main.children[0].columns, 2],
    [set("main.1", "text", "content", "Latest"), (s) => s.layout.main.children[1].content, "Latest"],
    [set("header.actions.0", "button", "label", "New"), (s) => s.layout.header.actions[0].label, "New"],
    [set("main.0.1", "stat-card", "hint", "This month"), (s) => s.layout.main.children[0].children[1].hint, "This month"],
    [set("main.2", "table", "caption", "Last 30 days"), (s) => s.layout.main.children[2].caption, "Last 30 days"],
  ];
  for (const [op, get, want] of cases) {
    const r = ok(run([op]));
    assert.equal(get(r.spec), want, op.path);
    assert.equal(r.baseHash, BASE_HASH);
    assert.equal(r.changed, true);
    assert.notEqual(r.hash, BASE_HASH);
  }
});

test("edit: a set that changes nothing reports changed:false and the base hash", () => {
  for (const value of ["Expenses", "  Expenses  "]) {
    const r = ok(run([set("header", "header", "title", value)]));
    assert.equal(r.changed, false);
    assert.equal(r.hash, BASE_HASH);
    assert.deepEqual(r.spec, (validateSpec(example()) as any).spec);
  }
});

test("edit: set on a missing path or the wrong type fails", () => {
  err(run([set("main.7", "text", "content", "x")]), "path_unresolved", 0);
  err(run([set("main.1", "table", "caption", "x")]), "type_mismatch", 0);
  err(run([set("main.0.0.0", "text", "content", "x")]), "path_unresolved", 0);
});

// ---- insert ------------------------------------------------------------------------------------------------------

test("edit: insert into main at 0 and at the end, into a grid, and a header button, with defaults filled", () => {
  let r = ok(run([insert("main", "main", 0, text("Hello"))]));
  assert.deepEqual(r.spec.layout.main.children[0], { type: "text", content: "Hello", variant: "body", tone: "default" });
  assert.deepEqual(types(r.spec.layout.main.children), ["text", "grid", "text", "table"]);

  r = ok(run([insert("main", "main", 3, stack())]));
  assert.deepEqual(r.spec.layout.main.children[3], { type: "stack", direction: "column", gap: "md", align: "stretch", children: [] });

  r = ok(run([insert("main.0", "grid", 1, { type: "stat-card", label: "Average", value: "$140" })]));
  const grid = r.spec.layout.main.children[0] as any;
  assert.deepEqual(grid.children.map((c: any) => c.label), ["Total spend", "Average", "Largest category", "Budget left"]);

  r = ok(run([insert("header", "header", 1, { type: "button", label: "Export" })]));
  assert.deepEqual(r.spec.layout.header!.actions[1], { type: "button", label: "Export", variant: "secondary" });
  assert.equal(r.stats.nodes, 10);
});

test("edit: insert rejects an index past the end, a non-container parent and a fourth header action", () => {
  err(run([insert("main", "main", 4, text("x"))]), "index_out_of_range", 0);
  err(run([insert("main.0", "grid", 4, text("x"))]), "index_out_of_range", 0);
  err(run([insert("main.1", "stack", 0, text("x"))]), "type_mismatch", 0);
  err(run([insert("main.9", "stack", 0, text("x"))]), "path_unresolved", 0);
  const b = { type: "button", label: "More" };
  const r = err(run([insert("header", "header", 0, b), insert("header", "header", 0, b), insert("header", "header", 0, b)]), "invalid_result", 2);
  assert.ok(r.error.issues?.some((i) => i.code === "limit_exceeded"));
});

test("edit: inserted components cannot carry ids in this phase", () => {
  assert.equal(run([insert("main", "main", 0, { type: "text", id: "intro", content: "x" })]).ok, false);
});

// ---- remove ------------------------------------------------------------------------------------------------------

test("edit: remove takes a main-tree node out and shifts its siblings, or a header action", () => {
  let r = ok(run([remove("main.0", "grid")]));
  assert.deepEqual(types(r.spec.layout.main.children), ["text", "table"]);
  assert.equal(r.stats.nodes, 5);
  r = ok(run([remove("main.0.0", "stat-card")]));
  assert.deepEqual((r.spec.layout.main.children[0] as any).children.map((c: any) => c.label), ["Largest category", "Budget left"]);
  r = ok(run([remove("header.actions.0", "button")]));
  assert.deepEqual(r.spec.layout.header!.actions, []);
});

test("edit: the fixed regions cannot be removed; wrong type and missing paths fail", () => {
  for (const p of ["main", "header", "sidebar"]) err(run([remove(p, "grid")]), "not_removable", 0);
  err(run([remove("main.0", "stack")]), "type_mismatch", 0);
  err(run([remove("header.actions.1", "button")]), "path_unresolved", 0);
});

// ---- move --------------------------------------------------------------------------------------------------------

test("edit: move reorders within main; the index is the final position after removal", () => {
  assert.deepEqual(types(ok(run([move("main.0", "grid", "main", "main", 2)])).spec.layout.main.children), ["text", "table", "grid"]);
  assert.deepEqual(types(ok(run([move("main.0", "grid", "main", "main", 1)])).spec.layout.main.children), ["text", "grid", "table"]);
  assert.deepEqual(types(ok(run([move("main.2", "table", "main", "main", 0)])).spec.layout.main.children), ["table", "grid", "text"]);
  const same = ok(run([move("main.1", "text", "main", "main", 1)]));
  assert.equal(same.changed, false);
  assert.equal(same.hash, BASE_HASH);
  err(run([move("main.0", "grid", "main", "main", 3)]), "index_out_of_range", 0);
});

test("edit: move reparents into a grid and into a stack resolved before the source is removed", () => {
  let r = ok(run([move("main.1", "text", "main.0", "grid", 0)]));
  assert.deepEqual(types(r.spec.layout.main.children), ["grid", "table"]);
  assert.deepEqual(types((r.spec.layout.main.children[0] as any).children), ["text", "stat-card", "stat-card", "stat-card"]);

  // main.3 is the new stack; after main.1 leaves it sits at main.2, but the destination was already fixed.
  r = ok(run([insert("main", "main", 3, stack()), move("main.1", "text", "main.3", "stack", 0)]));
  assert.deepEqual(types(r.spec.layout.main.children), ["grid", "table", "stack"]);
  assert.deepEqual((r.spec.layout.main.children[2] as any).children, [{ type: "text", content: "Recent expenses", variant: "subheading", tone: "default" }]);
  // A stat-card can leave its grid for main.
  r = ok(run([move("main.0.2", "stat-card", "main", "main", 3)]));
  assert.deepEqual(types(r.spec.layout.main.children), ["grid", "text", "table", "stat-card"]);
});

test("edit: a node cannot move into itself or a descendant, but main.1 is not inside main.10", () => {
  err(run([move("main.0", "grid", "main.0", "grid", 0)]), "move_into_self", 0);
  const nested = withMain([stack([stack([text("leaf")])])]);
  err(run([move("main.0", "stack", "main.0.0", "stack", 0)], nested), "move_into_self", 0);

  const wide = withMain(Array.from({ length: 11 }, (_, i) => (i === 1 ? stack([text("one")]) : stack())));
  const r = ok(run([move("main.1", "stack", "main.10", "stack", 0)], wide));
  assert.equal(r.spec.layout.main.children.length, 10);
  assert.deepEqual((r.spec.layout.main.children[9] as any).children[0].children[0].content, "one");
  const back = ok(run([move("main.10", "stack", "main.1", "stack", 1)], wide));
  assert.deepEqual(types((back.spec.layout.main.children[1] as any).children), ["text", "stack"]);
});

test("edit: header actions and main components stay on their own side; roots are not movable", () => {
  err(run([move("header.actions.0", "button", "main", "main", 0)]), "invalid_parent", 0);
  err(run([insert("main", "main", 0, { type: "button", label: "Go" }), move("main.0", "button", "header", "header", 0)]), "invalid_parent", 1);
  err(run([insert("header", "header", 0, text("x"))]), "invalid_component", 0); // the parser reads header inserts as buttons
  for (const p of ["main", "header", "sidebar"]) err(run([move(p, "grid", "main", "main", 0)]), "not_movable", 0);
  const r = ok(run([insert("header", "header", 1, { type: "button", label: "Export" }), move("header.actions.0", "button", "header", "header", 1)]));
  assert.deepEqual(r.spec.layout.header!.actions.map((b) => b.label), ["Export", "Add expense"]);
});

test("edit: ids survive a move", () => {
  const base = example();
  base.layout.main.children[0].id = "kpis";
  base.layout.main.children[1].id = "intro";
  const r = ok(run([move("main.1", "text", "main.0", "grid", 3)], base));
  const grid = r.spec.layout.main.children[0] as any;
  assert.equal(grid.id, "kpis");
  assert.equal(grid.children[3].id, "intro");
});

// ---- sequential resolution ---------------------------------------------------------------------------------------

test("edit: each op resolves against the result of the ops before it", () => {
  const r = ok(run([remove("main.0", "grid"), set("main.0", "text", "content", "Shifted")]));
  assert.equal((r.spec.layout.main.children[0] as any).content, "Shifted");
  err(run([remove("main.0", "grid"), set("main.2", "text", "content", "x")]), "path_unresolved", 1);
  err(run([remove("main.0", "grid"), set("main.1", "text", "content", "x")]), "type_mismatch", 1);
});

// ---- limits on the result ----------------------------------------------------------------------------------------

const limitIssue = (r: EditResult) => assert.ok(!r.ok && r.error.issues?.some((i) => i.code === "limit_exceeded"), JSON.stringify(r).slice(0, 400));

test("edit: a 13th child is rejected at the op that adds it", () => {
  const ops = Array.from({ length: 10 }, () => insert("main", "main", 0, text("x")));
  limitIssue(err(run(ops), "invalid_result", 9));
  assert.equal(run(ops.slice(0, 9)).ok, true);
});

test("edit: nesting deeper than the limit is rejected, by insert and by move", () => {
  const deep = (n: number): any => (n === 0 ? text("leaf") : stack([deep(n - 1)]));
  assert.equal(run([insert("main.0", "grid", 0, deep(3))]).ok, true);
  limitIssue(err(run([insert("main.0", "grid", 0, deep(4))]), "invalid_result", 0));

  const base = withMain([deep(4), stack([text("x")])]);
  limitIssue(err(run([move("main.1", "stack", "main.0.0.0.0", "stack", 0)], base), "invalid_result", 0));
  assert.equal(run([move("main.1", "stack", "main.0.0.0", "stack", 0)], base).ok, true);
});

test("edit: more than the component limit is rejected", () => {
  const grid = { type: "grid", columns: 4, children: Array.from({ length: 12 }, () => ({ type: "stat-card", label: "L", value: "V" })) };
  // 9 in the example + 13 per grid: three fit (48), the fourth makes 61.
  limitIssue(err(run(Array.from({ length: 4 }, () => insert("main", "main", 0, grid))), "invalid_result", 3));
  assert.ok(9 + 4 * 13 > LIMITS.nodes && 9 + 3 * 13 <= LIMITS.nodes);
});

test("edit: a candidate larger than the size limit is too_large", () => {
  const cell = "€".repeat(60); // 180 bytes of UTF-8 per cell
  const table = {
    type: "table",
    caption: "€".repeat(80),
    columns: Array.from({ length: 8 }, (_, i) => ({ key: `c${i}`, header: `C${i}` })),
    rows: Array.from({ length: 12 }, () => Array.from({ length: 8 }, () => cell)),
  };
  // A proposal carrying all four tables is itself over the limit and is refused before any op runs.
  const ops = Array.from({ length: 4 }, () => insert("main", "main", 0, table));
  err(run(ops), "too_large");
  // A small proposal can still overflow a large base: three tables fit, the fourth is rejected at the op that adds it.
  const base = ok(run(ops.slice(0, 3))).spec;
  assert.ok(Buffer.byteLength(JSON.stringify(base), "utf8") <= LIMITS.rawBytes);
  err(run([set("main", "main", "gap", "lg"), insert("main", "main", 0, table)], base), "too_large", 1);
});

// ---- base checks -------------------------------------------------------------------------------------------------

test("edit: a well-formed hash of another design is stale_base; an invalid base is invalid_base", () => {
  err(applyOps(example(), { baseHash: "0".repeat(64), ops: [set("header", "header", "title", "x")] }), "stale_base");
  const other = example();
  other.screen.name = "Other";
  err(applyOps(other, { baseHash: BASE_HASH, ops: [set("header", "header", "title", "x")] }), "stale_base");
  const extra = { ...example(), extra: 1 };
  const r = err(applyOps(extra, { baseHash: BASE_HASH, ops: [set("header", "header", "title", "x")] }), "invalid_base");
  assert.ok(r.error.issues?.some((i) => i.code === "unknown_key"));
  err(applyOps(null, { baseHash: BASE_HASH, ops: [set("header", "header", "title", "x")] }), "invalid_base");
});

test("edit: proposal errors come back unchanged and the base is not consulted", () => {
  err(applyOps(null, { baseHash: "nope", ops: [set("header", "header", "title", "x")] }), "invalid_base_hash");
  assert.equal(applyOps(null, { baseHash: BASE_HASH, ops: [] }).ok, false);
  assert.equal(applyOps(example(), null).ok, false);
});

// ---- atomicity, immutability, isolation, determinism ------------------------------------------------------------

test("edit: a failing op yields no candidate and leaves the base untouched", () => {
  const base = example();
  const snapshot = structuredClone(base);
  const r = applyOps(base, { baseHash: BASE_HASH, ops: [set("header", "header", "title", "A"), remove("main.0", "grid"), set("main.5", "text", "content", "x")] });
  err(r, "path_unresolved", 2);
  assert.deepEqual(Object.keys(r).sort(), ["error", "ok"]);
  assert.deepEqual(base, snapshot);
});

test("edit: deep-frozen inputs are accepted and never written", () => {
  const base = deepFreeze(example());
  const proposal = deepFreeze({
    baseHash: BASE_HASH,
    ops: [set("header", "header", "title", "A"), insert("main.0", "grid", 0, { type: "stat-card", label: "L", value: "V" }), move("main.1", "text", "main", "main", 0), remove("main.2", "table")],
  });
  const r = ok(applyOps(base, proposal));
  assert.deepEqual(types(r.spec.layout.main.children), ["text", "grid"]);
  assert.deepEqual(base, example());
});

test("edit: the candidate shares no references with the base or the proposal", () => {
  const base = example();
  const node: any = { type: "text", content: "Mine" };
  const proposal = { baseHash: BASE_HASH, ops: [insert("main", "main", 0, node)] };
  const r = ok(applyOps(base, proposal));
  (r.spec.layout.header as any).title = "Changed";
  (r.spec.layout.main.children[1] as any).children.length = 0;
  assert.deepEqual(base, example());
  node.content = "Mutated";
  (proposal.ops[0] as any).node.variant = "heading";
  assert.equal((r.spec.layout.main.children[0] as any).content, "Mine");
  assert.equal((r.spec.layout.main.children[0] as any).variant, "body");
});

test("edit: results are deterministic and independent of key order", () => {
  const proposal = { baseHash: BASE_HASH, ops: [insert("main", "main", 1, { type: "stat-card", label: "L", value: "V", hint: "H" }), set("main.0", "grid", "gap", "lg")] };
  const a = ok(applyOps(example(), proposal));
  const b = ok(applyOps(example(), proposal));
  assert.deepEqual(a, b);
  const c = ok(applyOps(reverseKeys(example()), reverseKeys(proposal)));
  assert.equal(c.hash, a.hash);
});

test("edit: the candidate round-trips through parseSpecText to the same hash", () => {
  const r = ok(run([insert("main", "main", 3, { type: "text", content: "Café", variant: "caption" }), move("main.2", "table", "main", "main", 0), set("sidebar", "sidebar", "title", "Nav")]));
  const back = parseSpecText(JSON.stringify(r.spec));
  assert.equal(back.ok, true);
  assert.equal((back as any).hash, r.hash);
});
