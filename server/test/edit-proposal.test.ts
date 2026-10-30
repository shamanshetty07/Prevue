import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { parseProposal, parseProposalText, SETTABLE } from "../src/edit/proposal.js";
import { EDIT_LIMITS, type ProposalResult } from "../src/edit/types.js";
import { LIMITS } from "../src/spec/schema.js";
import { validateSpec } from "../src/spec/validate.js";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const base = validateSpec(JSON.parse(exampleText));
assert.equal(base.ok, true);
const HASH = (base as any).hash as string;

const MARKER = "ZZMARKERZZ";
const proposal = (...ops: unknown[]): any => ({ baseHash: HASH, ops });
const setOp = (o: Record<string, unknown> = {}): any => ({ op: "set", path: "main.1", expect: "text", prop: "content", value: "Hello", ...o });
const insertOp = (o: Record<string, unknown> = {}): any => ({ op: "insert", parent: "main", parentExpect: "main", index: 0, node: { type: "text", content: "New" }, ...o });
const removeOp = (o: Record<string, unknown> = {}): any => ({ op: "remove", path: "main.1", expect: "text", ...o });
const moveOp = (o: Record<string, unknown> = {}): any => ({ op: "move", path: "main.0.2", expect: "stat-card", parent: "main", parentExpect: "main", index: 0, ...o });

const ok = (r: ProposalResult): any => {
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r as any).proposal;
};
/** Asserts the code (and the op index when given); also that no caller marker leaked into the error. */
const err = (r: ProposalResult, code: string, op?: number): any => {
  assert.equal(r.ok, false, JSON.stringify(r).slice(0, 300));
  const e = (r as any).error;
  assert.equal(e.code, code, JSON.stringify(e));
  assert.equal(e.op, op, JSON.stringify(e));
  assert.ok(!JSON.stringify(e).includes(MARKER), "error does not contain marker");
  return e;
};

test("edit: a minimal proposal of each op type parses", () => {
  for (const op of [setOp(), insertOp(), removeOp(), moveOp()]) {
    const p = ok(parseProposal(proposal(op)));
    assert.equal(p.baseHash, HASH);
    assert.equal(p.ops.length, 1);
    assert.equal(p.ops[0].op, op.op);
  }
  const p = ok(parseProposal(proposal(setOp(), insertOp(), removeOp(), moveOp())));
  assert.deepEqual(p.ops.map((o: any) => o.op), ["set", "insert", "remove", "move"]);
  assert.deepEqual(ok(parseProposal(proposal(removeOp()))).ops[0], { op: "remove", path: "main.1", expect: "text" });
  ok(parseProposal(proposal(insertOp({ parent: "header", parentExpect: "header", node: { type: "button", label: "Go" } }))));
  ok(parseProposal(proposal(moveOp({ path: "header.actions.0", expect: "button", parent: "header", parentExpect: "header" }))));
});

test("edit: set values are normalized and inserted nodes get their defaults", () => {
  const p = ok(parseProposal(proposal(setOp({ value: "  Café  " }))));
  assert.equal(p.ops[0].value, "Café");
  const ins = ok(parseProposal(proposal(insertOp({ node: { type: "stack", children: [{ type: "text", content: " x " }] } }))));
  assert.deepEqual(ins.ops[0].node, { type: "stack", direction: "column", gap: "md", align: "stretch", children: [{ type: "text", content: "x", variant: "body", tone: "default" }] });
  const btn = ok(parseProposal(proposal(insertOp({ parent: "header", parentExpect: "header", node: { type: "button", label: "Go" } }))));
  assert.deepEqual(btn.ops[0].node, { type: "button", label: "Go", variant: "secondary" });
});

test("edit: unknown keys at the top level and inside an op are rejected", () => {
  err(parseProposal({ ...proposal(setOp()), extra: 1 }), "unknown_key");
  assert.equal(err(parseProposal({ ...proposal(setOp()), "a/b~c": 1 }), "unknown_key").at, "/a~1b~0c");
  assert.equal(err(parseProposal({ ...proposal(setOp()), ["k".repeat(100)]: 1 }), "unknown_key").at, `/${"k".repeat(40)}…`);
  err(parseProposal(JSON.parse(`{"baseHash":"${HASH}","ops":[],"__proto__":1}`)), "unknown_key");
  for (const mk of [setOp, insertOp, removeOp, moveOp]) err(parseProposal(proposal(setOp(), mk({ extra: 1 }))), "unknown_key", 1);
  err(parseProposal(proposal(removeOp({ index: 0 }))), "unknown_key", 0); // a move key on a remove
  err(parseProposal(proposal(setOp({ id: "x" }))), "unknown_key", 0);
});

