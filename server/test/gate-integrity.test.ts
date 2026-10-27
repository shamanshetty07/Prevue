import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyStoredDesign } from "../src/design-store.js";
import { evaluate } from "../src/gate.js";
import { LIMITS } from "../src/spec/schema.js";
import { parseSpecText } from "../src/spec/validate.js";
import { approve, hashDesign, initIfMissing, load, paths, registerDesign, reset } from "../src/state.js";
import { env, pre, prompt, sandbox, start, tmp, type Sandbox } from "./helpers.js";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const specOf = (mutate?: (o: any) => void) => {
  const o = JSON.parse(exampleText);
  mutate?.(o);
  const r = parseSpecText(JSON.stringify(o));
  assert.ok(r.ok);
  return (r as any).spec;
};
const A = specOf();
const B = specOf((o) => (o.screen.name = "Another dashboard"));
const w = { file_path: "src/App.tsx", content: "x" };
const verdict = (s: Sandbox, tool = "Write") => evaluate(env(s), tool, w);

/** Test-only stand-in for what Phase 1c registration will do: store the canonical file, then register with the marker. */
function store(s: Sandbox, spec: unknown, content: string = JSON.stringify(spec)): string {
  const dir = join(paths(s.data, s.project).dir, "designs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, `${hashDesign(spec)}.json`);
  writeFileSync(f, content, { mode: 0o600 });
  return f;
}
function approvedCanonical(spec: any = A) {
  const s = sandbox();
  const file = store(s, spec);
  registerDesign(s.data, s.project, spec, { canonical: true });
  approve(s.data, s.project, hashDesign(spec).slice(0, 12));
  return { s, file, hash: hashDesign(spec) };
}
const blocked = (s: Sandbox, code: string) => {
  const d = verdict(s) as any;
  assert.equal(d.decision, "deny");
  assert.equal(d.status, "INVALID");
  assert.ok(d.reason.includes(code), `${code} in ${d.reason}`);
  assert.equal(evaluate(env(s), "Read", { file_path: "a" }).decision, "allow"); // read-only tools still work, as for any INVALID state
  assert.equal(evaluate(env(s), "Bash", { command: "npm run build" }).decision, "deny");
};

test("integrity: an approved state with a valid, matching stored design behaves as before", () => {
  const { s, hash } = approvedCanonical();
  assert.equal(load(s.data, s.project).status, "APPROVED");
  const d = verdict(s);
  assert.deepEqual([d.decision, d.status], ["allow", "APPROVED"]);
  assert.equal(evaluate(env(s), "Bash", { command: "npm run build" }).decision, "allow");
  assert.deepEqual(verifyStoredDesign(s.data, s.project, (load(s.data, s.project) as any).state), { ok: true });
  assert.equal(hashDesign(A), hash);
});

test("integrity: a missing design file blocks implementation", () => {
  const { s, file } = approvedCanonical();
  rmSync(file);
  blocked(s, "design_missing");
  rmSync(join(paths(s.data, s.project).dir, "designs"), { recursive: true });
  blocked(s, "design_missing");
});

test("integrity: corrupt, non-UTF-8, empty and non-specification content blocks implementation", () => {
  for (const [label, bytes] of [["truncated JSON", '{"schemaVersion":1,'], ["empty", ""], ["not JSON", "SECRET-MARKER"], ["array", "[]"], ["Phase 0 style JSON", '{"screen":"a"}']] as const) {
    const { s, file } = approvedCanonical();
    writeFileSync(file, bytes);
    blocked(s, "design_invalid");
    assert.ok(!((verdict(s) as any).reason as string).includes("SECRET-MARKER"), label);
  }
  const { s, file } = approvedCanonical();
  writeFileSync(file, Buffer.from([0xff, 0xfe, 0x7b, 0x7d]));
  blocked(s, "design_invalid");
});

test("integrity: a schema-invalid or semantically invalid stored design blocks implementation", () => {
  for (const mutate of [(o: any) => (o.schemaVersion = 2), (o: any) => (o.extra = 1), (o: any) => delete o.screen.purpose, (o: any) => o.layout.main.children.push({ type: "script", src: "x" }), (o: any) => (o.layout.main.children[0].id = o.layout.main.children[1].id = "same")]) {
    const { s, file } = approvedCanonical();
    const o = JSON.parse(readFileSync(file, "utf8"));
    mutate(o);
    writeFileSync(file, JSON.stringify(o));
    blocked(s, "design_invalid");
  }
});

test("integrity: a duplicate key in the stored design blocks implementation, even if the last value would hash correctly", () => {
  const { s, file } = approvedCanonical();
  writeFileSync(file, readFileSync(file, "utf8").replace('"name":"Expense dashboard"', '"name":"First","name":"Expense dashboard"'));
  blocked(s, "design_invalid");
});

test("integrity: a valid design stored under the wrong hash blocks implementation (hash mismatch)", () => {
  const { s, file } = approvedCanonical(A);
  writeFileSync(file, JSON.stringify(B)); // a perfectly valid design, but not the approved one
  blocked(s, "design_hash_mismatch");
  // Same design, different bytes: whitespace and key order do not matter, the normalized hash does.
  writeFileSync(file, JSON.stringify(A, null, 3));
  assert.equal(verdict(s).decision, "allow");
});

test("integrity: state whose revision and approval disagree is INVALID (revision mismatch)", () => {
  const { s } = approvedCanonical();
  const f = paths(s.data, s.project).file;
  const o = JSON.parse(readFileSync(f, "utf8"));
  o.revision = 2; // approvedRevision stays 1
  writeFileSync(f, JSON.stringify(o));
  const d = verdict(s) as any;
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /approvedRevision does not match revision/);
  // and the approved hash must be the design hash
  const o2 = JSON.parse(readFileSync(f, "utf8"));
  o2.revision = 1;
  o2.approvedHash = hashDesign(B);
  writeFileSync(f, JSON.stringify(o2));
  assert.match((verdict(s) as any).reason, /approvedHash does not match designHash/);
});

