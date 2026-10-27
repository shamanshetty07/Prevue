import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { verifyStoredDesign } from "../src/design-store.js";
import { evaluate } from "../src/gate.js";
import { DESIGN_CAP, registerCanonical, type RegisterFail, type RegisterOk } from "../src/register.js";
import { LIMITS } from "../src/spec/schema.js";
import { parseSpecText } from "../src/spec/validate.js";
import { approve, canonicalJson, hashDesign, load, paths, registerDesign, registerLocked, reset } from "../src/state.js";
import { env, pre, prompt, sandbox, tmp, type Sandbox } from "./helpers.js";
import { spawnSync } from "node:child_process";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const EXAMPLE_HASH = "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5";
const variant = (name: string): string => {
  const o = JSON.parse(exampleText);
  o.screen.name = name;
  return JSON.stringify(o);
};
const A = exampleText;
const B = variant("Dashboard B");
const hashOf = (text: string): string => (parseSpecText(text) as any).hash;
const E = (s: Sandbox): NodeJS.ProcessEnv => ({ CLAUDE_PLUGIN_DATA: s.data, CLAUDE_PROJECT_DIR: s.project });
const reg = (s: Sandbox, text: string, deps = {}) => registerCanonical(E(s), text, undefined, deps);
const okOf = (r: unknown): RegisterOk => {
  assert.equal((r as any).ok, true, JSON.stringify(r));
  return r as RegisterOk;
};
const failOf = (r: unknown, code: string, kind?: string): RegisterFail => {
  assert.equal((r as any).ok, false, JSON.stringify(r));
  assert.equal((r as any).code, code, JSON.stringify(r));
  if (kind) assert.equal((r as any).kind, kind);
  assert.equal((r as any).registered, false);
  assert.equal((r as any).approvedByThisCall, false);
  return r as RegisterFail;
};
const designsDir = (s: Sandbox) => join(paths(s.data, s.project).dir, "designs");
const stateFile = (s: Sandbox) => paths(s.data, s.project).file;
const w = { file_path: "src/App.tsx", content: "x" };
const gate = (s: Sandbox, tool = "Write") => evaluate(env(s), tool, w);

/** Every file under dir with bytes and mtime: any create/modify/delete shows up. */
function snapshot(dir: string): string {
  if (!existsSync(dir)) return "(absent)";
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = lstatSync(p, { bigint: true });
      out.push(st.isDirectory() ? `${p}|dir` : `${p}|${st.isSymbolicLink() ? "link" : readFileSync(p).toString("base64")}|${st.mtimeNs}`); // directory mtimes change when the lock directory is created and removed
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join("\n");
}
const approveCurrent = (s: Sandbox) => approve(s.data, s.project, (load(s.data, s.project) as any).state.designHash.slice(0, 12));

test("register: a first registration stores the canonical design, creates a PENDING revision with the marker, and approves nothing", () => {
  const s = sandbox();
  const r = okOf(reg(s, A));
  assert.deepEqual([r.outcome, r.changed, r.revision, r.status, r.design, r.registered, r.approvedByThisCall], ["created", true, 1, "PENDING", "written", true, false]);
  assert.equal(r.hash, EXAMPLE_HASH);
  const l = load(s.data, s.project) as any;
  assert.equal(l.status, "PENDING");
  assert.deepEqual([l.state.revision, l.state.designHash, l.state.canonical, l.state.approvedRevision, l.state.approvedHash], [1, EXAMPLE_HASH, true, null, null]);
  const d = gate(s) as any;
  assert.deepEqual([d.decision, d.status], ["deny", "PENDING"]); // registering did not unlock anything
  assert.deepEqual(verifyStoredDesign(s.data, s.project, l.state), { ok: true });
});