test("edit: unknown op names are rejected", () => {
  for (const name of ["delete", "SET", "", "constructor", "__proto__", "toString", 1, null, MARKER]) err(parseProposal(proposal(setOp({ op: name }))), "unknown_op", 0);
  const { op: _drop, ...noOp } = setOp();
  err(parseProposal(proposal(noOp)), "unknown_op", 0);
  for (const bad of [null, "set", 1, [], [setOp()]]) err(parseProposal(proposal(removeOp(), bad)), "unknown_op", 1);
});

test("edit: baseHash must be 64 lowercase hex characters", () => {
  ok(parseProposal({ baseHash: "0".repeat(64), ops: [setOp()] }));
  for (const h of [HASH.toUpperCase(), HASH.slice(1), HASH + "a", "g".repeat(64), ` ${HASH}`, `${HASH}\n`, `sha256:${HASH}`, 42, null, [], {}]) {
    if (h === HASH.toUpperCase() && !/[a-f]/.test(HASH)) continue;
    err(parseProposal({ baseHash: h, ops: [setOp()] }), "invalid_base_hash");
  }
  err(parseProposal({ ops: [setOp()] }), "invalid_proposal");
});

test("edit: ops must be a non-empty array within the limit", () => {
  err(parseProposal({ baseHash: HASH, ops: [] }), "invalid_proposal");
  for (const v of [{}, "set", 1, null]) err(parseProposal({ baseHash: HASH, ops: v }), "invalid_proposal");
  err(parseProposal({ baseHash: HASH }), "invalid_proposal");
  for (const v of [null, [], "x", 1, undefined]) err(parseProposal(v), "invalid_proposal");
  assert.equal(ok(parseProposal(proposal(...Array.from({ length: EDIT_LIMITS.ops }, () => removeOp())))).ops.length, EDIT_LIMITS.ops);
  err(parseProposal(proposal(...Array.from({ length: EDIT_LIMITS.ops + 1 }, () => removeOp()))), "too_many_ops");
});

test("edit: invalid paths are rejected without echoing them", () => {
  const bad = ["", "Main", "main.", "main.01", "main.-1", "main.100", "main.0.0.0.0.0.0.0.0.0", "header.actions", "sidebar.0", "layout.main", ` main`, `main.${MARKER}`, "x".repeat(100), 0, null];
  for (const p of bad) {
    err(parseProposal(proposal(setOp({ path: p }))), "invalid_path", 0);
    err(parseProposal(proposal(removeOp(), moveOp({ parent: p }))), "invalid_path", 1);
    err(parseProposal(proposal(insertOp({ parent: p }))), "invalid_path", 0);
  }
});

test("edit: expect, parentExpect and index are checked", () => {
  for (const e of ["header", "sidebar", "main"]) {
    ok(parseProposal(proposal(setOp({ path: e, expect: e, prop: e === "main" ? "gap" : "title", value: "md" }))));
    err(parseProposal(proposal(removeOp({ expect: e }))), "invalid_proposal", 0);
    err(parseProposal(proposal(moveOp({ expect: e }))), "invalid_proposal", 0);
  }
  for (const e of ["Text", "sidebar-item", "", 1, null, MARKER]) err(parseProposal(proposal(setOp({ expect: e }))), "invalid_proposal", 0);
  for (const pe of ["text", "sidebar", "button", "table", "", null]) {
    err(parseProposal(proposal(insertOp({ parentExpect: pe }))), "invalid_proposal", 0);
    err(parseProposal(proposal(moveOp({ parentExpect: pe }))), "invalid_proposal", 0);
  }
  for (const i of [-1, 1.5, "0", LIMITS.children + 1, NaN, Infinity, null, 2 ** 53]) {
    err(parseProposal(proposal(insertOp({ index: i }))), "invalid_proposal", 0);
    err(parseProposal(proposal(moveOp({ index: i }))), "invalid_proposal", 0);
  }
  ok(parseProposal(proposal(insertOp({ index: LIMITS.children }))));
  ok(parseProposal(proposal(moveOp({ index: 0 }))));
  const { expect: _e, ...missing } = removeOp();
  err(parseProposal(proposal(missing)), "invalid_proposal", 0);
});

