import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { approve, evaluate, isReadOnlyBash, readState, setDesign } from "../src/gate.js";

const proj = () => mkdtempSync(join(tmpdir(), "prevue-gate-"));
const HOOK = join(import.meta.dirname, "..", "src", "hook.js");
const hook = (dir: string, payload: object) =>
  spawnSync("node", [HOOK], { input: JSON.stringify({ cwd: dir, ...payload }), env: { ...process.env, CLAUDE_PROJECT_DIR: dir }, encoding: "utf8" });
const write = { file_path: "src/App.tsx", content: "x" };

test("gate inactive without a registered design", () => {
  assert.equal(evaluate(proj(), "Write", write).decision, "allow");
});

test("S1: unapproved design blocks file-writing tools", () => {
  const d = proj();
  setDesign(d, { screen: "dashboard" });
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) assert.equal(evaluate(d, t, write).decision, "deny", t);
  assert.equal(evaluate(d, "Read", { file_path: "a" }).decision, "allow");
});

test("S2: approval of current design unblocks; wrong hash is rejected", () => {
  const d = proj();
  const s = setDesign(d, { screen: "dashboard" });
  assert.throws(() => approve(d, "deadbeef"), /does not match/);
  assert.equal(evaluate(d, "Write", write).decision, "deny");
  approve(d, s.designHash.slice(0, 12));
  assert.equal(evaluate(d, "Write", write).decision, "allow");
  assert.equal(evaluate(d, "Bash", { command: "npm run build" }).decision, "allow");
});

test("S3: changing the design after approval revokes it; identical design keeps it", () => {
  const d = proj();
  setDesign(d, { a: 1 });
  approve(d);
  setDesign(d, { a: 1 }); // same content, key order irrelevant
  assert.equal(evaluate(d, "Write", write).decision, "allow");
  setDesign(d, { a: 2 });
  assert.equal(evaluate(d, "Write", write).decision, "deny");
  assert.equal(readState(d)?.designVersion, 3);
});

test("S4: shell paths that write files are denied while unapproved", () => {
  const d = proj();
  setDesign(d, { a: 1 });
  const writers = [
    "echo hi > src/App.tsx", "echo hi >> a.txt", "cat a | tee b", "sed -i s/a/b/ f", "python3 -c 'open(1)'",
    "node -e 'fs.writeFileSync()'", "git apply p.diff", "git checkout -- .", "cp a b", "mv a b", "touch a", "rm a",
    "npm install", "ls; touch a", "ls && touch a", "ls $(touch a)", "ls `touch a`", "find . -delete", "find . -exec touch {} +",
    "git diff --output=out.txt", "printf x | sh", "bash -c 'touch a'", "cat <<EOF\nx\nEOF", "ls\ntouch a",
  ];
  for (const command of writers) assert.equal(evaluate(d, "Bash", { command }).decision, "deny", command);
  for (const command of ["ls -la", "git status", "git diff HEAD", "cat package.json", "grep -rn foo src", "find . -name '*.ts'"])
    assert.equal(evaluate(d, "Bash", { command }).decision, "allow", command);
  assert.equal(isReadOnlyBash(""), false);
});

test("agent cannot tamper with approval state, even when approved", () => {
  const d = proj();
  setDesign(d, { a: 1 });
  approve(d);
  assert.equal(evaluate(d, "Write", { file_path: join(d, ".prevue", "state.json"), content: "{}" }).decision, "deny");
  assert.equal(evaluate(d, "Edit", { file_path: ".prevue/state.json" }).decision, "deny");
  assert.equal(evaluate(d, "Bash", { command: "rm -rf .prevue" }).decision, "deny");
  assert.equal(evaluate(d, "Bash", { command: "cat .prevue/state.json" }).decision, "allow");
});

test("KNOWN LIMITATION: obfuscated .prevue path in Bash is not caught while approved", () => {
  const d = proj();
  setDesign(d, { a: 1 });
  approve(d);
  // Once approved, Bash is unrestricted, so a glob can reach the state file. Documented in docs/ENFORCEMENT.md.
  assert.equal(evaluate(d, "Bash", { command: "rm -rf .pre*" }).decision, "allow");
});

test("corrupt state throws (callers fail closed)", () => {
  const d = proj();
  mkdirSync(join(d, ".prevue"));
  writeFileSync(join(d, ".prevue", "state.json"), "{not json");
  assert.throws(() => evaluate(d, "Write", write));
  const r = hook(d, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: write });
  assert.equal(r.status, 2);
});

test("hook process: PreToolUse deny JSON and UserPromptSubmit approval", () => {
  const d = proj();
  const s = setDesign(d, { a: 1 });
  const pre = () => hook(d, { hook_event_name: "PreToolUse", tool_name: "Write", tool_input: write });
  assert.equal(JSON.parse(pre().stdout).hookSpecificOutput.permissionDecision, "deny");

  const bad = hook(d, { hook_event_name: "UserPromptSubmit", prompt: "prevue approve abcdef12" });
  assert.match(JSON.parse(bad.stdout).hookSpecificOutput.additionalContext, /REJECTED/);
  assert.ok(pre().stdout.includes("deny")); // still denied after rejected approval

  hook(d, { hook_event_name: "UserPromptSubmit", prompt: "please prevue approve" }); // not an exact phrase
  assert.ok(pre().stdout.includes("deny"));

  const ok = hook(d, { hook_event_name: "UserPromptSubmit", prompt: `prevue approve ${s.designHash.slice(0, 12)}` });
  assert.match(JSON.parse(ok.stdout).hookSpecificOutput.additionalContext, /approved by the developer/);
  assert.equal(pre().stdout, "");
});
