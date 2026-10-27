import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { evaluate } from "../src/gate.js";
import { LIMITS } from "../src/spec/schema.js";
import { parseSpecText, specHash, validateSpec, type SpecResult } from "../src/spec/validate.js";
import { hashDesign, load, paths, registerDesign } from "../src/state.js";
import { env, sandbox } from "./helpers.js";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const example = (): any => JSON.parse(exampleText);

/** Regression pin for the canonical form of docs/examples/expense-dashboard.json. Changing it means every approved hash changes. */
const EXAMPLE_HASH = "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5"; // cross-checked with an independent sorted-key SHA-256

const codes = (r: SpecResult): string[] => (r.ok ? [] : r.issues.map((i) => `${i.code}@${i.path}`));
const fail = (v: unknown, kind: "parse_error" | "schema_error" = "schema_error"): Extract<SpecResult, { ok: false }> => {
  const r = validateSpec(v);
  assert.equal(r.ok, false, JSON.stringify(v).slice(0, 120));
  assert.equal((r as any).kind, kind);
  return r as any;
};
const withMain = (children: unknown[]) => {
  const s = example();
  s.layout.main.children = children;
  return s;
};
/** Same data with every object's keys in reverse order (the JSON.stringify replacer-array form would drop nested keys). */
const reverseKeys = (v: any): any =>
  Array.isArray(v) ? v.map(reverseKeys) : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reverseKeys(x)])) : v;
const nest = (depth: number): any => {
  let n: any = { type: "text", content: "leaf" };
  for (let i = 0; i < depth; i++) n = { type: "stack", children: [n] };
  return n;
};

test("the documented example validates and its hash is pinned", () => {
  const r = parseSpecText(exampleText);
  assert.equal(r.ok, true, JSON.stringify(r));
  if (!r.ok) return;
  assert.equal(r.hash, specHash(r.spec));
  assert.equal(r.hash, EXAMPLE_HASH);
  assert.deepEqual(r.stats, { nodes: 9, depth: 1 });
});

test("hash is stable under key order, whitespace, explicit defaults and Unicode normalization", () => {
  const base = validateSpec(example());
  assert.equal(base.ok, true);
  const h = (base as any).hash;
  const reordered = reverseKeys(example());
  assert.equal((validateSpec(reordered) as any).hash, h);
  assert.equal((parseSpecText(JSON.stringify(example(), null, 8)) as any).hash, h);
  const explicit = example();
  explicit.layout.main.gap = "md"; // already the default
  explicit.layout.sidebar.width = "normal"; // already the default
  explicit.layout.header.actions[0].variant = "primary";
  assert.equal((validateSpec(explicit) as any).hash, h);
  const decomposed = example();
  decomposed.screen.name = "Café"; // e + combining acute
  const composed = example();
  composed.screen.name = "Café";
  assert.equal((validateSpec(decomposed) as any).hash, (validateSpec(composed) as any).hash);
  const padded = example();
  padded.screen.name = "  Expense dashboard  ";
  assert.equal((validateSpec(padded) as any).hash, h);
});

test("any content change changes the hash", () => {
  const h = (validateSpec(example()) as any).hash;
  const edits: Array<(s: any) => void> = [
    (s) => (s.screen.name = "Other"),
    (s) => (s.theme.mode = "dark"),
    (s) => (s.theme.accent = "green"),
    (s) => (s.layout.main.gap = "lg"),
    (s) => s.layout.main.children.pop(),
    (s) => (s.layout.main.children[2].rows[0][1] = "Changed"),
    (s) => s.layout.main.children[0].children.reverse(), // array order is content
    (s) => delete s.layout.sidebar,
  ];
  const seen = new Set([h]);
  for (const e of edits) {
    const s = example();
    e(s);
    const r = validateSpec(s);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.ok(!seen.has((r as any).hash), "hash collided with an earlier variant");
    seen.add((r as any).hash);
  }
});