test("register: the stored file is the normalized canonical specification, never the raw input", () => {
  const s = sandbox();
  const raw = JSON.parse(exampleText);
  raw.screen.name = "  Padded name  "; // trimmed by normalization
  delete raw.theme.accent; // restored as a default
  const text = JSON.stringify(raw, null, 9);
  const r = okOf(reg(s, text));
  const file = join(designsDir(s), `${r.hash}.json`);
  const stored = readFileSync(file, "utf8");
  const validated = parseSpecText(text) as any;
  assert.equal(stored, canonicalJson(validated.spec));
  assert.notEqual(stored, text);
  assert.ok(!stored.includes("  Padded") && stored.includes('"name":"Padded name"') && stored.includes('"accent":"blue"'));
  assert.equal(hashDesign(JSON.parse(stored)), r.hash); // the content hashes to its own name
  assert.equal(r.hash, validated.hash);
  assert.ok(Buffer.byteLength(stored) <= LIMITS.rawBytes);
  assert.deepEqual(readdirSync(designsDir(s)), [`${r.hash}.json`]); // no temp files left behind
});

test("register: file and directory permissions are private", { skip: process.platform === "win32" }, () => {
  const s = sandbox();
  const r = okOf(reg(s, A));
  assert.equal(statSync(designsDir(s)).mode & 0o777, 0o700);
  assert.equal(statSync(join(designsDir(s), `${r.hash}.json`)).mode & 0o777, 0o600);
});

test("register: an identical registration is a no-op that keeps the revision and the approval", () => {
  const s = sandbox();
  okOf(reg(s, A));
  approveCurrent(s);
  const before = snapshot(s.data);
  const again = okOf(reg(s, JSON.stringify(JSON.parse(A), null, 1))); // same design, different bytes
  assert.deepEqual([again.outcome, again.changed, again.revision, again.status, again.design], ["unchanged", false, 1, "APPROVED", "reused"]);
  assert.equal(snapshot(s.data), before);
  assert.equal(gate(s).decision, "allow");
});

test("register: a changed design gets a new revision, clears the approval, and the gate sees only a stored design", () => {
  const s = sandbox();
  const first = okOf(reg(s, A));
  approveCurrent(s);
  assert.equal(gate(s).decision, "allow");
  const second = okOf(reg(s, B));
  assert.deepEqual([second.outcome, second.changed, second.revision, second.status, second.design], ["updated", true, 2, "PENDING", "written"]);
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.approvedRevision, l.state.designHash, l.state.canonical], ["PENDING", null, second.hash, true]);
  assert.equal(gate(s).decision, "deny");
  assert.deepEqual(readdirSync(designsDir(s)).sort(), [`${first.hash}.json`, `${second.hash}.json`].sort());
  assert.deepEqual(verifyStoredDesign(s.data, s.project, l.state), { ok: true });
});

test("register: A, B, A creates three revisions and the first approval of A never returns", () => {
  const s = sandbox();
  assert.equal(okOf(reg(s, A)).revision, 1);
  approveCurrent(s);
  assert.equal(okOf(reg(s, B)).revision, 2);
  const third = okOf(reg(s, A));
  assert.deepEqual([third.revision, third.status, third.design], [3, "PENDING", "reused"]);
  assert.equal(gate(s).decision, "deny");
  assert.equal((load(s.data, s.project) as any).state.approvedRevision, null);
  approveCurrent(s); // only a fresh approval of revision 3 unlocks
  assert.equal(gate(s).decision, "allow");
  assert.equal((load(s.data, s.project) as any).state.approvedRevision, 3);
});

test("register: invalid input changes nothing (no state, no design files), whatever the starting state", () => {
  const dupKey = A.replace('"name": "Expense dashboard"', '"name": "x", "name": "Expense dashboard"');
  const noPurpose = JSON.stringify((() => { const o = JSON.parse(A); delete o.screen.purpose; return o; })());
  const cases: Array<[string, string, string]> = [["", "invalid_json", "parse_error"], ["{", "invalid_json", "parse_error"], [dupKey, "duplicate_key", "parse_error"], [noPurpose, "missing_field", "schema_error"], ['{"schemaVersion":2}', "unsupported_version", "schema_error"], ["x".repeat(LIMITS.rawBytes + 1), "too_large", "parse_error"]];
  for (const withState of [false, true]) {
    const s = sandbox();
    if (withState) {
      okOf(reg(s, A));
      approveCurrent(s);
    }
    const before = snapshot(s.data);
    for (const [text, code, kind] of cases) {
      const r = failOf(reg(s, text), code, kind) as RegisterFail;
      assert.ok(r.issues && r.issues.length >= 1 && r.issues.length <= 50);
      assert.equal(snapshot(s.data), before, `${code} (state: ${withState})`);
    }
    if (withState) assert.equal(gate(s).decision, "allow"); // the approval survived every rejected attempt
  }
});

