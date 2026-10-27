import { strict as assert } from "node:assert";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { classifyPending, isPendingRegistration, REGISTER_DESIGN_TOOL } from "../src/classify.js";
import { evaluate } from "../src/gate.js";
import { registerCanonical } from "../src/register.js";
import { approve, initIfMissing, load, paths, registerDesign, reset } from "../src/state.js";
import { env, pre, prompt, sandbox, start, type Sandbox } from "./helpers.js";

const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const HASH = "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5";
const variant = (name: string): string => JSON.stringify({ ...JSON.parse(exampleText), screen: { ...JSON.parse(exampleText).screen, name } });
const A = exampleText;
const B = variant("Dashboard B");
const P = "mcp__plugin_prevue_prevue__";
const w = { file_path: "src/App.tsx", content: "x" };
const E = (s: Sandbox): NodeJS.ProcessEnv => ({ CLAUDE_PLUGIN_DATA: s.data, CLAUDE_PROJECT_DIR: s.project });

/** What Claude Code does for a tool call: PreToolUse decides; only an allowed call reaches the server. */
function claudeCalls(s: Sandbox, spec: string) {
  const g = evaluate(env(s), REGISTER_DESIGN_TOOL, { spec });
  return g.decision === "allow" ? { gate: g, result: registerCanonical(E(s), spec) } : { gate: g, result: null as null };
}
const pending = (): Sandbox => {
  const s = sandbox();
  initIfMissing(s.data, s.project); // SessionStart does this
  return s;
};
const writeDecision = (s: Sandbox) => evaluate(env(s), "Write", w);
const developerApproves = (s: Sandbox, hash: string) => prompt(s, `prevue approve ${hash.slice(0, 12)}`).stdout;

test("pending registration: the exact tool is allowed while PENDING, with exactly the documented input", () => {
  const s = pending();
  assert.equal(evaluate(env(s), REGISTER_DESIGN_TOOL, { spec: A }).decision, "allow");
  // The real hook agrees: an allowed call prints nothing.
  assert.equal(pre(s, REGISTER_DESIGN_TOOL, { spec: A }).stdout, "");
  // It is allowed by its own rule, not because it is read-only.
  assert.equal(classifyPending(REGISTER_DESIGN_TOOL, { spec: A }).allow, false);
});

test("pending registration: any other input shape is denied, so nothing can ride along", () => {
  const s = pending();
  for (const input of [undefined, null, [], "spec", 42, {}, { spec: 1 }, { spec: null }, { spec: {} }, { spec: A, extra: 1 }, { spec: A, file_path: "x" }, { Spec: A }, { spec: "x".repeat(10 * 64 * 1024 + 1) }]) {
    assert.equal(evaluate(env(s), REGISTER_DESIGN_TOOL, input).decision, "deny", JSON.stringify(input)?.slice(0, 60));
    assert.equal(isPendingRegistration(REGISTER_DESIGN_TOOL, input), false);
  }
});

test("pending registration: near-match and unknown Prevue tools stay denied while PENDING", () => {
  const s = pending();
  const name = REGISTER_DESIGN_TOOL;
  for (const t of [`${name}2`, `${name}_`, `${name} `, ` ${name}`, `${name}\n`, `${name}\0`, `${name}/x`, name.toUpperCase(), `${P}PREVUE_REGISTER_DESIGN`, `${P}prevue_register`, `${P}prevue_registerdesign`, `${P}prevue_register_designs`, `${P}prevue_approve`, `${P}prevue_approve_design`, `${P}prevue_reset`, `${P}prevue_unknown`, "mcp__prevue__prevue_register_design", "mcp__plugin_prevue2_prevue__prevue_register_design", "mcp__plugin_prevue_other__prevue_register_design", "mcp__plugin_other_prevue__prevue_register_design", "prevue_register_design"]) {
    assert.equal(evaluate(env(s), t, { spec: A }).decision, "deny", JSON.stringify(t));
  }
  // The pre-existing read-only tools keep behaving exactly as before.
  for (const t of ["Read", `${P}prevue_ping`, `${P}prevue_validate_spec`]) assert.equal(evaluate(env(s), t, {}).decision, "allow", t);
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "FutureTool"]) assert.equal(evaluate(env(s), t, w).decision, "deny", t);
});

