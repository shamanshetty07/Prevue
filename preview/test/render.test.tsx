import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LIMITS } from "../../server/src/spec/schema.js";
import { checkRenderable } from "../src/render/guard.js";
import { registry, renderNode } from "../src/render/registry.js";
import { SpecView } from "../src/render/SpecView.js";
import { assertOnlySafeMarkup } from "./safe-markup.js";

const examplePath = join(import.meta.dirname, "..", "..", "..", "..", "docs", "examples", "expense-dashboard.json");
const example = (): any => JSON.parse(readFileSync(examplePath, "utf8"));
const html = (v: unknown): string => renderToStaticMarkup(<SpecView value={v} />);

/** A valid minimal specification around the given main children. */
const spec = (children: unknown[], patch: (o: any) => void = () => {}): any => {
  const o = { schemaVersion: 1, screen: { kind: "dashboard", name: "Test", purpose: "Renderer test" }, theme: { mode: "light" }, layout: { main: { children } } };
  patch(o);
  return o;
};
const button = (label = "Go", extra: object = {}) => ({ type: "button", label, ...extra });
const textNode = (content: string, extra: object = {}) => ({ type: "text", content, ...extra });

const rejected = (v: unknown) => {
  const r = checkRenderable(v);
  assert.equal(r.ok, false, String(JSON.stringify(v)).slice(0, 120));
  const out = html(v);
  assert.match(out, /role="alert"/);
  assert.ok(!out.includes("pv-app"), "a rejected specification must render no partial UI");
  return r;
};

// ---- every component type ----------------------------------------------------------------------------------------