test("register: failure messages never echo the input", () => {
  const s = sandbox();
  const r = JSON.stringify(reg(s, '{"schemaVersion":1,"leak":"TOP-SECRET-MARKER" oops}'));
  assert.ok(!r.includes("TOP-SECRET-MARKER") && !r.includes("oops"));
  const o = JSON.parse(A);
  o.theme.accent = "TOP-SECRET-MARKER";
  assert.ok(!JSON.stringify(reg(s, JSON.stringify(o))).includes("TOP-SECRET-MARKER"));
});

test("register: the canonical size limit is enforced after normalization, before anything is written", () => {
  const s = sandbox();
  failOf(reg(s, A, { canonicalLimit: 100 }), "canonical_too_large", "refused");
  assert.equal(snapshot(s.data), ""); // data dir exists but is empty
  // The largest specification the schema allows still fits under the real limit.
  const big = JSON.parse(exampleText);
  big.layout.main.children = Array.from({ length: 9 }, (_, i) => ({ type: "table", id: `t${i}`, columns: Array.from({ length: 8 }, (_, c) => ({ key: `c${c}`, header: "H".repeat(30) })), rows: Array.from({ length: 12 }, () => Array.from({ length: 8 }, () => "x".repeat(60))) }));
  const text = JSON.stringify(big);
  assert.ok(Buffer.byteLength(text) > 40_000 && Buffer.byteLength(text) <= LIMITS.rawBytes, `${Buffer.byteLength(text)} bytes`);
  const r = okOf(reg(s, text));
  assert.equal(r.outcome, "created");
  assert.ok(statSync(join(designsDir(s), `${r.hash}.json`)).size <= LIMITS.rawBytes);
});

test("register: a missing, empty or relative data directory, or a missing/relative project directory, fails closed and creates nothing", () => {
  const s = sandbox();
  const cwdBefore = readdirSync(process.cwd()).length;
  for (const data of [undefined, "", "relative-data", "./d", "../d"]) {
    const r = registerCanonical({ ...(data === undefined ? {} : { CLAUDE_PLUGIN_DATA: data }), CLAUDE_PROJECT_DIR: s.project }, A);
    failOf(r, "env_data_dir", "config_error");
  }
  for (const project of [undefined, "", "rel/project", "."]) {
    const r = registerCanonical({ CLAUDE_PLUGIN_DATA: s.data, ...(project === undefined ? {} : { CLAUDE_PROJECT_DIR: project }) }, A);
    failOf(r, "env_project_dir", "config_error");
  }
  assert.deepEqual(readdirSync(s.data), []);
  assert.deepEqual(readdirSync(s.project), []);
  assert.equal(readdirSync(process.cwd()).length, cwdBefore); // the process's own working directory is never used
});

test("register: malformed or invalid state is refused before any design is written", () => {
  const s = sandbox();
  okOf(reg(s, A));
  writeFileSync(stateFile(s), "{");
  const before = snapshot(s.data);
  failOf(reg(s, B), "state_invalid", "refused");
  assert.equal(snapshot(s.data), before);
  const t = sandbox();
  mkdirSync(paths(t.data, t.project).dir, { recursive: true });
  writeFileSync(stateFile(t), JSON.stringify({ schema: 1 }));
  failOf(reg(t, A), "state_invalid");
  assert.equal(existsSync(designsDir(t)), false);
});

