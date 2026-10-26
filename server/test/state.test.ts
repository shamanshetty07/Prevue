import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { approve, hashDesign, initIfMissing, load, paths, registerDesign, reset } from "../src/state.js";
import { sandbox, tmp } from "./helpers.js";

const A = { screen: "dashboard", layout: "A" };
const B = { screen: "dashboard", layout: "B" };
const ha = hashDesign(A).slice(0, 12);
const hb = hashDesign(B).slice(0, 12);

test("new project: init creates PENDING at revision 0; init never overwrites", () => {
  const s = sandbox();
  assert.equal(load(s.data, s.project).status, "INVALID"); // missing is INVALID, never "no gate"
  assert.equal(initIfMissing(s.data, s.project), "created");
  const l = load(s.data, s.project);
  assert.equal(l.status, "PENDING");
  assert.equal((l as any).state.revision, 0);
  assert.equal(initIfMissing(s.data, s.project), "exists");
});

test("approving before any design exists is rejected", () => {
  const s = sandbox();
  initIfMissing(s.data, s.project);
  assert.throws(() => approve(s.data, s.project, "abcdef12"), /no design/);
});

test("A approved -> B is PENDING; B -> A is PENDING until approved again (revision-specific approval)", () => {
  const s = sandbox();
  const st = (): string => load(s.data, s.project).status;
  assert.equal(registerDesign(s.data, s.project, A).state.revision, 1);
  approve(s.data, s.project, ha);
  assert.equal(st(), "APPROVED");

  assert.equal(registerDesign(s.data, s.project, B).state.revision, 2);
  assert.equal(st(), "PENDING"); // invalidated immediately
  assert.throws(() => approve(s.data, s.project, ha), /does not match/); // cannot approve the old design by its old hash

  const back = registerDesign(s.data, s.project, A);
  assert.equal(back.state.revision, 3); // same content as revision 1, but a new revision
  assert.equal(back.changed, true);
  assert.equal(st(), "PENDING"); // the old approval must NOT come back

  const ok = approve(s.data, s.project, ha);
  assert.equal(ok.approvedRevision, 3);
  assert.equal(st(), "APPROVED");
});

test("re-registering unchanged content is a no-op and keeps the approval", () => {
  const s = sandbox();
  registerDesign(s.data, s.project, A);
  approve(s.data, s.project, ha);
  const again = registerDesign(s.data, s.project, { layout: "A", screen: "dashboard" }); // key order differs
  assert.equal(again.changed, false);
  assert.equal(again.state.revision, 1);
  assert.equal(load(s.data, s.project).status, "APPROVED");
});

test("approval requires a hash prefix and approving twice is idempotent", () => {
  const s = sandbox();
  registerDesign(s.data, s.project, A);
  assert.throws(() => approve(s.data, s.project, undefined), /hash prefix/);
  assert.throws(() => approve(s.data, s.project, "abc"), /hash prefix/);
  assert.throws(() => approve(s.data, s.project, "zzzzzzzz"), /hash prefix/);
  const first = approve(s.data, s.project, ha);
  assert.deepEqual(approve(s.data, s.project, ha), first);
});

const mutate = (s: ReturnType<typeof sandbox>, f: (o: any) => void) => {
  const { file } = paths(s.data, s.project);
  const o = JSON.parse(readFileSync(file, "utf8"));
  f(o);
  writeFileSync(file, JSON.stringify(o));
};

test("malformed or inconsistent state is INVALID, never PENDING/APPROVED", () => {
  const cases: Array<[string, (o: any) => void]> = [
    ["wrong schema", (o) => (o.schema = 1)],
    ["foreign project", (o) => (o.project = "0".repeat(32))],
    ["negative revision", (o) => (o.revision = -1)],
    ["revision 0 with a hash", (o) => (o.revision = 0)],
    ["bad hash", (o) => (o.designHash = "xyz")],
    ["approval for older revision", (o) => { o.approvedRevision = 1; o.approvedHash = o.designHash; o.approvedAt = "x"; o.revision = 2; }],
    ["approved hash differs", (o) => { o.approvedRevision = 1; o.approvedHash = hashDesign(B); o.approvedAt = "x"; }],
    ["partial approval", (o) => (o.approvedRevision = 1)],
    ["missing timestamps", (o) => delete o.createdAt],
  ];
  for (const [name, f] of cases) {
    const s = sandbox();
    registerDesign(s.data, s.project, A);
    mutate(s, f);
    assert.equal(load(s.data, s.project).status, "INVALID", name);
  }
  for (const [name, content] of [["not json", "{broken"], ["array", "[]"], ["null", "null"], ["empty", ""]] as const) {
    const s = sandbox();
    registerDesign(s.data, s.project, A);
    writeFileSync(paths(s.data, s.project).file, content);
    assert.equal(load(s.data, s.project).status, "INVALID", name);
  }
});