test("integrity: a symlinked design file, a symlinked designs directory, and non-regular files are untrusted", () => {
  {
    const { s, file } = approvedCanonical();
    const real = join(tmp("elsewhere"), "real.json");
    writeFileSync(real, JSON.stringify(A)); // content is perfectly valid
    rmSync(file);
    symlinkSync(real, file);
    blocked(s, "design_untrusted");
  }
  {
    const { s } = approvedCanonical();
    const dir = join(paths(s.data, s.project).dir, "designs");
    const moved = join(tmp("elsewhere"), "designs");
    renameSync(dir, moved);
    symlinkSync(moved, dir);
    blocked(s, "design_untrusted");
  }
  {
    const { s, file } = approvedCanonical();
    rmSync(file);
    mkdirSync(file);
    blocked(s, "design_untrusted");
  }
  {
    const { s, file } = approvedCanonical();
    rmSync(file);
    if (spawnSync("mkfifo", [file]).status === 0) blocked(s, "design_untrusted"); // must not hang on open()
  }
});

test("integrity: an oversized stored design is rejected without being parsed", () => {
  const { s, file } = approvedCanonical();
  writeFileSync(file, " ".repeat(LIMITS.rawBytes + 1));
  blocked(s, "design_too_large");
});

test("integrity: an unreadable stored design blocks (not as root)", { skip: process.getuid?.() === 0 }, () => {
  const { s, file } = approvedCanonical();
  chmodSync(file, 0o000);
  blocked(s, "design_unreadable");
});