test("register: a design-file write failure leaves the previous state and approval intact", { skip: process.getuid?.() === 0 || process.platform === "win32" }, () => {
  const s = sandbox();
  okOf(reg(s, A));
  approveCurrent(s);
  chmodSync(designsDir(s), 0o500); // cannot create files
  try {
    const before = snapshot(s.data);
    failOf(reg(s, B), "design_write_failed", "failed");
    assert.equal(snapshot(s.data), before);
    assert.equal(gate(s).decision, "allow");
  } finally {
    chmodSync(designsDir(s), 0o700);
  }
  assert.deepEqual(readdirSync(designsDir(s)).filter((n) => n.endsWith(".tmp")), []);
});

test("register: a state-write failure after the design was stored leaves the previous state valid, and a retry reuses the file", () => {
  const s = sandbox();
  okOf(reg(s, A));
  approveCurrent(s);
  const stateBefore = readFileSync(stateFile(s), "utf8");
  const r = failOf(reg(s, B, { registerState: () => { throw new Error("disk full"); } }), "state_write_failed", "failed");
  assert.ok(!JSON.stringify(r).includes("disk full"));
  assert.equal(readFileSync(stateFile(s), "utf8"), stateBefore);
  assert.equal(gate(s).decision, "allow"); // the approval of A is still honoured
  const orphan = join(designsDir(s), `${hashOf(B)}.json`);
  assert.ok(existsSync(orphan)); // documented: a harmless orphan
  const retry = okOf(reg(s, B));
  assert.deepEqual([retry.revision, retry.design, retry.outcome], [2, "reused", "updated"]);
});

test("register: the marker is set only after the design file exists and verifies", () => {
  const s = sandbox();
  let seen: { file: boolean; stateBefore: boolean } | undefined;
  const r = reg(s, A, {
    registerState: (...args: Parameters<typeof registerLocked>) => {
      seen = { file: existsSync(join(designsDir(s), `${hashOf(A)}.json`)), stateBefore: existsSync(stateFile(s)) };
      assert.equal(verifyStoredDesign(s.data, s.project, { designHash: hashOf(A) } as any).ok, true);
      return registerLocked(...args);
    },
  });
  okOf(r);
  assert.deepEqual(seen, { file: true, stateBefore: false }); // the file was there first; the state was not yet created
});

test("register: an existing valid content-addressed file is verified and reused, and never rewritten", () => {
  const s = sandbox();
  mkdirSync(designsDir(s), { recursive: true, mode: 0o700 });
  const file = join(designsDir(s), `${hashOf(A)}.json`);
  const pretty = JSON.stringify((parseSpecText(A) as any).spec, null, 4); // valid, same design, different bytes
  writeFileSync(file, pretty, { mode: 0o600 });
  const r = okOf(reg(s, A));
  assert.equal(r.design, "reused");
  assert.equal(readFileSync(file, "utf8"), pretty);
});

test("register: an existing corrupt, wrong or oversized file under the hash is refused and not overwritten", () => {
  for (const content of ["{", "", JSON.stringify((parseSpecText(B) as any).spec), " ".repeat(LIMITS.rawBytes + 1)]) {
    const s = sandbox();
    mkdirSync(designsDir(s), { recursive: true, mode: 0o700 });
    const file = join(designsDir(s), `${hashOf(A)}.json`);
    writeFileSync(file, content);
    failOf(reg(s, A), "design_file_conflict", "refused");
    assert.equal(readFileSync(file, "utf8"), content);
    assert.equal(existsSync(stateFile(s)), false); // no state was created or pointed at it
  }
});

