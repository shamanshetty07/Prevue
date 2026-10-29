import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import type { UiSpec } from "../../server/src/spec/schema.js";
import { checkRenderable } from "../src/render/guard.js";
import { allPaths } from "../src/render/paths.js";
import { nextSelection, type SelectionEvent } from "../src/render/selection.js";

const root = join(import.meta.dirname, "..", "..", "..", "..");
const example = (): any => JSON.parse(readFileSync(join(root, "docs", "examples", "expense-dashboard.json"), "utf8"));
const spec = (o: unknown = example()): UiSpec => {
  const r = checkRenderable(o);
  assert.ok(r.ok);
  return r.spec;
};
const run = (start: string | null, s: UiSpec | null, ...events: SelectionEvent[]): string | null => events.reduce((p, e) => nextSelection(p, e, s), start);

test("selection: picking any selectable node selects exactly that node, and picking another replaces it", () => {
  const s = spec();
  for (const { path } of allPaths(s)) assert.equal(run(null, s, { type: "pick", path }), path);
  assert.equal(run(null, s, { type: "pick", path: "main.0.1" }, { type: "pick", path: "main.2" }), "main.2");
  assert.equal(run("main.0.1", s, { type: "pick", path: "main.0.1" }), "main.0.1"); // picking the selected node keeps it
});

test("selection: picking nothing, or anything that is not a node of this design, clears the selection", () => {
  const s = spec();
  for (const path of [null, undefined, "", "main.9", "main.0.9", "main.01", "main.1.0", "sidebar.items.0", "header.actions.5", "nonsense", "main.", "MAIN.0", " main.0", "main.0 ", "__proto__", "constructor", "main.0.0.0.0.0.0.0.0.0", 0, {}, ["main.0"], "x".repeat(5000)]) {
    assert.equal(run("main.0.1", s, { type: "pick", path }), null, JSON.stringify(path)?.slice(0, 40));
  }
  assert.equal(run("main.0", null, { type: "pick", path: "main.0" }), null); // no design on screen: nothing can be selected
  // a path that exists in one design is not selectable in a design that lacks it
  const small = spec({ schemaVersion: 1, screen: { kind: "dashboard", name: "S", purpose: "p" }, theme: { mode: "light" }, layout: { main: { children: [{ type: "text", content: "x" }] } } });
  assert.equal(run(null, small, { type: "pick", path: "main.0.1" }), null);
  assert.equal(run(null, small, { type: "pick", path: "header" }), null);
  assert.equal(run(null, small, { type: "pick", path: "main.0" }), "main.0");
});

test("selection: Escape and a failed load clear it, from any state", () => {
  const s = spec();
  for (const start of [null, "main", "main.0.1", "header.actions.0", "stale"]) {
    assert.equal(run(start, s, { type: "escape" }), null);
    assert.equal(run(start, s, { type: "unavailable" }), null);
    assert.equal(run(start, null, { type: "escape" }), null);
  }
});

test("selection: polling the same design keeps the selection; a different design (new revision) starts unselected", () => {
  const s = spec();
  assert.equal(run("main.0.1", s, { type: "design", changed: false }, { type: "design", changed: false }, { type: "design", changed: false }), "main.0.1");
  assert.equal(run("main.0.1", s, { type: "design", changed: true }), null);
  assert.equal(run(null, s, { type: "design", changed: false }), null);
  // a realistic sequence: select, poll, a new revision arrives, select again in the new design
  const b = example();
  b.screen.name = "B";
  const sb = spec(b);
  const seq = (...e: SelectionEvent[]) => run(null, s, ...e);
  assert.equal(seq({ type: "pick", path: "main.2" }, { type: "design", changed: false }), "main.2");
  const afterRevision = nextSelection(seq({ type: "pick", path: "main.2" }), { type: "design", changed: true }, null);
  assert.equal(afterRevision, null);
  assert.equal(nextSelection(afterRevision, { type: "pick", path: "main.2" }, sb), "main.2");
});

test("selection: the state is only a path or null, and the function neither mutates the design nor depends on anything but its arguments", () => {
  const freeze = (v: any): any => { if (v && typeof v === "object") { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
  const s = freeze(spec());
  const before = JSON.stringify(s);
  for (const { path } of allPaths(s)) {
    const r = nextSelection(null, { type: "pick", path }, s);
    assert.ok(r === null || typeof r === "string");
    assert.equal(r, path);
    assert.equal(nextSelection(path, { type: "pick", path }, s), nextSelection(path, { type: "pick", path }, s)); // deterministic
  }
  assert.equal(JSON.stringify(s), before);
  const src = readFileSync(join(root, "preview", "src", "render", "selection.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.ok(!/\bfetch\b|localStorage|sessionStorage|document|window|Math\.random|Date\.now|process\./.test(src), "selection.ts is pure");
});

test("selection: App.tsx changes the selection only through nextSelection", () => {
  const app = readFileSync(join(root, "preview", "src", "App.tsx"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const setCalls = app.match(/setSelected\(/g) ?? [];
  const viaFn = app.match(/setSelected\(\(\w+\) => nextSelection\(/g) ?? [];
  assert.equal(setCalls.length, viaFn.length, "every setSelected call goes through nextSelection");
  assert.ok(setCalls.length >= 4, "unavailable, design, escape and pick");
  for (const t of ["unavailable", "design", "escape", "pick"]) assert.match(app, new RegExp(`type: "${t}"`));
});