test("the example specification renders from its JSON: every authored string appears, escaped", () => {
  const e = example();
  const out = html(e);
  assert.ok(out.includes('class="pv-app"') && out.includes('data-mode="light"') && out.includes('data-accent="blue"'));
  const strings: string[] = [];
  const walk = (v: any, key = "") => {
    if (typeof v === "string" && ["label", "content", "title", "subtitle", "value", "header", "hint", "caption", "text"].includes(key)) strings.push(v);
    if (Array.isArray(v)) v.forEach((x) => (Array.isArray(x) && x.every((c) => typeof c === "string") ? x.forEach((c) => strings.push(c)) : walk(x, key)));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  walk(e.layout);
  assert.ok(strings.length >= 20, `${strings.length} strings`);
  for (const s of strings) assert.ok(out.includes(s.replace(/&/g, "&amp;").replace(/</g, "&lt;")), `missing ${s}`);
  assert.match(out, /<h1 class="pv-header-title">Expenses<\/h1>/);
  assert.match(out, /aria-current="page"/); // the active sidebar item
});

test("component: stack (direction, gap, align) and grid (columns, gap)", () => {
  const out = html(spec([{ type: "stack", direction: "row", gap: "lg", align: "center", children: [textNode("a")] }, { type: "stack", children: [] }, { type: "grid", columns: 4, gap: "xs", children: [textNode("b")] }]));
  assert.match(out, /class="pv-stack dir-row gap-s-lg align-center"/);
  assert.match(out, /class="pv-stack dir-column gap-s-md align-stretch"/); // defaults filled in by normalization
  assert.match(out, /class="pv-grid cols-4 gap-s-xs"/);
});

test("component: text variants map to semantic elements and tones", () => {
  const out = html(spec([textNode("H", { variant: "heading" }), textNode("S", { variant: "subheading", tone: "accent" }), textNode("B"), textNode("C", { variant: "caption", tone: "muted" })]));
  assert.match(out, /<h2 class="pv-text text-heading tone-default">H<\/h2>/);
  assert.match(out, /<h3 class="pv-text text-subheading tone-accent">S<\/h3>/);
  assert.match(out, /<p class="pv-text text-body tone-default">B<\/p>/);
  assert.match(out, /<p class="pv-text text-caption tone-muted">C<\/p>/);
});

test("component: button variants, note as title, inert (no handler, not focusable, no link)", () => {
  const out = html(spec([button("P", { variant: "primary", note: "Opens a form" }), button("D", { variant: "danger" }), button("G", { variant: "ghost" })]));
  assert.match(out, /class="pv-button btn-primary"[^>]*title="Opens a form"/);
  assert.match(out, /btn-danger/);
  assert.match(out, /btn-ghost/);
  assert.equal((out.match(/tabindex="-1"/g) ?? []).length, 3);
  assert.equal((out.match(/aria-disabled="true"/g) ?? []).length, 3);
  assertOnlySafeMarkup(out, "buttons");
});

test("component: stat-card with delta trends and hint", () => {
  const out = html(spec([{ type: "stat-card", label: "L", value: "V", delta: { text: "+2%", trend: "up" }, hint: "H" }, { type: "stat-card", label: "L2", value: "V2", delta: { text: "-1%", trend: "down" } }, { type: "stat-card", label: "L3", value: "V3" }]));
  assert.match(out, /pv-stat-delta trend-up/);
  assert.match(out, /pv-stat-delta trend-down/);
  assert.match(out, /pv-stat-hint">H</);
  assert.equal((out.match(/class="pv-stat"/g) ?? []).length, 3);
  assert.equal((out.match(/pv-stat-delta/g) ?? []).length, 2); // no delta, no element
});

test("component: table (caption, alignment, rows, empty state)", () => {
  const cols = [{ key: "a", header: "A" }, { key: "b", header: "B", align: "end" }];
  const full = html(spec([{ type: "table", caption: "Cap", columns: cols, rows: [["1", "2"], ["3", "4"]] }]));
  assert.match(full, /<caption>Cap<\/caption>/);
  assert.match(full, /<th scope="col" class="align-start">A<\/th><th scope="col" class="align-end">B<\/th>/);
  assert.match(full, /<td class="align-start">1<\/td><td class="align-end">2<\/td>/);
  assert.equal((full.match(/<tr>/g) ?? []).length, 3);
  const empty = html(spec([{ type: "table", columns: cols, rows: [], emptyText: "Nothing here" }]));
  assert.match(empty, /colSpan="2"|colspan="2"/i);
  assert.match(empty, /Nothing here/);
  assert.match(html(spec([{ type: "table", columns: cols, rows: [] }])), /No rows/);
});

test("slots: header with actions, sidebar with icons and active item, narrow width", () => {
  const out = html(spec([textNode("x")], (o) => {
    o.layout.header = { type: "header", title: "T", subtitle: "Sub", actions: [button("A1"), button("A2")] };
    o.layout.sidebar = { type: "sidebar", title: "Menu", width: "narrow", items: [{ label: "One", icon: "home", active: true }, { label: "Two", icon: "bell" }, { label: "Three" }] };
  }));
  assert.match(out, /<h1 class="pv-header-title">T<\/h1>/);
  assert.match(out, /pv-header-subtitle">Sub</);
  assert.equal((out.match(/pv-header-actions[\s\S]*?<\/div>/)![0].match(/<button/g) ?? []).length, 2);
  assert.match(out, /class="pv-sidebar w-narrow"/);
  assert.equal((out.match(/<svg/g) ?? []).length, 2); // two items have icons
  assert.equal((out.match(/pv-nav-item/g) ?? []).length, 3);
  assert.ok(!/<a\s|href=/.test(out)); // items are inert
  for (const icon of ["home", "chart", "list", "wallet", "users", "settings", "bell", "file"]) {
    const one = html(spec([], (o) => (o.layout.sidebar = { type: "sidebar", items: [{ label: "L", icon }] })));
    assert.match(one, /<svg[^>]*><path d="M[^"]+"(\/>|><\/path>)<\/svg>/, icon);
  }
});

test("theme and layout tokens: mode, accent, main gap and padding", () => {
  const out = html(spec([], (o) => {
    o.theme = { mode: "dark", accent: "purple" };
    o.layout.main = { gap: "xl", padding: "none", children: [] };
  }));
  assert.match(out, /data-mode="dark" data-accent="purple"/);
  assert.match(out, /class="pv-main gap-s-xl pad-s-none"/);
});

test("the registry has exactly one renderer per schema component type, and only own properties resolve", () => {
  assert.deepEqual(Object.keys(registry).sort(), ["button", "grid", "stack", "stat-card", "table", "text"]);
  for (const t of ["constructor", "toString", "__proto__", "hasOwnProperty", "script", "iframe", "Text", ""]) assert.throws(() => renderNode({ type: t } as any, "k"), /unsupported component type/, t);
  // every registry type is also accepted by the schema, so the two lists cannot drift apart silently
  const samples: any[] = [{ type: "stack", children: [] }, { type: "grid", columns: 1, children: [] }, textNode("t"), button(), { type: "stat-card", label: "a", value: "b" }, { type: "table", columns: [{ key: "a", header: "A" }], rows: [] }];
  assert.deepEqual(samples.map((s) => s.type).sort(), Object.keys(registry).sort());
  for (const s of samples) assert.equal(checkRenderable(spec([s])).ok, true, s.type);
});

// ---- nesting ----------------------------------------------------------------------------------------------------------

test("nested components keep their order and parent/child relationships", () => {
  const nested = spec([{ type: "stack", children: [textNode("first"), { type: "grid", columns: 2, children: [{ type: "stack", direction: "row", children: [textNode("deep"), button("deepbtn")] }, textNode("sibling")] }, textNode("last")] }]);
  const out = html(nested);
  const order = ["pv-stack dir-column", "first", "pv-grid cols-2", "pv-stack dir-row", "deep", "deepbtn", "sibling", "last"].map((m) => out.indexOf(m));
  assert.ok(order.every((i) => i >= 0) && order.every((v, i) => i === 0 || v > order[i - 1]!), JSON.stringify(order));
  const doc = out.slice(out.indexOf('<main'));
  assert.equal((doc.match(/<div class="pv-(stack|grid)/g) ?? []).length, 3);
  assert.equal((doc.match(/<\/div>/g) ?? []).length, 3 + 2); // balanced: three containers, plus the body and app wrappers
  // "deep" sits inside the row stack, which sits inside the grid, which sits inside the first stack
  const rowStart = out.indexOf("pv-stack dir-row");
  assert.ok(out.indexOf("deep") > rowStart && out.indexOf("sibling") > out.indexOf("deepbtn"));
});

// ---- safety ------------------------------------------------------------------------------------------------------------

const HOSTILE = [`<img src=x onerror=alert(1)>`, `"><script>alert(1)</script>`, `' onmouseover='alert(1)`, `&amp; &lt;b&gt;`, `javascript:alert(1)`, `https://evil.example/x.js`, "</style><link rel=stylesheet href=//evil>", "{{7*7}} ${7*7}"];

test("hostile text is escaped everywhere text is rendered and never becomes markup or an attribute", () => {
  for (const full of HOSTILE) {
    const h = full.slice(0, 40); // the schema's shortest text limit is 20 (delta) and 40 (labels); stay inside it so the spec is valid
    const o = spec([textNode(h), textNode(h, { variant: "heading" }), textNode(h, { variant: "subheading" }), textNode(h, { variant: "caption" }), button(h, { note: h }), { type: "stat-card", label: h, value: h, hint: h, delta: { text: h.slice(0, 20), trend: "up" } }, { type: "table", caption: h, emptyText: h, columns: [{ key: "a", header: h.slice(0, 30) }], rows: [[h]] }], (x) => {
      x.screen.name = h;
      x.layout.header = { type: "header", title: h, subtitle: h, actions: [] };
      x.layout.sidebar = { type: "sidebar", title: h, items: [{ label: h.slice(0, 30) }] };
    });
    const out = html(o);
    assert.ok(out.includes("pv-app"), h);
    assertOnlySafeMarkup(out, h); // only allow-listed elements and attributes: no script, img, a, on*, href, src, style, ...
    assert.ok(out.includes(h.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;")) || out.includes(h.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")), `the hostile text should be present, escaped: ${h}`);
  }
  const out = html(spec([textNode(`<b>bold</b> & "quoted"`)]));
  assert.match(out, /&lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quoted&quot;|&lt;b&gt;bold&lt;\/b&gt; &amp; "quoted"/);
});

test("no rendered specification contains a script, remote resource, URL attribute, style attribute or event handler", () => {
  const out = html(example());
  assertOnlySafeMarkup(out, "example");
  assert.ok(!/https?:|\/\/|javascript:|data:/i.test(out));
});

test("URLs and executable-looking values are only data: properties that could carry them are rejected", () => {
  for (const extra of [{ href: "https://evil.example" }, { src: "https://evil.example/x.png" }, { url: "javascript:alert(1)" }, { onClick: "alert(1)" }, { onclick: "alert(1)" }, { style: "background:url(//evil)" }, { className: "x" }, { dangerouslySetInnerHTML: { __html: "<b>" } }, JSON.parse('{"__proto__":{"polluted":true}}'), { constructor: "x" }]) {
    rejected(spec([button("x", extra)]));
    rejected(spec([textNode("x", extra)]));
    rejected(spec([{ type: "stat-card", label: "a", value: "b", ...extra }]));
  }
  rejected(spec([], (o) => (o.layout.header = { type: "header", title: "T", actions: [], logoUrl: "https://evil.example/l.png" })));
  rejected(spec([], (o) => (o.theme.fontUrl = "https://fonts.example/x.css")));
  rejected(spec([], (o) => (o.layout.sidebar = { type: "sidebar", items: [{ label: "L", href: "/x" }] })));
  // the same strings as plain text are fine and inert
  const out = html(spec([textNode("https://evil.example/x.js"), textNode("javascript:alert(1)")]));
  assert.ok(out.includes("https://evil.example/x.js"));
  assertOnlySafeMarkup(out, "url-looking text");
});

test("malformed and unsupported specifications are rejected without rendering anything", () => {
  const bads: unknown[] = [undefined, null, 0, "x", "{}", [], {}, { schemaVersion: 2 }, { ...spec([]), schemaVersion: 0 }, { ...spec([]), screen: { kind: "landing", name: "n", purpose: "p" } }, { ...spec([]), screen: undefined }, { ...spec([]), extra: 1 },
    spec([{ type: "script", src: "https://evil.example/x.js" }]), spec([{ type: "iframe" }]), spec([{ type: "constructor" }]), spec([{ type: "TEXT", content: "x" }]), spec([{ content: "no type" }]), spec([null]), spec(["text"]), spec([[]]),
    spec([textNode("x", { variant: "giant" })]), spec([textNode("x", { tone: "#ff0000" })]), spec([{ type: "grid", columns: 5, children: [] }]), spec([{ type: "grid", columns: 0, children: [] }]), spec([{ type: "stack", gap: "10px", children: [] }]),
    spec([], (o) => (o.theme.accent = "#fff")), spec([], (o) => (o.theme.mode = "sepia")), spec([button("x", { id: "Not Valid" })]), spec([button("x", { id: "a<b" })]),
    spec([{ type: "table", columns: [{ key: "a", header: "A" }], rows: [["1", "2"]] }]), spec([{ type: "table", columns: [{ key: "a", header: "A" }, { key: "a", header: "B" }], rows: [] }]),
    spec([textNode("x\u0000y")]), spec([textNode("‮evil")]), spec([textNode("")]), spec([textNode("   ")]),
    spec([], (o) => (o.layout.header = { type: "sidebar", title: "x", actions: [] })), spec([{ type: "header", title: "nested header", actions: [] }])];
  for (const b of bads) rejected(b);
  for (const m of ["(root)", "unknown"]) assert.ok(typeof m === "string");
  const issues = (checkRenderable(spec([{ type: "script" }])) as any).issues as string[];
  assert.ok(issues.length >= 1 && issues.length <= 10 && issues.every((i) => i.length <= 160));
});

test("duplicate ids are not a rendering concern, but ids never become DOM ids", () => {
  const out = html(spec([button("a", { id: "same" }), textNode("t", { id: "other" })]));
  assert.ok(out.includes('data-node-id="same"') && out.includes('data-node-id="other"'));
  assert.ok(!/\sid=/.test(out), "spec ids must not collide with the app's own DOM ids");
});

// ---- limits ------------------------------------------------------------------------------------------------------------

test("limits: at the boundary a specification renders, one past it is rejected", () => {
  const buttons = (n: number) => Array.from({ length: n }, (_, i) => button(`b${i}`));
  // children per container
  assert.equal(checkRenderable(spec(buttons(LIMITS.children))).ok, true);
  rejected(spec(buttons(LIMITS.children + 1)));
  assert.equal(checkRenderable(spec([{ type: "stack", children: buttons(LIMITS.children) }])).ok, true);
  rejected(spec([{ type: "stack", children: buttons(LIMITS.children + 1) }]));
  // nesting
  const nest = (d: number): any => (d === 0 ? textNode("leaf") : { type: "stack", children: [nest(d - 1)] });
  assert.equal(checkRenderable(spec([nest(LIMITS.nesting)])).ok, true);
  rejected(spec([nest(LIMITS.nesting + 1)]));
  // component count: exactly 60 is fine, 61 is not
  const stacks = Array.from({ length: 4 }, () => ({ type: "stack", children: buttons(12) })); // 4 + 48
  const sixty = [...stacks, ...buttons(8)]; // + 8 = 60
  assert.equal(checkRenderable(spec(sixty)).ok, true);
  const r = rejected(spec(sixty, (o) => (o.layout.header = { type: "header", title: "one more", actions: [] })));
  assert.match((r as any).issues.join(" "), /61 components/);
  // other schema limits
  rejected(spec([{ type: "table", columns: [{ key: "a", header: "A" }], rows: Array.from({ length: LIMITS.tableRows + 1 }, () => ["x"]) }]));
  rejected(spec([{ type: "table", columns: Array.from({ length: LIMITS.tableColumns + 1 }, (_, i) => ({ key: `c${i}`, header: "H" })), rows: [] }]));
  rejected(spec([textNode("x".repeat(501))]));
  rejected(spec([], (o) => (o.layout.header = { type: "header", title: "T", actions: [button("1"), button("2"), button("3"), button("4")] })));
  rejected(spec([], (o) => (o.layout.sidebar = { type: "sidebar", items: Array.from({ length: LIMITS.sidebarItems + 1 }, () => ({ label: "x" })) })));
});

test("limits: hostile raw size and depth are rejected before the recursive parser runs (no stack overflow)", () => {
  let deep: any = "x";
  for (let i = 0; i < 20000; i++) deep = [deep];
  const r1 = rejected(spec([textNode("t")], (o) => (o.deep = deep)));
  assert.match((r1 as any).issues[0], /nested deeper/);
  const wide = spec([textNode("t")], (o) => (o.wide = Array.from({ length: LIMITS.rawJsonValues + 1 }, () => 0)));
  assert.match((rejected(wide) as any).issues[0], /more than/);
  let nodeDeep: any = textNode("leaf");
  for (let i = 0; i < 5000; i++) nodeDeep = { type: "stack", children: [nodeDeep] };
  rejected(spec([nodeDeep]));
});

// ---- determinism ----------------------------------------------------------------------------------------------------------

test("rendering is deterministic: same markup for repeated renders, key order, and a JSON round trip", () => {
  const e = example();
  const first = html(e);
  for (let i = 0; i < 5; i++) assert.equal(html(e), first);
  const reorder = (v: any): any => (Array.isArray(v) ? v.map(reorder) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).reverse().map((k) => [k, reorder(v[k])])) : v);
  assert.equal(html(reorder(e)), first);
  assert.equal(html(JSON.parse(JSON.stringify(e))), first);
  const r = checkRenderable(e);
  assert.ok(r.ok);
  assert.equal(html((r as any).spec), first); // rendering the normalized output again changes nothing
  assert.equal(JSON.stringify(e), JSON.stringify(example())); // rendering did not mutate the input
});

test("normalization is applied before rendering: trimmed text, filled defaults", () => {
  const out = html(spec([textNode("  padded  "), button("  b  ")]));
  assert.match(out, />padded</);
  assert.match(out, />b</);
  assert.match(out, /btn-secondary/); // default variant
  const nfd = html(spec([textNode("é")])); // decomposed é is normalized to the composed form
  assert.ok(nfd.includes("é") && !nfd.includes("é"));
});