test("parse errors: malformed JSON is reported as parse_error, never as a schema error", () => {
  for (const t of ["", "   ", "{", '{"a":', '{"a":1,}', "[1,2,]", "{'a':1}", "NaN", "undefined", "﻿{}", '{"a":1} x']) {
    const r = parseSpecText(t);
    assert.equal(r.ok, false, JSON.stringify(t));
    assert.equal((r as any).kind, "parse_error", JSON.stringify(t));
    assert.equal((r as any).issues[0].code, "invalid_json", JSON.stringify(t));
  }
  assert.equal((parseSpecText("x".repeat(LIMITS.rawBytes + 1)) as any).issues[0].code, "too_large");
  assert.equal((parseSpecText(undefined as any) as any).kind, "parse_error");
});

test("valid JSON that is not a specification is a schema_error", () => {
  for (const v of [null, 5, "x", true, [], [example()], {}]) assert.equal(fail(v).kind, "schema_error");
});

test("schema versions: missing and unsupported versions are named precisely", () => {
  const s = example();
  delete s.schemaVersion;
  assert.deepEqual(codes(fail(s)), ["missing_field@/schemaVersion"]);
  for (const v of [0, 2, 1.5, "1", null, true, [1], -1, 2 ** 53]) {
    const t = example();
    t.schemaVersion = v;
    assert.deepEqual(codes(fail(t)), ["unsupported_version@/schemaVersion"], String(v));
  }
});

test("missing required fields are reported with their JSON pointer", () => {
  const cases: Array<[(s: any) => void, string]> = [
    [(s) => delete s.screen, "/screen"],
    [(s) => delete s.screen.name, "/screen/name"],
    [(s) => delete s.screen.purpose, "/screen/purpose"],
    [(s) => delete s.theme, "/theme"],
    [(s) => delete s.theme.mode, "/theme/mode"],
    [(s) => delete s.layout, "/layout"],
    [(s) => delete s.layout.main, "/layout/main"],
    [(s) => delete s.layout.main.children, "/layout/main/children"],
    [(s) => delete s.layout.main.children[1].content, "/layout/main/children/1/content"],
    [(s) => delete s.layout.main.children[2].columns, "/layout/main/children/2/columns"],
  ];
  for (const [mut, path] of cases) {
    const s = example();
    mut(s);
    const r = fail(s);
    assert.ok(r.issues.some((i) => i.path === path), `${path}: ${JSON.stringify(r.issues)}`);
  }
  const s = example();
  delete s.screen.name;
  assert.equal(fail(s).issues[0]?.code, "missing_field");
});

test("unknown component types are rejected, including slots that are not nestable", () => {
  for (const type of ["script", "iframe", "html", "image", "Text", "", "stat_card"]) {
    const r = fail(withMain([{ type, content: "x" }]));
    assert.deepEqual(codes(r), ["unknown_component@/layout/main/children/0/type"], type);
  }
  assert.ok(codes(fail(withMain([{ type: "header", title: "x" }]))).includes("unknown_component@/layout/main/children/0/type"));
  assert.ok(codes(fail(withMain([{ type: "sidebar", items: [{ label: "x" }] }]))).includes("unknown_component@/layout/main/children/0/type"));
  assert.ok(fail(withMain([{ content: "no type" }])).issues.length > 0);
  assert.ok(fail(withMain(["string", 5, null, []])).issues.length > 0);
});

