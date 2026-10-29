import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, Grid, Header, Sidebar, Stack, StatCard, Table, Text, uiSpecSchema, type UiSpec } from "../../server/src/spec/schema.js";
import { formatValue, get, inspect, TYPE_LABEL } from "../src/inspector/inspect.js";
import { Inspector } from "../src/inspector/Inspector.js";
import { checkRenderable } from "../src/render/guard.js";
import { allPaths, isPathSyntax, pathFromTarget, resolvePath, type SelectableType } from "../src/render/paths.js";
import { SpecView } from "../src/render/SpecView.js";
import { assertOnlySafeMarkup } from "./safe-markup.js";

const root = join(import.meta.dirname, "..", "..", "..", "..");
const example = (): any => JSON.parse(readFileSync(join(root, "docs", "examples", "expense-dashboard.json"), "utf8"));
const source = (rel: string): string => readFileSync(join(root, "preview", rel), "utf8");

const spec = (children: unknown[], patch: (o: any) => void = () => {}): any => {
  const o = { schemaVersion: 1, screen: { kind: "dashboard", name: "Test", purpose: "Selection test" }, theme: { mode: "light" }, layout: { main: { children } } };
  patch(o);
  return o;
};
const button = (label: string, extra: object = {}) => ({ type: "button", label, ...extra });
const textNode = (content: string, extra: object = {}) => ({ type: "text", content, ...extra });
const normalized = (v: unknown): UiSpec => {
  const r = checkRenderable(v);
  assert.ok(r.ok, JSON.stringify(r));
  return r.spec;
};
const view = (v: unknown, selected: string | null): string => renderToStaticMarkup(<SpecView value={v} selection={{ selected }} />);
const inspectorHtml = (s: UiSpec | null, selected: string | null): string => renderToStaticMarkup(<Inspector spec={s} selected={selected} onSelect={() => {}} />);
const stampedPaths = (out: string): string[] => [...out.matchAll(/data-pv-path="([^"]*)"/g)].map((m) => m[1]!);

/** One of everything: both slots, a header action, every component type, nested containers. */
const ALL = (): any =>
  spec(
    [
      { type: "stack", direction: "row", gap: "sm", align: "center", children: [textNode("Row text"), button("Row button", { variant: "primary" })] },
      { type: "grid", columns: 2, children: [{ type: "stat-card", label: "Spend", value: "$10", delta: { text: "+1%", trend: "up" }, hint: "monthly" }, { type: "stat-card", label: "Left", value: "$5" }] },
      textNode("Heading", { variant: "heading", tone: "accent" }),
      { type: "table", caption: "Recent", columns: [{ key: "a", header: "A" }, { key: "b", header: "B", align: "end" }], rows: [["1", "2"]] },
    ],
    (o) => {
      o.layout.header = { type: "header", title: "Title", subtitle: "Sub", actions: [button("Act", { note: "Does a thing" })] };
      o.layout.sidebar = { type: "sidebar", title: "Menu", width: "narrow", items: [{ label: "Home", icon: "home", active: true }, { label: "Other" }] };
    },
  );

/** Three levels of nesting, with siblings at each level. */
const NESTED = (): any => spec([{ type: "stack", children: [textNode("first"), { type: "grid", columns: 2, children: [{ type: "stack", direction: "row", children: [textNode("deep"), button("deepbtn")] }, textNode("sibling")] }, textNode("last")] }]);

const CLASS_OF: Record<SelectableType, RegExp> = {
  header: /class="pv-header"/, sidebar: /class="pv-sidebar /, main: /class="pv-main /, stack: /class="pv-stack /, grid: /class="pv-grid /,
  text: /class="pv-text /, button: /class="pv-button /, "stat-card": /class="pv-stat"/, table: /class="pv-table-wrap"/,
};

// ---- a tiny DOM built from the real rendered markup, so click resolution runs against the actual element tree ----------