test("integrity: missing, malformed or inconsistent state keeps the existing fail-closed behaviour", () => {
  const s = sandbox();
  store(s, A);
  assert.equal((verdict(s) as any).status, "INVALID"); // design file but no state
  initIfMissing(s.data, s.project);
  assert.equal((verdict(s) as any).status, "PENDING");
  assert.equal(verdict(s).decision, "deny");
  const f = paths(s.data, s.project).file;
  for (const bad of ["{", "[]", JSON.stringify({ schema: 1 })]) {
    writeFileSync(f, bad);
    assert.equal(verdict(s).decision, "deny");
  }
  const t = approvedCanonical();
  const st = paths(t.s.data, t.s.project).file;
  for (const marker of [false, "yes", 1, null]) {
    const o = JSON.parse(readFileSync(st, "utf8"));
    o.canonical = marker;
    writeFileSync(st, JSON.stringify(o));
    assert.match((verdict(t.s) as any).reason, /canonical marker malformed/, JSON.stringify(marker));
  }
  const fresh = sandbox();
  initIfMissing(fresh.data, fresh.project);
  const o = JSON.parse(readFileSync(paths(fresh.data, fresh.project).file, "utf8"));
  o.canonical = true; // a marker on a state with no design
  writeFileSync(paths(fresh.data, fresh.project).file, JSON.stringify(o));
  assert.match((verdict(fresh) as any).reason, /canonical marker malformed/);
});

test("integrity: pending behaviour is unchanged, a stored design alone approves nothing", () => {
  const s = sandbox();
  store(s, A);
  const r = registerDesign(s.data, s.project, A, { canonical: true });
  assert.equal(r.state.revision, 1);
  assert.equal(r.state.approvedRevision, null);
  const d = verdict(s) as any;
  assert.deepEqual([d.decision, d.status], ["deny", "PENDING"]);
  assert.equal(evaluate(env(s), "Read", { file_path: "a" }).decision, "allow");
});

test("integrity: a design change invalidates the approval; A -> B -> A does not revive it", () => {
  const { s } = approvedCanonical(A);
  store(s, B);
  const rb = registerDesign(s.data, s.project, B, { canonical: true });
  assert.equal(rb.state.revision, 2);
  assert.equal(rb.state.approvedRevision, null);
  assert.equal(verdict(s).decision, "deny");
  const ra = registerDesign(s.data, s.project, A, { canonical: true });
  assert.equal(ra.state.revision, 3); // A's design file still exists and is valid
  assert.equal(verdict(s).decision, "deny");
  assert.equal(load(s.data, s.project).status, "PENDING");
  approve(s.data, s.project, hashDesign(A).slice(0, 12));
  assert.equal(verdict(s).decision, "allow");
  // an identical registration is a no-op for the state and keeps the approval
  const same = registerDesign(s.data, s.project, A, { canonical: true });
  assert.equal(same.changed, false);
  assert.equal(load(s.data, s.project).status, "APPROVED");
});

test("integrity: the canonical marker describes one revision and is never carried to the next", () => {
  const { s } = approvedCanonical(A);
  const legacy = registerDesign(s.data, s.project, { screen: "phase 0 design" }); // no option: unchanged behaviour
  assert.equal("canonical" in legacy.state, false);
  approve(s.data, s.project, hashDesign({ screen: "phase 0 design" }).slice(0, 12));
  assert.equal(verdict(s).decision, "allow"); // a design registered the old way still needs no stored file
  const plain = sandbox();
  const r = registerDesign(plain.data, plain.project, A);
  assert.equal("canonical" in r.state, false);
  assert.ok(!JSON.stringify(r.state).includes("canonical"));
});

test("integrity: the stored design is verified on every call (no cache can hide a later change)", () => {
  const { s, file } = approvedCanonical();
  assert.equal(verdict(s).decision, "allow");
  const good = readFileSync(file);
  writeFileSync(file, "{}");
  assert.equal(verdict(s).decision, "deny");
  writeFileSync(file, good);
  assert.equal(verdict(s).decision, "allow");
  rmSync(file);
  assert.equal(verdict(s).decision, "deny");
});