test("unknown properties are rejected everywhere: nothing executable, styled or linkable can ride along", () => {
  const extras: Array<[string, unknown]> = [
    ["onclick", "alert(1)"], ["onClick", "x"], ["style", "color:red"], ["className", "x"], ["class", "x"], ["href", "https://example.com"],
    ["src", "file:///etc/passwd"], ["url", "https://example.com"], ["path", "/etc/passwd"], ["html", "<b>x</b>"], ["dangerouslySetInnerHTML", { __html: "x" }],
    ["script", "x"], ["__proto__", { polluted: true }], ["constructor", {}],
  ];
  for (const [k, v] of extras) {
    const targets: Array<(s: any) => any> = [
      (s) => s, (s) => s.screen, (s) => s.theme, (s) => s.layout, (s) => s.layout.main, (s) => s.layout.header, (s) => s.layout.header.actions[0], (s) => s.layout.sidebar,
      (s) => s.layout.sidebar.items[0], (s) => s.layout.main.children[0], (s) => s.layout.main.children[0].children[0], (s) => s.layout.main.children[0].children[0].delta ?? s.layout.main.children[0].children[0],
      (s) => s.layout.main.children[1], (s) => s.layout.main.children[2], (s) => s.layout.main.children[2].columns[0],
    ];
    for (const t of targets) {
      const raw = exampleText;
      const s = JSON.parse(raw);
      Object.defineProperty(t(s), k, { value: v, enumerable: true, configurable: true, writable: true }); // defineProperty keeps "__proto__" as an own key
      const r = fail(JSON.parse(JSON.stringify(s)));
      assert.ok(r.issues.some((i) => i.code === "unknown_key" && i.path.endsWith(`/${k}`)), `${k}: ${JSON.stringify(r.issues)}`);
    }
  }
  const polluted = JSON.parse('{"schemaVersion":1,"__proto__":{"isAdmin":true}}');
  assert.ok(Object.hasOwn(polluted, "__proto__"));
  assert.equal(fail(polluted).issues.some((i) => i.code === "unknown_key"), true);
  assert.equal(({} as any).isAdmin, undefined);
});

test("invalid property values and invalid theme values are rejected", () => {
  const bad: Array<[(s: any) => void, string]> = [
    [(s) => (s.theme.mode = "sepia"), "/theme/mode"],
    [(s) => (s.theme.mode = "DARK"), "/theme/mode"],
    [(s) => (s.theme.mode = 1), "/theme/mode"],
    [(s) => (s.theme.accent = "#ff0000"), "/theme/accent"],
    [(s) => (s.theme.accent = "rgb(1,2,3)"), "/theme/accent"],
    [(s) => (s.theme = "dark"), "/theme"],
    [(s) => (s.screen.kind = "page"), "/screen/kind"],
    [(s) => (s.layout.main.gap = "12px"), "/layout/main/gap"],
    [(s) => (s.layout.main.padding = -1), "/layout/main/padding"],
    [(s) => (s.layout.main.children[0].columns = 0), "/layout/main/children/0/columns"],
    [(s) => (s.layout.main.children[0].columns = 5), "/layout/main/children/0/columns"],
    [(s) => (s.layout.main.children[0].columns = 2.5), "/layout/main/children/0/columns"],
    [(s) => (s.layout.main.children[0].columns = "3"), "/layout/main/children/0/columns"],
    [(s) => (s.layout.main.children[1].variant = "h1"), "/layout/main/children/1/variant"],
    [(s) => (s.layout.main.children[1].tone = "red"), "/layout/main/children/1/tone"],
    [(s) => (s.layout.main.children[1].content = 5), "/layout/main/children/1/content"],
    [(s) => (s.layout.main.children[1].content = ""), "/layout/main/children/1/content"],
    [(s) => (s.layout.main.children[1].content = "   "), "/layout/main/children/1/content"],
    [(s) => (s.layout.main.children[1].content = "x".repeat(501)), "/layout/main/children/1/content"],
    [(s) => (s.layout.header.actions[0].variant = "link"), "/layout/header/actions/0/variant"],
    [(s) => (s.layout.sidebar.items[0].icon = "../../etc/passwd"), "/layout/sidebar/items/0/icon"],
    [(s) => (s.layout.sidebar.items[0].icon = "https://x/y.svg"), "/layout/sidebar/items/0/icon"],
    [(s) => (s.layout.sidebar.items[0].active = "yes"), "/layout/sidebar/items/0/active"],
    [(s) => (s.layout.main.children[0].children[0].delta.trend = "sideways"), "/layout/main/children/0/children/0/delta/trend"],
    [(s) => (s.layout.main.children[2].columns[2].align = "right"), "/layout/main/children/2/columns/2/align"],
    [(s) => (s.layout.main.children[0].id = "Has Space"), "/layout/main/children/0/id"],
    [(s) => (s.layout.main.children[0].id = "1abc"), "/layout/main/children/0/id"],
    [(s) => (s.layout.main.children[0].id = "x".repeat(33)), "/layout/main/children/0/id"],
  ];
  for (const [mut, path] of bad) {
    const s = example();
    mut(s);
    const r = fail(s);
    assert.ok(r.issues.some((i) => i.path === path), `${path}: ${JSON.stringify(r.issues)}`);
  }
});