test("pending registration: it is never allowed for INVALID state, and registration does not recover INVALID state", () => {
  const input = { spec: A };
  const noState = sandbox(); // missing state
  assert.equal(evaluate(env(noState), REGISTER_DESIGN_TOOL, input).decision, "deny");
  assert.equal(evaluate({ ...env(noState), dataDir: undefined }, REGISTER_DESIGN_TOOL, input).decision, "deny"); // no CLAUDE_PLUGIN_DATA

  const malformed = pending();
  writeFileSync(paths(malformed.data, malformed.project).file, "{");
  assert.equal(evaluate(env(malformed), REGISTER_DESIGN_TOOL, input).decision, "deny");
  // Even if the call were made (a direct call, not through the gate), the core refuses and leaves the file as it was.
  const r = registerCanonical(E(malformed), A);
  assert.deepEqual([r.ok, (r as any).code], [false, "state_invalid"]);
  assert.equal(readFileSync(paths(malformed.data, malformed.project).file, "utf8"), "{");

  const foreign = pending();
  const f = paths(foreign.data, foreign.project).file;
  writeFileSync(f, JSON.stringify({ ...JSON.parse(readFileSync(f, "utf8")), project: "0".repeat(32) }));
  assert.equal(evaluate(env(foreign), REGISTER_DESIGN_TOOL, input).decision, "deny");
});

test("pending registration: an APPROVED state whose canonical design is broken is INVALID, so registration is denied until the developer resets", () => {
  const s = pending();
  const r = registerCanonical(E(s), A) as any;
  approve(s.data, s.project, r.hash.slice(0, 12));
  rmSync(join(paths(s.data, s.project).dir, "designs", `${r.hash}.json`));
  assert.equal((evaluate(env(s), "Write", w) as any).status, "INVALID");
  assert.equal(evaluate(env(s), REGISTER_DESIGN_TOOL, { spec: B }).decision, "deny");
  reset(s.data, s.project); // the developer-controlled recovery
  assert.equal(evaluate(env(s), REGISTER_DESIGN_TOOL, { spec: B }).decision, "allow");
});

test("workflow: Claude registers while PENDING, the gate stays PENDING, only the developer's approval unlocks implementation", () => {
  const s = pending();
  assert.equal(writeDecision(s).decision, "deny"); // nothing registered yet

  const first = claudeCalls(s, A);
  assert.equal(first.gate.decision, "allow");
  const r = first.result as any;
  assert.deepEqual([r.ok, r.registered, r.approvedByThisCall, r.outcome, r.revision, r.status, r.hash], [true, true, false, "created", 1, "PENDING", HASH]);

  // Registration approved nothing.
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.approvedRevision, l.state.approvedHash, l.state.approvedAt, l.state.canonical], ["PENDING", null, null, null, true]);
  for (const [tool, input] of [["Write", w], ["Edit", w], ["MultiEdit", w], ["NotebookEdit", { notebook_path: "a.ipynb" }], ["Bash", { command: "npm run build" }], ["Bash", { command: "echo hi > src/a.ts" }]] as const) {
    const d = evaluate(env(s), tool, input) as any;
    assert.deepEqual([d.decision, d.status], ["deny", "PENDING"], tool);
  }
  assert.match(pre(s, "Write", w).stdout, /"permissionDecision":"deny"/);

  // Claude cannot approve through any tool: there is no such tool, and a look-alike is denied.
  for (const t of [`${P}prevue_approve`, `${P}prevue_approve_design`]) assert.equal(evaluate(env(s), t, { hash: HASH }).decision, "deny");

  // The developer approves that exact revision.
  assert.match(developerApproves(s, HASH), /approved by the developer/);
  assert.equal(pre(s, "Write", w).stdout, ""); // the hook now allows protected writes
  assert.equal((evaluate(env(s), "Write", w) as any).status, "APPROVED");
  assert.match(start(s).stdout, /APPROVED/);
});

test("workflow: approval is bound to the hash and revision that the developer names", () => {
  const s = pending();
  claudeCalls(s, A);
  assert.match(developerApproves(s, "f".repeat(12)), /REJECTED/); // a hash that is not the registered design
  assert.equal(writeDecision(s).decision, "deny");
  assert.match(prompt(s, "prevue approve").stdout, /REJECTED/); // the hash is mandatory
  assert.equal(writeDecision(s).decision, "deny");
});