type El = { tag: string; attrs: Map<string, string>; parent: El | null; children: El[]; text: string };
const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
function parse(out: string): El {
  const top: El = { tag: "#root", attrs: new Map(), parent: null, children: [], text: "" };
  let cur = top;
  const re = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s+[a-zA-Z][a-zA-Z0-9:-]*(?:="[^"]*")?)*)\s*(\/?)>|([^<]+)/g;
  for (const m of out.matchAll(re)) {
    if (m[5] !== undefined) cur.text += decode(m[5]);
    else if (m[1]) cur = cur.parent!;
    else {
      const el: El = { tag: m[2]!, attrs: new Map([...m[3]!.matchAll(/\s+([a-zA-Z][a-zA-Z0-9:-]*)(?:="([^"]*)")?/g)].map((a) => [a[1]!, decode(a[2] ?? "")])), parent: cur, children: [], text: "" };
      cur.children.push(el);
      if (!m[4]) cur = el;
    }
  }
  return top;
}
const asTarget = (el: El) => ({
  closest(sel: string) {
    const name = /^\[([a-z-]+)\]$/.exec(sel)![1]!;
    for (let e: El | null = el; e; e = e.parent) if (e.attrs.has(name)) return { getAttribute: (n: string) => e!.attrs.get(n) ?? null, el: e };
    return null;
  },
});
const containerOf = (rootEl: El) => ({ contains: (x: any) => { for (let e: El | null = x?.el ?? null; e; e = e.parent) if (e === rootEl) return true; return false; } });
const walk = (el: El, f: (e: El) => void): void => { f(el); el.children.forEach((c) => walk(c, f)); };

// ---- 1. every component type ----------------------------------------------------------------------------------------

test("every supported component type is selectable: each path resolves, is stamped once, and selecting it marks only that element", () => {
  const s = normalized(ALL());
  const paths = allPaths(s);
  assert.deepEqual(new Set(paths.map((p) => p.type)), new Set(Object.keys(TYPE_LABEL)), "the fixture covers every selectable type");
  const plain = view(ALL(), null);
  assert.deepEqual(stampedPaths(plain), paths.map((p) => p.path), "stamped paths, in document order, are exactly allPaths()");
  assert.ok(!plain.includes("data-pv-selected"));
  for (const p of paths) {
    const r = resolvePath(s, p.path);
    assert.ok(r && r.type === p.type, p.path);
    const out = view(ALL(), p.path);
    const marked = [...out.matchAll(/<[a-z0-9]+\s[^>]*data-pv-selected="true"[^>]*>/g)].map((m) => m[0]);
    assert.equal(marked.length, 1, `${p.path}: exactly one element is marked`);
    assert.ok(marked[0]!.includes(`data-pv-path="${p.path}"`), `${p.path}: the marked element is the selected path`);
    assert.match(marked[0]!, CLASS_OF[p.type], `${p.path}: the marked element renders a ${p.type}`);
    const m = inspect(s, p.path);
    assert.ok(m && m.type === p.type && m.typeLabel === TYPE_LABEL[p.type] && m.path === p.path);
  }
});

/** Text the renderer itself draws (trend marks, the default empty-table text); not authored in the spec. */
const RENDERER_TEXT = new Set(["▲", "▼", "▬", "No rows"]);

// ---- 2. nested selection ----------------------------------------------------------------------------------------------

test("nested selection: a click on any element resolves to the innermost component containing it, never an ancestor", () => {
  for (const raw of [NESTED(), ALL(), example()]) {
    const s = normalized(raw);
    const dom = parse(view(raw, null));
    const rootEl = dom.children[0]!;
    let checked = 0;
    walk(rootEl, (el) => {
      const p = pathFromTarget(asTarget(el), containerOf(rootEl));
      // the resolved path is the nearest stamped element at or above the click target; the app and body wrappers are not
      // components, so a click that lands only on them selects nothing (the app then clears the selection)
      let e: El | null = el;
      while (e && !e.attrs.has("data-pv-path")) e = e.parent;
      if (!e) {
        assert.equal(p, null, `<${el.tag} class="${el.attrs.get("class")}">`);
        return;
      }
      assert.equal(p, e.attrs.get("data-pv-path"));
      const r = resolvePath(s, p)!;
      assert.ok(r, `${p} resolves`);
      const t = el.text.trim();
      if (t && !RENDERER_TEXT.has(t)) {
        checked++;
        assert.ok(JSON.stringify(r.node).includes(JSON.stringify(t).slice(1, -1)), `"${t}" belongs to ${p}`);
        // and not to a child: if the resolved node is a container, none of its children hold the text
        const kids = r.type === "main" || r.type === "stack" || r.type === "grid" ? (r.node as any).children : r.type === "header" ? (r.node as any).actions : [];
        for (const k of kids) assert.ok(!JSON.stringify(k).includes(JSON.stringify(t).slice(1, -1)), `"${t}" was resolved to ${p}, an ancestor of the component that shows it`);
      }
    });
    assert.ok(checked > 3);
  }
  const s = normalized(NESTED());
  const deep = resolvePath(s, "main.0.1.0.1")!;
  assert.equal(deep.type, "button");
  assert.equal((deep.node as any).label, "deepbtn");
  assert.equal(deep.parent, "main.0.1.0");
  assert.equal((resolvePath(s, "main.0.1.1")!.node as any).content, "sibling");
  assert.equal(resolvePath(s, "main.0.1")!.type, "grid");
  // targets outside the frame, non-elements and forged path attributes select nothing
  const dom = parse(view(NESTED(), null));
  const outside: El = { tag: "div", attrs: new Map([["data-pv-path", "main.0"]]), parent: null, children: [], text: "" };
  assert.equal(pathFromTarget(asTarget(outside), containerOf(dom.children[0]!)), null);
  assert.equal(pathFromTarget(null, containerOf(dom)), null);
  assert.equal(pathFromTarget({}, containerOf(dom)), null);
  for (const forged of ["main.0.constructor", "__proto__", "main.01", "<b>", ""]) {
    const el: El = { tag: "div", attrs: new Map([["data-pv-path", forged]]), parent: dom, children: [], text: "" };
    assert.equal(pathFromTarget(asTarget(el), containerOf(dom)), null, forged);
  }
});

// ---- 3. determinism ---------------------------------------------------------------------------------------------------

test("structural paths are deterministic: repeated, reordered keys, JSON round trip, and independent of ids", () => {
  const e = example();
  const first = allPaths(normalized(e));
  const markup = view(e, "main.0.1");
  for (let i = 0; i < 3; i++) assert.deepEqual(allPaths(normalized(e)), first);
  const reorder = (v: any): any => (Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v);
  assert.deepEqual(allPaths(normalized(reorder(e))), first);
  assert.equal(view(reorder(e), "main.0.1"), markup);
  assert.deepEqual(allPaths(normalized(JSON.parse(JSON.stringify(e)))), first);
  assert.equal(view(JSON.parse(JSON.stringify(e)), "main.0.1"), markup);
  // giving every component an id (all the same) changes no path
  const withIds = JSON.parse(JSON.stringify(e));
  const tag = (n: any) => { if (n && typeof n === "object" && typeof n.type === "string") n.id = "same"; for (const v of Object.values(n ?? {})) if (v && typeof v === "object") tag(v); };
  tag(withIds.layout);
  assert.deepEqual(allPaths(normalized(withIds)), first);
  assert.deepEqual(stampedPaths(view(withIds, null)), first.map((p) => p.path));
  assert.equal(first.map((p) => p.path).join(" "), "header header.actions.0 sidebar main main.0 main.0.0 main.0.1 main.0.2 main.1 main.2");
});

// ---- 4. ids --------------------------------------------------------------------------------------------------------------

test("duplicate and missing optional ids do not affect selection", () => {
  const raw = spec([button("One", { id: "same" }), button("Two", { id: "same" }), textNode("No id"), { type: "stack", id: "same", children: [button("Three", { id: "same" }), button("Four")] }]);
  const s = normalized(raw);
  const out = view(raw, null);
  assert.equal((out.match(/data-node-id="same"/g) ?? []).length, 4);
  const paths = stampedPaths(out);
  assert.equal(new Set(paths).size, paths.length, "paths are unique even though ids are not");
  const labels = ["main.0", "main.1", "main.3.0", "main.3.1"].map((p) => (resolvePath(s, p)!.node as any).label);
  assert.deepEqual(labels, ["One", "Two", "Three", "Four"]);
  assert.equal(inspect(s, "main.1")!.idShared, 4);
  assert.equal(inspect(s, "main.3")!.idShared, 4);
  const noId = inspect(s, "main.2")!;
  assert.equal(noId.idShared, 0);
  assert.equal(noId.sections.find((x) => x.title === "Identity")!.rows[0]!.value, null);
  assert.match(inspectorHtml(s, "main.1"), /4 components share this id/);
  assert.match(inspectorHtml(s, "main.2"), /not set/);
  // selecting one of the duplicates marks only that one
  const sel = view(raw, "main.1");
  assert.equal((sel.match(/data-pv-selected/g) ?? []).length, 1);
  assert.match(sel, /data-node-id="same" data-pv-path="main.1" data-pv-selected="true">Two</);
});

test("only canonical paths to existing nodes resolve", () => {
  const s = normalized(spec([textNode("leaf"), { type: "stack", children: [button("b")] }]));
  for (const ok of ["main", "main.0", "main.1", "main.1.0"]) assert.ok(resolvePath(s, ok), ok);
  const bad: unknown[] = ["", "main.", ".main", "main..0", "main.01", "main.-1", "main.+1", "main.1e0", "main.0x0", "main. 0", " main", "main.0 ", "main.2", "main.0.0", "main.1.1", "MAIN", "header", "header.actions.0", "header.actions", "sidebar", "sidebar.0", "sidebar.items.0",
    "__proto__", "main.__proto__", "main.constructor", "main.length", "toString", "main.1.children", "main.100", `main${".0".repeat(40)}`, 0, null, undefined, {}, ["main"], { toString: () => "main" }];
  for (const b of bad) assert.equal(resolvePath(s, b), null, String(JSON.stringify(b)));
  assert.equal(inspect(s, "main.9"), null);
  assert.equal(inspect(s, null), null);
  const h = normalized(spec([], (o) => (o.layout.header = { type: "header", title: "T", actions: [] })));
  assert.ok(resolvePath(h, "header"));
  assert.equal(resolvePath(h, "header.actions.0"), null);
});

// ---- 5, 6. inspector updates and clears -------------------------------------------------------------------------------

test("changing the selection updates the inspector, and clearing it empties the panel", () => {
  const s = normalized(spec([button("Alpha", { note: "first" }), textNode("Beta body", { tone: "muted" })]));
  const selectionPart = (out: string) => out.slice(out.indexOf("insp-selection"), out.indexOf("insp-outline"));
  const a = selectionPart(inspectorHtml(s, "main.0"));
  assert.match(a, /<strong>Button<\/strong>/);
  assert.match(a, /<code class="insp-path">main.0<\/code>/);
  assert.match(a, />Alpha</);
  assert.match(a, />first</);
  assert.ok(!a.includes("Beta body"));
  const b = selectionPart(inspectorHtml(s, "main.1"));
  assert.match(b, /<strong>Text<\/strong>/);
  assert.match(b, /<code class="insp-path">main.1<\/code>/);
  assert.match(b, />Beta body</);
  assert.match(b, />muted</);
  assert.ok(!b.includes("Alpha"));
  for (const none of [null, "main.7", "nonsense"]) {
    const out = inspectorHtml(s, none);
    assert.match(selectionPart(out), /Click a component in the preview/);
    assert.ok(!out.includes("<dl") && !out.includes("insp-path") && !out.includes('aria-current="true"'), String(none));
  }
  // the outline marks exactly the selected node, and offers every node
  const out = inspectorHtml(s, "main.1");
  assert.equal((out.match(/aria-current="true"/g) ?? []).length, 1);
  assert.equal((out.slice(out.indexOf("insp-outline")).match(/<button/g) ?? []).length, allPaths(s).length);
  // a parent link exists for nested nodes and is disabled at the top
  const n = normalized(NESTED());
  assert.equal(inspect(n, "main.0.1.0.1")!.parent, "main.0.1.0");
  assert.equal(inspect(n, "main")!.parent, null);
  assert.match(inspectorHtml(n, "main"), /<button type="button" class="shell-btn" disabled="">Select parent/);
  assert.match(inspectorHtml(null, null), /No design is loaded/);
});

// ---- 7. inspector content matches the validated spec --------------------------------------------------------------------

const SHAPES: Record<SelectableType, string[]> = {
  header: Object.keys(Header.shape), sidebar: Object.keys(Sidebar.shape), button: Object.keys(Button.shape), text: Object.keys(Text.shape), "stat-card": Object.keys(StatCard.shape),
  table: Object.keys(Table.shape), stack: Object.keys(Stack.shape), grid: Object.keys(Grid.shape), main: Object.keys(uiSpecSchema.shape.layout.shape.main.shape),
};

test("inspector rows are exactly the schema properties of the validated node, with the validated values", () => {
  for (const raw of [ALL(), example(), NESTED()]) {
    const s = normalized(raw);
    for (const { path, type } of allPaths(s)) {
      const node = resolvePath(s, path)!.node as any;
      const m = inspect(s, path)!;
      const rows = m.sections.flatMap((x) => x.rows);
      assert.equal(new Set(rows.map((r) => r.key)).size, rows.length, `${path}: no duplicate rows`);
      for (const r of rows) {
        assert.ok(SHAPES[type].includes(r.key.split(".")[0]!), `${path}: row ${r.key} is not a ${type} schema property`);
        if (r.key === "rows") assert.equal(r.value, String(node.rows.length));
        else assert.equal(r.value, formatValue(get(node, r.key)), `${path}: ${r.key}`);
        if (r.value === null) assert.equal(get(node, r.key), undefined, `${path}: ${r.key} shown as unset but has a value`);
      }
      // every scalar the node holds is shown (children and header actions are listed as child components instead)
      const leaves: string[] = [];
      const collect = (v: any, k: string) => (v && typeof v === "object" ? Object.entries(v).forEach(([kk, vv]) => collect(vv, k ? `${k}.${kk}` : kk)) : leaves.push(k));
      for (const [k, v] of Object.entries(node)) if (!["type", "children", "actions", "rows"].includes(k)) collect(v, k);
      for (const l of leaves) assert.ok(rows.some((r) => r.key === l), `${path}: ${l} is in the spec but not in the inspector`);
      if (Array.isArray(node.children)) assert.deepEqual(m.children!.map((c) => c.path), node.children.map((_: unknown, i: number) => `${path}.${i}`));
      if (type === "header") assert.deepEqual(m.children!.map((c) => c.path), node.actions.map((_: unknown, i: number) => `header.actions.${i}`));
    }
  }
  // defaults filled by validation are what the inspector shows, because they are what renders
  const d = normalized(spec([button("x"), textNode("y")]));
  assert.equal(inspect(d, "main.0")!.sections.find((x) => x.title === "Style")!.rows[0]!.value, "secondary");
  assert.deepEqual(inspect(d, "main.1")!.sections.find((x) => x.title === "Style")!.rows.map((r) => r.value), ["body", "default"]);
});

// ---- 8. no mutation ----------------------------------------------------------------------------------------------------

test("selection never mutates the design, and the selection code has no way to send or store anything", () => {
  const freeze = (v: any): any => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  for (const make of [ALL, example, NESTED]) {
    const raw = freeze(make());
    const before = JSON.stringify(raw);
    const s = freeze(normalized(raw));
    const sBefore = JSON.stringify(s);
    for (const { path } of allPaths(s)) {
      resolvePath(s, path);
      inspect(s, path);
      view(raw, path);
      inspectorHtml(s, path);
    }
    assert.equal(JSON.stringify(raw), before);
    assert.equal(JSON.stringify(s), sBefore);
  }
  // the hash the server computed is over the normalized spec; the renderer output for it is unchanged by selecting
  const e = example();
  assert.equal(view(e, null).replace(/ data-pv-selected="true"/g, ""), view(e, "main.0.1").replace(/ data-pv-selected="true"/g, ""));
  for (const f of ["src/render/paths.ts", "src/render/registry.tsx", "src/render/SpecView.tsx", "src/inspector/inspect.ts", "src/inspector/Inspector.tsx"]) {
    const t = source(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""); // code only, not comments
    assert.ok(!/\bfetch\b|XMLHttpRequest|WebSocket|EventSource|sendBeacon|localStorage|sessionStorage|indexedDB|document\.cookie|postMessage|api\.js/.test(t), `${f} must not talk to the network or storage`);
    assert.ok(!/dangerouslySetInnerHTML|innerHTML|style=\{|href|src=/.test(t), `${f} must not render raw HTML, URLs or inline styles`);
  }
  const api = source("src/api.ts");
  assert.equal((api.match(/\bfetch\(/g) ?? []).length, 1, "the app still makes one request");
  assert.match(api, /fetch\("\/api\/design", \{ headers: \{ "X-Prevue-Token": token \}, cache: "no-store", credentials: "omit", signal \}\)/);
  assert.ok(!/method\s*:/.test(api), "it is still a GET");
  const app = source("src/App.tsx");
  assert.ok(!/\bfetch\(|localStorage|sessionStorage/.test(app), "App.tsx only reaches the server through api.ts");
});

// ---- 9. invalid specs ---------------------------------------------------------------------------------------------------

test("invalid specifications are still rejected when selection is enabled, and render nothing selectable", () => {
  const bads: unknown[] = [null, {}, spec([{ type: "script" }]), spec([button("x", { href: "https://evil.example" })]), spec([textNode("x", { onClick: "alert(1)" })]), spec([{ type: "grid", columns: 9, children: [] }]), spec([textNode("‮evil")])];
  for (const b of bads) {
    for (const sel of [null, "main", "main.0"]) {
      const out = view(b, sel);
      assert.match(out, /role="alert"/);
      assert.ok(!out.includes("pv-app") && !out.includes("data-pv-path") && !out.includes("data-pv-selected"), JSON.stringify(b)?.slice(0, 80));
    }
  }
});

// ---- 10. security -----------------------------------------------------------------------------------------------------

const HOSTILE = [`<img src=x onerror=alert(1)>`, `"><script>alert(1)</script>`, `' onmouseover='alert(1)`, `javascript:alert(1)`, `main.0" data-pv-selected="true`];
const INSPECTOR_ATTRS = /^(class|type|disabled|data-key|aria-[a-z-]+)$/;
const INSPECTOR_ELEMENTS = new Set(["aside", "div", "h2", "h3", "span", "section", "p", "strong", "code", "button", "dl", "dt", "dd", "ul", "li", "nav"]);

test("selectable output keeps the renderer's protections: allow-listed markup, generated paths only, escaped text in the inspector", () => {
  const plain = renderToStaticMarkup(<SpecView value={example()} />);
  assert.ok(!/data-pv-|data-selectable/.test(plain), "without a selection the markup is the plain Phase 2a preview");
  for (const full of HOSTILE) {
    const h = full.slice(0, 40);
    const raw = spec([textNode(h, { id: "same" }), button(h, { note: h }), { type: "stat-card", label: h, value: h, delta: { text: h.slice(0, 20), trend: "up" } }, { type: "stack", children: [{ type: "table", caption: h, columns: [{ key: "a", header: h.slice(0, 30) }], rows: [[h]] }] }], (x) => {
      x.layout.header = { type: "header", title: h, actions: [button(h)] };
      x.layout.sidebar = { type: "sidebar", title: h, items: [{ label: h.slice(0, 30) }] };
    });
    const s = normalized(raw);
    for (const { path } of allPaths(s)) {
      const out = view(raw, path);
      assertOnlySafeMarkup(out, `${h} @ ${path}`);
      for (const p of stampedPaths(out)) assert.ok(isPathSyntax(p), p);
      assert.deepEqual([...out.matchAll(/data-pv-selected="([^"]*)"/g)].map((m) => m[1]), ["true"]);
      const ins = inspectorHtml(s, path);
      assertOnlySafeMarkup(ins, `inspector ${h} @ ${path}`, INSPECTOR_ELEMENTS, INSPECTOR_ATTRS); // no on*, style, href, src
    }
    const ins = inspectorHtml(s, "main.1");
    assert.ok(ins.includes(h.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")), `inspector shows the text escaped: ${h}`);
  }
});