test("text is plain: control characters, bidi overrides and lone surrogates are rejected; markup characters are just text", () => {
  for (const c of ["\u0000", "\n", "\t", "\u001b", "\u007f", "\u0085", "‮", "‪", "⁦", "⁩", "\ud800", "\udfff"]) {
    const s = example();
    s.screen.name = `Name${c}x`;
    assert.ok(fail(s).issues.some((i) => i.path === "/screen/name"), JSON.stringify(c));
  }
  const s = example();
  s.screen.name = '<script>alert("x")</script> & "quotes" \u{1F600} 你好';
  const r = validateSpec(s);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal((r as any).spec.screen.name, s.screen.name); // stored verbatim: the renderer must escape it (textContent)
});

test("tables: row width, column keys and size limits", () => {
  const table = (columns: string[], rows: string[][]) => ({ type: "table", columns: columns.map((k) => ({ key: k, header: k })), rows });
  assert.equal(validateSpec(withMain([table(["a", "b"], [["1", "2"], ["", ""]])])).ok, true); // empty cells are fine
  assert.deepEqual(codes(fail(withMain([table(["a", "b"], [["1"]])]))), ["invalid_value@/layout/main/children/0/rows/0"]);
  assert.deepEqual(codes(fail(withMain([table(["a", "b"], [["1", "2", "3"]])]))), ["invalid_value@/layout/main/children/0/rows/0"]);
  assert.deepEqual(codes(fail(withMain([table(["a", "a"], [])]))), ["invalid_value@/layout/main/children/0/columns/1/key"]);
  assert.ok(fail(withMain([table([], [])])).issues.length > 0);
  const keys = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
  assert.equal(validateSpec(withMain([table(keys(LIMITS.tableColumns), [])])).ok, true);
  assert.equal(fail(withMain([table(keys(LIMITS.tableColumns + 1), [])])).issues[0]?.code, "limit_exceeded");
  const rows = (n: number) => Array.from({ length: n }, () => ["x"]);
  assert.equal(validateSpec(withMain([table(["a"], rows(LIMITS.tableRows))])).ok, true);
  assert.equal(fail(withMain([table(["a"], rows(LIMITS.tableRows + 1))])).issues[0]?.code, "limit_exceeded");
});

test("limits are exact: the maximum is accepted and one more is rejected", () => {
  const leaf = (i: number) => ({ type: "text", content: `t${i}` });
  // children per container
  assert.equal(validateSpec(withMain(Array.from({ length: LIMITS.children }, (_, i) => leaf(i)))).ok, true);
  assert.equal(fail(withMain(Array.from({ length: LIMITS.children + 1 }, (_, i) => leaf(i)))).issues[0]?.code, "limit_exceeded");
  // header actions and sidebar items
  const s1 = example();
  s1.layout.header.actions = Array.from({ length: LIMITS.headerActions }, (_, i) => ({ type: "button", label: `b${i}` }));
  assert.equal(validateSpec(s1).ok, true);
  s1.layout.header.actions.push({ type: "button", label: "one more" });
  assert.equal(fail(s1).issues[0]?.code, "limit_exceeded");
  const s2 = example();
  s2.layout.sidebar.items = Array.from({ length: LIMITS.sidebarItems }, (_, i) => ({ label: `i${i}` }));
  assert.equal(validateSpec(s2).ok, true);
  s2.layout.sidebar.items.push({ label: "one more" });
  assert.equal(fail(s2).issues[0]?.code, "limit_exceeded");
  s2.layout.sidebar.items = [];
  assert.ok(fail(s2).issues.length > 0);
  // container nesting
  const ok = validateSpec(withMain([nest(LIMITS.nesting)]));
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal((ok as any).stats.depth, LIMITS.nesting);
  const deep = fail(withMain([nest(LIMITS.nesting + 1)]));
  assert.equal(deep.issues[0]?.code, "limit_exceeded");
  assert.match(deep.issues[0]!.message, /nested deeper/);
  // total component count: 12 grids x (1 + 4 leaves) = 60 in main, plus header (1) + its button (1) + sidebar (1) from the example slots
  const block = () => ({ type: "grid", columns: 2, children: [leaf(0), leaf(1), leaf(2), leaf(3)] });
  const withBlocks = (n: number) => {
    const s = withMain(Array.from({ length: n }, block));
    s.layout.header = undefined;
    s.layout.sidebar = undefined;
    return s;
  };
  const sixty = validateSpec(withBlocks(12));
  assert.equal(sixty.ok, true, JSON.stringify(sixty));
  assert.equal((sixty as any).stats.nodes, 60);
  const sixtyOne = withBlocks(12);
  sixtyOne.layout.sidebar = { type: "sidebar", items: [{ label: "x" }] };
  const over = fail(sixtyOne);
  assert.deepEqual(codes(over), ["limit_exceeded@"]);
  assert.match(over.issues[0]!.message, /61 components/);
});