test("integrity: recovery through the supported reset", () => {
  const { s, file } = approvedCanonical();
  const good = readFileSync(file);
  writeFileSync(file, "{}");
  assert.equal(verdict(s).decision, "deny");
  const q = reset(s.data, s.project);
  assert.ok(q.quarantinedTo);
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.revision, "canonical" in l.state], ["PENDING", 0, false]);
  assert.equal(verdict(s).decision, "deny"); // reset does not approve anything
  writeFileSync(file, good); // the developer restores the design, registers and approves again
  registerDesign(s.data, s.project, A, { canonical: true });
  assert.equal(verdict(s).decision, "deny");
  approve(s.data, s.project, hashDesign(A).slice(0, 12));
  assert.equal(verdict(s).decision, "allow");
});

test("integrity: failure reasons never contain stored content or the design path", () => {
  const { s, file } = approvedCanonical();
  writeFileSync(file, '{"schemaVersion":1,"x":"TOP-SECRET-MARKER"');
  const d = verdict(s) as any;
  assert.ok(!d.reason.includes("TOP-SECRET-MARKER") && !d.reason.includes(file) && !d.reason.includes(s.data));
});

test("integrity: verification never writes anything", () => {
  const { s } = approvedCanonical();
  const dir = join(paths(s.data, s.project).dir, "designs");
  const before = [readdirSync(dir), readdirSync(paths(s.data, s.project).dir).sort()];
  for (let i = 0; i < 5; i++) verdict(s);
  assert.deepEqual([readdirSync(dir), readdirSync(paths(s.data, s.project).dir).sort()], before);
});

test("integrity: the real hook process denies, reports INVALID at session start, and rejects approval of an unverifiable revision", () => {
  const { s, file } = approvedCanonical();
  const ok = pre(s, "Write", w);
  assert.equal(ok.stdout, ""); // allowed
  assert.match(start(s).stdout, /APPROVED/);
  writeFileSync(file, "{}");
  const denied = pre(s, "Write", w);
  assert.match(denied.stdout, /"permissionDecision":"deny"/);
  assert.match(denied.stdout, /design_invalid/);
  assert.match(start(s).stdout, /INVALID \(the approved design cannot be verified: design_invalid\)/);

  // approving a revision whose stored design is broken is rejected, and nothing is approved
  const t = sandbox();
  const f2 = store(t, A);
  registerDesign(t.data, t.project, A, { canonical: true });
  writeFileSync(f2, "{}");
  const out = prompt(t, `prevue approve ${hashDesign(A).slice(0, 12)}`).stdout;
  assert.match(out, /REJECTED/);
  assert.match(out, /cannot be verified \(design_invalid\); nothing was approved/);
  assert.equal((load(t.data, t.project) as any).status, "PENDING");
  assert.match(pre(t, "Write", w).stdout, /"permissionDecision":"deny"/);
});

test("integrity: a canonical approval is unverifiable, hence blocked, if no verifier is supplied to the gate", () => {
  const { s } = approvedCanonical();
  const d = evaluate({ dataDir: s.data, projectDir: s.project, cwd: s.project }, "Write", w) as any;
  assert.equal(d.decision, "deny");
  assert.match(d.reason, /design_unverifiable/);
});

test("integrity: the gate and the hook do not load the schema library unless a canonical approval needs checking", () => {
  const dist = import.meta.dirname + "/../src";
  for (const f of ["gate.js", "hook.js", "state.js", "classify.js"]) {
    const src = readFileSync(join(dist, f), "utf8");
    assert.ok(!/from\s*["'](zod|\.\/spec\/[^"']*|\.\/design-store\.js)["']/.test(src), `${f} statically imports the schema library or the verifier`);
  }
  assert.match(readFileSync(join(dist, "hook.js"), "utf8"), /import\(["']\.\/design-store\.js["']\)/);
});