test("edit: only allowlisted properties can be set", () => {
  const types = ["main", "header", "sidebar", "stack", "grid", "text", "button", "stat-card", "table"];
  const banned = ["type", "id", "children", "actions", "items", "delta", "columns", "rows", "__proto__", "constructor", "toString", "hasOwnProperty", "schemaVersion", MARKER];
  for (const t of types)
    for (const prop of banned) {
      if (t === "grid" && prop === "columns") continue;
      err(parseProposal(proposal(setOp({ path: "main.1", expect: t, prop, value: "x" }))), "property_not_allowed", 0);
    }
  err(parseProposal(proposal(setOp({ expect: "table", prop: "columns", value: 2 }))), "property_not_allowed", 0);
  err(parseProposal(proposal(setOp({ expect: "text", prop: "label" }))), "property_not_allowed", 0); // a button prop on a text
  err(parseProposal(proposal(setOp({ prop: 1 }))), "invalid_proposal", 0);
  assert.deepEqual([...SETTABLE.keys()].sort(), [...types].sort());
  assert.throws(() => (SETTABLE as any).set("text", new Map()));
  assert.throws(() => (SETTABLE.get("text") as any).set("id", null));
  assert.equal(SETTABLE.get("text")!.has("id"), false);
});

test("edit: every allowlisted property accepts a valid value", () => {
  const good: Record<string, Record<string, string | number>> = {
    main: { gap: "lg", padding: "none" },
    header: { title: "T", subtitle: "S" },
    sidebar: { title: "T", width: "narrow" },
    stack: { direction: "row", gap: "xs", align: "center" },
    grid: { columns: 4, gap: "xl" },
    text: { content: "C", variant: "heading", tone: "danger" },
    button: { label: "L", variant: "ghost", note: "N" },
    "stat-card": { label: "L", value: "V", hint: "H" },
    table: { caption: "C", emptyText: "E" },
  };
  for (const [t, m] of SETTABLE) {
    assert.deepEqual([...m.keys()].sort(), Object.keys(good[t]!).sort(), t);
    for (const [prop, value] of Object.entries(good[t]!)) {
      const p = ok(parseProposal(proposal(setOp({ path: "main.1", expect: t, prop, value }))));
      assert.deepEqual(p.ops[0], { op: "set", path: "main.1", expect: t, prop, value });
    }
  }
});

test("edit: invalid values are rejected", () => {
  const cases: Array<[string, string, unknown]> = [
    ["grid", "columns", 5],
    ["grid", "columns", 0],
    ["grid", "columns", 2.5],
    ["grid", "columns", "3"],
    ["text", "content", "x".repeat(501)],
    ["text", "content", "   "],
    ["text", "content", `a\u0000${MARKER}`],
    ["text", "content", "a‮b"],
    ["header", "title", "x".repeat(61)],
    ["text", "variant", "huge"],
    ["main", "gap", "md "],
    ["text", "content", { a: 1 }],
    ["text", "content", ["a"]],
    ["text", "content", null],
    ["text", "content", true],
    ["button", "note", null],
    ["text", "content", 5],
  ];
  for (const [expect, prop, value] of cases) err(parseProposal(proposal(setOp({ expect, prop, value }))), "invalid_value", 0);
});

test("edit: inserted components must be valid, id-free and fit the parent", () => {
  err(parseProposal(proposal(insertOp({ node: { type: "text", content: "x", id: "a" } }))), "invalid_component", 0);
  err(parseProposal(proposal(insertOp({ node: { type: "stack", children: [{ type: "grid", columns: 2, children: [{ type: "text", content: "x", id: "deep" }] }] } }))), "invalid_component", 0);
  err(parseProposal(proposal(insertOp({ parent: "header", parentExpect: "header", node: { type: "button", label: "Go", id: "b" } }))), "invalid_component", 0);
  err(parseProposal(proposal(insertOp({ parent: "header", parentExpect: "header", node: { type: "stat-card", label: "L", value: "V" } }))), "invalid_component", 0);
  err(parseProposal(proposal(insertOp({ node: { type: MARKER, content: "x" } }))), "invalid_component", 0);
  err(parseProposal(proposal(insertOp({ node: { type: "header", title: "x" } }))), "invalid_component", 0);
  err(parseProposal(proposal(insertOp({ node: { type: "text", content: "x", extra: MARKER } }))), "invalid_component", 0);
  err(parseProposal(proposal(insertOp({ node: { type: "text" } }))), "invalid_component", 0);
  for (const n of [null, "text", 1, []]) err(parseProposal(proposal(insertOp({ node: n }))), "invalid_component", 0);
  // A table's own keys are fine; only "id" is deferred.
  ok(parseProposal(proposal(insertOp({ node: { type: "table", columns: [{ key: "a", header: "A" }], rows: [["1"]] } }))));
});