test("ids must be unique across the whole specification", () => {
  const s = example();
  s.layout.header.id = "top";
  s.layout.main.children[1].id = "top";
  assert.deepEqual(codes(fail(s)), ["duplicate_id@/layout/main/children/1/id"]);
  const t = example();
  t.layout.main.children[0].id = "a";
  t.layout.main.children[0].children[0].id = "b";
  t.layout.main.children[0].children[1].id = "c";
  assert.equal(validateSpec(t).ok, true);
});

test("hostile nesting is rejected without throwing or overflowing the stack", () => {
  const n = 30_000; // 60 KB: under the byte limit, far over any sane depth
  const deepArrays = "[".repeat(n) + "]".repeat(n);
  const a = parseSpecText(deepArrays);
  assert.equal(a.ok, false);
  assert.equal((a as any).kind, "parse_error");
  assert.ok(["too_complex", "invalid_json"].includes((a as any).issues[0].code));
  let o: any = { type: "text", content: "x" };
  for (let i = 0; i < 3000; i++) o = { type: "stack", children: [o] };
  const r = validateSpec(withMain([o]));
  assert.equal(r.ok, false);
  assert.equal((r as any).issues[0].code, "too_complex");
  const wide = JSON.stringify({ schemaVersion: 1, extra: Array.from({ length: LIMITS.rawJsonValues + 5 }, () => 0) });
  assert.equal((parseSpecText(wide) as any).issues[0].code, "too_complex");
  // The depth guard on its own (few values, so the value-count guard cannot be what rejects it).
  const arrays = (d: number): unknown => (d === 0 ? 0 : [arrays(d - 1)]);
  assert.equal((validateSpec(arrays(LIMITS.rawJsonDepth + 1)) as any).issues[0].code, "too_complex");
  assert.equal((validateSpec(arrays(LIMITS.rawJsonDepth - 2)) as any).issues[0].code, "invalid_type"); // within the guard: an ordinary schema error
  // A real tree at the nesting limit is far below the raw JSON depth limit.
  assert.equal(validateSpec(withMain([nest(LIMITS.nesting)])).ok, true);
});

test("validation never throws, whatever it is given", () => {
  const weird: unknown[] = [undefined, null, NaN, Infinity, 0, -0, 1n, Symbol("s"), () => 1, new Date(), new Map(), /x/, [], {}, [[[]]], Object.create(null), new Proxy({}, {}), "\u0000", "x".repeat(1e6)];
  const circular: any = { schemaVersion: 1 };
  circular.self = circular;
  weird.push(circular);
  const throwing = new Proxy({}, { get() { throw new Error("boom"); }, ownKeys() { throw new Error("boom"); }, getPrototypeOf() { throw new Error("boom"); } });
  weird.push(throwing);
  for (const v of weird) {
    let r: SpecResult | undefined;
    assert.doesNotThrow(() => { r = validateSpec(v); }, String(typeof v));
    assert.equal(r!.ok, false);
    assert.doesNotThrow(() => { r = parseSpecText(v as any); });
    assert.equal(r!.ok, false);
  }
});