test("register: symlinks and non-regular files in the design store are refused and nothing is followed", { skip: process.platform === "win32" }, () => {
  const elsewhere = tmp("elsewhere");
  writeFileSync(join(elsewhere, "real.json"), canonicalJson((parseSpecText(A) as any).spec));
  { // a symlink where the file belongs
    const s = sandbox();
    mkdirSync(designsDir(s), { recursive: true, mode: 0o700 });
    symlinkSync(join(elsewhere, "real.json"), join(designsDir(s), `${hashOf(A)}.json`));
    failOf(reg(s, A), "design_store_untrusted", "refused");
    assert.equal(existsSync(stateFile(s)), false);
  }
  { // a symlinked designs directory
    const s = sandbox();
    mkdirSync(paths(s.data, s.project).dir, { recursive: true });
    mkdirSync(join(elsewhere, "store"));
    symlinkSync(join(elsewhere, "store"), designsDir(s));
    failOf(reg(s, A), "design_store_untrusted", "refused");
    assert.deepEqual(readdirSync(join(elsewhere, "store")), []);
  }
  { // a directory, and a FIFO, where the file belongs
    const s = sandbox();
    mkdirSync(join(designsDir(s), `${hashOf(A)}.json`), { recursive: true });
    failOf(reg(s, A), "design_store_untrusted");
    const t = sandbox();
    mkdirSync(designsDir(t), { recursive: true });
    if (spawnSync("mkfifo", [join(designsDir(t), `${hashOf(A)}.json`)]).status === 0) failOf(reg(t, A), "design_store_untrusted");
  }
});

test("register: at the design cap a new design is refused (nothing deleted, state untouched), while reuse and no-ops still work", () => {
  const s = sandbox();
  okOf(reg(s, A));
  approveCurrent(s);
  for (let i = 0; readdirCount(s) < DESIGN_CAP; i++) writeFileSync(join(designsDir(s), `${String(i).padStart(64, "0")}.json`), "{}");
  writeFileSync(join(designsDir(s), "ignored.tmp"), "x"); // does not count
  const before = snapshot(s.data);
  failOf(reg(s, B), "design_cap_reached", "refused");
  assert.equal(snapshot(s.data), before);
  assert.equal(gate(s).decision, "allow");
  assert.equal(okOf(reg(s, A)).outcome, "unchanged"); // the registered design is already stored
  assert.equal(snapshot(s.data), before);
  // A design that is already stored does not need capacity: switch to it and back.
  rmSync(join(designsDir(s), `${String(0).padStart(64, "0")}.json`));
  okOf(reg(s, B)); // one slot free
  assert.equal(readdirSync(designsDir(s)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length, DESIGN_CAP);
  failOf(reg(s, variant("C")), "design_cap_reached");
  assert.equal(okOf(reg(s, A)).design, "reused"); // back to A at the cap: reuse needs no slot
});
const readdirCount = (s: Sandbox) => readdirSync(designsDir(s)).filter((n) => /^[0-9a-f]{64}\.json$/.test(n)).length;

test("register: a legacy (unmarked) registration of the same hash is refused until the developer resets", () => {
  const s = sandbox();
  registerDesign(s.data, s.project, (parseSpecText(A) as any).spec); // the old way: same hash, no marker, no stored file
  approveCurrent(s);
  const before = snapshot(s.data);
  failOf(reg(s, A), "legacy_registration", "refused");
  assert.equal(snapshot(s.data), before);
  assert.equal(existsSync(designsDir(s)), false);
  reset(s.data, s.project);
  assert.equal(okOf(reg(s, A)).outcome, "created");
});

test("register: an identical registration does not silently repair a canonical state whose stored design is gone", () => {
  const s = sandbox();
  const r = okOf(reg(s, A));
  approveCurrent(s);
  rmSync(join(designsDir(s), `${r.hash}.json`));
  const before = snapshot(s.data);
  failOf(reg(s, A), "stored_design_unverifiable", "refused");
  assert.equal(snapshot(s.data), before);
  assert.equal((gate(s) as any).status, "INVALID"); // still blocked, still needs the developer
});

test("register: recovery through reset, then register and approve again", () => {
  const s = sandbox();
  const r = okOf(reg(s, A));
  approveCurrent(s);
  writeFileSync(join(designsDir(s), `${r.hash}.json`), "{}"); // corrupt the approved design
  assert.equal(gate(s).decision, "deny");
  failOf(reg(s, A), "stored_design_unverifiable");
  assert.ok(reset(s.data, s.project).quarantinedTo);
  failOf(reg(s, A), "design_file_conflict"); // the corrupt file is never overwritten; the developer removes it
  rmSync(join(designsDir(s), `${r.hash}.json`));
  const again = okOf(reg(s, A));
  assert.deepEqual([again.outcome, again.revision, again.design], ["created", 1, "written"]);
  assert.equal(gate(s).decision, "deny"); // nothing is approved after a reset
  approveCurrent(s);
  assert.equal(gate(s).decision, "allow");
});

test("register: the real hook agrees: registered and unapproved blocks, approval unlocks, a changed design blocks again", () => {
  const s = sandbox();
  okOf(reg(s, A));
  assert.match(pre(s, "Write", w).stdout, /"permissionDecision":"deny"/);
  const out = prompt(s, `prevue approve ${EXAMPLE_HASH.slice(0, 12)}`).stdout;
  assert.match(out, /approved by the developer/);
  assert.equal(pre(s, "Write", w).stdout, "");
  okOf(reg(s, B));
  assert.match(pre(s, "Write", w).stdout, /"permissionDecision":"deny"/);
  assert.match(prompt(s, `prevue approve ${EXAMPLE_HASH.slice(0, 12)}`).stdout, /REJECTED/); // the old hash no longer matches
});

/** Runs the real CLI `register-design` as a separate process (shares the state lock across processes). */
const CLI = join(import.meta.dirname, "..", "src", "cli.js");
const runCli = (s: Sandbox, file: string) =>
  new Promise<{ code: number | null; out: any }>((resolve) => {
    const p = spawn("node", [CLI, "register-design", file, s.project], { env: { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: s.data } });
    let out = "";
    p.stdout.on("data", (c) => (out += c));
    p.on("close", (code) => resolve({ code, out: JSON.parse(out || "null") }));
  });
const specFile = (dir: string, name: string, text: string): string => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

test("register: eight concurrent registrations of different designs get eight distinct revisions and eight verified files", async () => {
  const s = sandbox();
  const d = tmp("specs");
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => runCli(s, specFile(d, `${i}.json`, variant(`Concurrent ${i}`)))));
  assert.ok(results.every((r) => r.code === 0 && r.out.registered === true), JSON.stringify(results));
  assert.deepEqual(results.map((r) => r.out.revision).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.revision, l.state.canonical, l.state.approvedRevision], ["PENDING", 8, true, null]);
  assert.equal(readdirCount(s), 8);
  assert.deepEqual(verifyStoredDesign(s.data, s.project, l.state), { ok: true });
  assert.ok(!existsSync(paths(s.data, s.project).lock)); // no stale lock
  assert.deepEqual(readdirSync(designsDir(s)).filter((n) => n.endsWith(".tmp")), []);
});