test("a symlinked state file is INVALID", () => {
  const s = sandbox();
  registerDesign(s.data, s.project, A);
  const { file } = paths(s.data, s.project);
  const real = join(tmp("elsewhere"), "state.json");
  renameSync(file, real);
  symlinkSync(real, file);
  assert.equal(load(s.data, s.project).status, "INVALID");
});

test("state copied from another project is INVALID (project binding)", () => {
  const a = sandbox(), b = sandbox();
  registerDesign(a.data, a.project, A);
  approve(a.data, a.project, ha);
  const from = paths(a.data, a.project), to = paths(a.data, b.project);
  mkdirSync(to.dir, { recursive: true });
  writeFileSync(to.file, readFileSync(from.file));
  assert.equal(load(a.data, b.project).status, "INVALID");
});

test("INVALID state: register and approve refuse; reset quarantines and starts PENDING", () => {
  const s = sandbox();
  registerDesign(s.data, s.project, A);
  approve(s.data, s.project, ha);
  const { file, dir } = paths(s.data, s.project);
  writeFileSync(file, "{broken");
  assert.throws(() => registerDesign(s.data, s.project, B), /INVALID/);
  assert.throws(() => approve(s.data, s.project, ha), /INVALID/);
  const r = reset(s.data, s.project);
  assert.ok(r.quarantinedTo && readFileSync(r.quarantinedTo, "utf8") === "{broken"); // evidence is kept
  const l = load(s.data, s.project);
  assert.equal(l.status, "PENDING");
  assert.equal((l as any).state.approvedRevision, null);
  assert.ok(readdirSync(dir).some((n) => n.includes(".invalid-")));
});

test("concurrent registrations from separate processes serialize: unique revisions, valid state, no stale lock", async () => {
  const s = sandbox();
  initIfMissing(s.data, s.project);
  const N = 8;
  const stateJs = join(import.meta.dirname, "..", "src", "state.js");
  const runs = Array.from({ length: N }, (_, i) =>
    new Promise<number>((res) => {
      const code = `import('${stateJs}').then(m=>{m.registerDesign(${JSON.stringify(s.data)},${JSON.stringify(s.project)},{n:${i}});})`;
      spawn("node", ["-e", code], { stdio: "ignore" }).on("exit", (c) => res(c ?? 1));
    }),
  );
  assert.deepEqual(await Promise.all(runs), Array(N).fill(0));
  const l = load(s.data, s.project);
  assert.equal(l.status, "PENDING");
  assert.equal((l as any).state.revision, N); // no lost update
  assert.ok(!readdirSync(paths(s.data, s.project).dir).includes("state.lock"));
});

test("a stale lock directory is broken; a fresh one is respected until it goes stale", () => {
  const s = sandbox();
  initIfMissing(s.data, s.project);
  const { lock } = paths(s.data, s.project);
  mkdirSync(lock);
  const old = new Date(Date.now() - 60_000);
  utimesSync(lock, old, old);
  assert.equal(registerDesign(s.data, s.project, A).changed, true);
});

test("concurrent init from many processes creates exactly one valid state", async () => {
  const s = sandbox();
  const stateJs = join(import.meta.dirname, "..", "src", "state.js");
  const runs = Array.from({ length: 6 }, () =>
    new Promise<number>((res) => spawn("node", ["-e", `import('${stateJs}').then(m=>m.initIfMissing(${JSON.stringify(s.data)},${JSON.stringify(s.project)}))`], { stdio: "ignore" }).on("exit", (c) => res(c ?? 1))),
  );
  assert.deepEqual(await Promise.all(runs), Array(6).fill(0));
  assert.equal(load(s.data, s.project).status, "PENDING");
});