test("issue messages stay bounded and do not echo large input", () => {
  const s = example();
  s.screen.name = "x".repeat(10_000);
  s.layout.main.children[0].zzz = "y".repeat(10_000);
  const r = fail(s);
  for (const i of r.issues) {
    assert.ok(i.message.length <= 200, i.message.length.toString());
    assert.ok(i.path.length <= 200);
    assert.ok(!i.message.includes("xxxxxxxxxx") && !i.message.includes("yyyyyyyyyy"));
  }
  const key = "k".repeat(5000);
  const t = example();
  t[key] = 1;
  assert.ok(fail(t).issues.every((i) => i.path.length <= 200));
});

test("a validated specification is only data: registering it leaves the gate PENDING and implementation denied", () => {
  const s = sandbox();
  const r = validateSpec(example());
  assert.equal(r.ok, true);
  if (!r.ok) return;
  const before = load(s.data, s.project);
  assert.equal(before.status, "INVALID"); // validation alone created no state
  const reg = registerDesign(s.data, s.project, r.spec);
  assert.equal(reg.state.revision, 1);
  assert.equal(reg.state.designHash, r.hash);
  assert.equal(reg.state.approvedRevision, null);
  assert.equal(load(s.data, s.project).status, "PENDING");
  assert.equal(evaluate(env(s), "Write", { file_path: join(s.project, "App.tsx"), content: "x" }).decision, "deny");
  assert.equal(evaluate(env(s), "Edit", { file_path: join(s.project, "App.tsx") }).decision, "deny");
});

test("registration semantics are preserved for real specifications: no-op for equivalents, A -> B -> A is revision 3", () => {
  const s = sandbox();
  const A = (validateSpec(example()) as any).spec;
  const b = example();
  b.theme.mode = "dark";
  const B = (validateSpec(b) as any).spec;
  assert.equal(registerDesign(s.data, s.project, A).state.revision, 1);
  const equivalent = (validateSpec(reverseKeys(example())) as any).spec;
  const again = registerDesign(s.data, s.project, equivalent);
  assert.equal(again.changed, false);
  assert.equal(again.state.revision, 1);
  assert.equal(registerDesign(s.data, s.project, B).state.revision, 2);
  const back = registerDesign(s.data, s.project, A);
  assert.equal(back.state.revision, 3);
  assert.equal(load(s.data, s.project).status, "PENDING");
});

test("validation does not read or write the data directory", () => {
  const s = sandbox();
  validateSpec(example());
  parseSpecText(exampleText);
  parseSpecText("{");
  assert.deepEqual(readdirSync(s.data), []);
  assert.throws(() => readdirSync(paths(s.data, s.project).dir), /ENOENT/);
});

test("the spec modules import only zod, the pure hash function and each other (no gate, hook, approve or filesystem access)", () => {
  const dir = join(import.meta.dirname, "..", "src", "spec");
  const files = readdirSync(dir).filter((f) => f.endsWith(".js"));
  assert.deepEqual(files.sort(), ["schema.js", "validate.js"]);
  for (const f of files) {
    const src = readFileSync(join(dir, f), "utf8");
    const specs = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    for (const spec of specs) assert.ok(["zod", "../state.js", "./schema.js"].includes(spec), `${f} imports ${spec}`);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/state\.js["']/g)) assert.equal(m[1]!.trim(), "hashDesign");
    assert.ok(!/\b(approve|initIfMissing|registerDesign|reset|load)\b\s*\(/.test(src), `${f} calls state-changing or state-reading code`);
    assert.ok(!/node:fs|node:child_process|process\.env|fetch\(|http/.test(src), `${f} touches the filesystem, environment or network`);
  }
});

test("hashDesign is unchanged for arbitrary Phase 0 designs (the experiment harness still registers them)", () => {
  assert.equal(hashDesign({ screen: "expense dashboard", layout: "sidebar+cards", version: "A" }).slice(0, 12), "3c5279481529");
});