test("register: eight concurrent registrations of the same design change the state exactly once", async () => {
  const s = sandbox();
  const f = specFile(tmp("specs"), "a.json", A);
  const results = await Promise.all(Array.from({ length: 8 }, () => runCli(s, f)));
  assert.ok(results.every((r) => r.code === 0), JSON.stringify(results));
  assert.equal(results.filter((r) => r.out.changed).length, 1);
  assert.ok(results.every((r) => r.out.revision === 1));
  assert.equal((load(s.data, s.project) as any).state.revision, 1);
  assert.equal(readdirCount(s), 1);
});

test("register: concurrent registrations cannot exceed the design cap", async () => {
  const s = sandbox();
  const d = tmp("specs");
  okOf(reg(s, A));
  for (let i = 0; readdirCount(s) < DESIGN_CAP - 2; i++) writeFileSync(join(designsDir(s), `${String(i).padStart(64, "0")}.json`), "{}");
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => runCli(s, specFile(d, `${i}.json`, variant(`Cap ${i}`)))));
  assert.equal(results.filter((r) => r.code === 0).length, 2);
  assert.equal(results.filter((r) => r.code === 3 && r.out.code === "design_cap_reached").length, 4);
  assert.equal(readdirCount(s), DESIGN_CAP);
  assert.equal((load(s.data, s.project) as any).state.revision, 3); // A, then the two that fit
});