test("edit: the first failing op is reported in order", () => {
  err(parseProposal(proposal(setOp(), removeOp(), setOp({ value: 9 }), setOp({ path: "bad" }))), "invalid_value", 2);
});

test("edit: parseProposalText checks size, syntax, duplicates and nesting", () => {
  const text = JSON.stringify(proposal(setOp()));
  ok(parseProposalText(text));
  err(parseProposalText(42), "invalid_json");
  err(parseProposalText(null), "invalid_json");
  err(parseProposalText(" ".repeat(EDIT_LIMITS.rawBytes) + "{"), "too_large"); // too large wins over invalid JSON
  err(parseProposalText(`{"x":"${MARKER}`), "invalid_json");
  err(parseProposalText(`${MARKER}`), "invalid_json");
  err(parseProposalText(""), "invalid_json");
  assert.equal(err(parseProposalText(`{"baseHash":"${HASH}","baseHash":"${HASH}","ops":[]}`), "duplicate_key").at, "/baseHash");
  assert.equal(err(parseProposalText(`{"baseHash":"${HASH}","ops":[{"op":"remove","path":"main.1","path":"main.0","expect":"text"}]}`), "duplicate_key", 0).at, "/ops/0/path");
  const dupNode = `{"baseHash":"${HASH}","ops":[${JSON.stringify(removeOp())},{"op":"insert","parent":"main","parentExpect":"main","index":0,"node":{"type":"text","content":"a","content":"b"}}]}`;
  assert.equal(err(parseProposalText(dupNode), "duplicate_key", 1).at, "/ops/1/node/content");
  err(parseProposalText("[".repeat(5000) + "]".repeat(5000)), "too_complex");
  err(parseProposalText(`{"baseHash":"${HASH}","ops":[${JSON.stringify(insertOp({ node: { type: "text", content: "x", pad: "[".repeat(1) } }))}]}`), "invalid_component", 0);
  err(parseProposalText(JSON.stringify({ baseHash: HASH, ops: [setOp({ value: [[[[[[[[[[[[[[[[[[[[[[[[[1]]]]]]]]]]]]]]]]]]]]]]]]] })] })), "too_complex");
});

test("edit: hostile values never throw and are bounded", () => {
  const cyc: any = proposal(setOp());
  cyc.ops[0].self = cyc;
  err(parseProposal(cyc), "too_complex");
  let deep: any = 1;
  for (let i = 0; i < 100; i++) deep = [deep];
  err(parseProposal(proposal(setOp({ value: deep }))), "too_complex");
  err(parseProposal(proposal(...Array.from({ length: 3000 }, () => 1))), "too_complex");
  err(parseProposal({ baseHash: HASH, ops: [setOp({ value: 10n })] }), "invalid_proposal");
  const throwing = new Proxy({}, { ownKeys: () => { throw new Error(MARKER); } });
  err(parseProposal(throwing), "internal_error");
  const getter = { baseHash: HASH, get ops() { return [setOp()]; } };
  ok(parseProposal(getter));
  // A toJSON that answers with something else is judged on what it answered, after a second guard.
  err(parseProposal({ toJSON: () => { let d: any = 1; for (let i = 0; i < 100; i++) d = [d]; return d; } }), "too_complex");
});

test("edit: the parsed proposal shares no references with the input", () => {
  const input = proposal(setOp(), insertOp({ node: { type: "stack", children: [{ type: "text", content: "x" }] } }), moveOp());
  const p = ok(parseProposal(input));
  const before = JSON.stringify(p);
  input.ops[0].value = "changed";
  input.ops[1].node.children[0].content = "changed";
  input.ops[1].node.children.push({ type: "text", content: "more" });
  input.ops.push(removeOp());
  input.baseHash = "f".repeat(64);
  assert.equal(JSON.stringify(p), before);
  assert.notEqual(p.ops, input.ops);
  assert.notEqual(p.ops[1].node, input.ops[1].node);
  // and the other way round: mutating the result does not reach a second parse of the same input
  p.ops[1].node.children.length = 0;
  assert.equal(ok(parseProposal(input)).ops[1].node.children.length, 2);
});