test("workflow: after approval, any design change returns the project to PENDING and blocks writes again", () => {
  const s = pending();
  claudeCalls(s, A);
  developerApproves(s, HASH);
  assert.equal(writeDecision(s).decision, "allow");

  const change = claudeCalls(s, B); // allowed in APPROVED too, by the existing policy
  assert.equal(change.gate.decision, "allow");
  assert.deepEqual([(change.result as any).revision, (change.result as any).status, (change.result as any).outcome], [2, "PENDING", "updated"]);
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.approvedRevision], ["PENDING", null]);
  assert.equal(writeDecision(s).decision, "deny");
  assert.match(developerApproves(s, HASH), /REJECTED/); // the old hash no longer matches the registered design
  assert.equal(writeDecision(s).decision, "deny");
});

test("workflow: A -> B -> A through the gate creates three revisions and never revives the first approval", () => {
  const s = pending();
  claudeCalls(s, A);
  developerApproves(s, HASH);
  assert.equal(writeDecision(s).decision, "allow");
  claudeCalls(s, B);
  const third = claudeCalls(s, A).result as any;
  assert.deepEqual([third.revision, third.status, third.design], [3, "PENDING", "reused"]);
  assert.equal(writeDecision(s).decision, "deny");
  assert.equal((load(s.data, s.project) as any).state.approvedRevision, null);
  assert.match(developerApproves(s, HASH), /approved by the developer/);
  assert.equal((load(s.data, s.project) as any).state.approvedRevision, 3);
  assert.equal(writeDecision(s).decision, "allow");
});

test("workflow: registering the identical design while PENDING or APPROVED keeps the existing idempotency", () => {
  const s = pending();
  claudeCalls(s, A);
  const again = claudeCalls(s, JSON.stringify(JSON.parse(A), null, 2)).result as any;
  assert.deepEqual([again.outcome, again.changed, again.revision], ["unchanged", false, 1]);
  developerApproves(s, HASH);
  const approvedAgain = claudeCalls(s, A).result as any;
  assert.deepEqual([approvedAgain.outcome, approvedAgain.status], ["unchanged", "APPROVED"]);
  assert.equal(writeDecision(s).decision, "allow"); // an identical registration does not revoke a valid approval
});

test("workflow: invalid specifications are allowed through the gate but can never become a design", () => {
  const s = pending();
  for (const bad of ["{", '{"schemaVersion":2}', A.replace('"name": "Expense dashboard"', '"name": "a", "name": "b"')]) {
    const c = claudeCalls(s, bad);
    assert.equal(c.gate.decision, "allow"); // the gate does not judge content
    assert.equal((c.result as any).registered, false);
  }
  assert.equal((load(s.data, s.project) as any).state.revision, 0);
  assert.equal((load(s.data, s.project) as any).state.designHash, null);
  assert.equal(writeDecision(s).decision, "deny");
});

test("workflow: a failed state transition cannot leave the project approved for the wrong design", () => {
  const s = pending();
  claudeCalls(s, A);
  developerApproves(s, HASH);
  const r = registerCanonical(E(s), B, undefined, { registerState: () => { throw new Error("disk full"); } }) as any;
  assert.equal(r.code, "state_write_failed");
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.approvedHash, l.state.designHash], ["APPROVED", HASH, HASH]); // still the design the developer approved
  assert.equal(writeDecision(s).decision, "allow");
  // And a registration that stored B but never recorded it did not approve B.
  assert.notEqual(l.state.approvedHash, (registerCanonical(E(s), B, undefined, { registerState: () => { throw new Error("x"); } }) as any).hash);
});

test("workflow: environment problems fail safely and leave a PENDING project exactly as it was", () => {
  const s = pending();
  const before = readFileSync(paths(s.data, s.project).file, "utf8");
  for (const e of [{}, { CLAUDE_PLUGIN_DATA: "" , CLAUDE_PROJECT_DIR: s.project }, { CLAUDE_PLUGIN_DATA: "rel", CLAUDE_PROJECT_DIR: s.project }, { CLAUDE_PLUGIN_DATA: s.data }, { CLAUDE_PLUGIN_DATA: s.data, CLAUDE_PROJECT_DIR: "rel" }]) {
    const r = registerCanonical(e as NodeJS.ProcessEnv, A) as any;
    assert.equal(r.registered, false);
    assert.equal(r.kind, "config_error");
  }
  assert.equal(readFileSync(paths(s.data, s.project).file, "utf8"), before);
});

test("workflow: the legacy register stand-in and the old harness path are unaffected by the new rule", () => {
  const s = pending();
  registerDesign(s.data, s.project, { screen: "phase 0 design" });
  assert.equal(writeDecision(s).decision, "deny");
  assert.equal(evaluate(env(s), REGISTER_DESIGN_TOOL, { spec: A }).decision, "allow");
});
