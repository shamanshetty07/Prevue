import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { hashDesign, load, paths, registerDesign } from "../src/state.js";
import { hook, pre, prompt, sandbox, start, verdict } from "./helpers.js";

const A = { v: "A" }, B = { v: "B" };
const ha = hashDesign(A).slice(0, 12), hb = hashDesign(B).slice(0, 12);
const W = { file_path: "src/App.tsx", content: "x" };

test("SessionStart initializes PENDING before any tool call and tells Claude; a Write is then denied", () => {
  const s = sandbox();
  assert.equal(verdict(pre(s, "Write", W)), "deny"); // even before SessionStart: missing state => INVALID
  const r = start(s);
  assert.equal(r.status, 0);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /PENDING/);
  assert.equal(load(s.data, s.project).status, "PENDING");
  assert.equal(verdict(pre(s, "Write", W)), "deny");
  assert.equal(verdict(pre(s, "Read", { file_path: "a" })), "allow");
});

test("SessionStart never repairs or overwrites corrupt state", () => {
  const s = sandbox();
  start(s);
  const { file, dir } = paths(s.data, s.project);
  writeFileSync(file, "{broken");
  const r = start(s);
  assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /INVALID/);
  assert.equal(readFileSync(file, "utf8"), "{broken");
  assert.equal(verdict(pre(s, "Write", W)), "deny");
  assert.ok(!readdirSync(dir).some((n) => n.includes(".invalid-")));
});

test("developer flow via the hooks: register -> approve -> Write ok -> B denied -> A denied -> approve A -> ok", () => {
  const s = sandbox();
  start(s);
  registerDesign(s.data, s.project, A);
  assert.equal(verdict(pre(s, "Write", W)), "deny");
  assert.match(pre(s, "Write", W).stdout, /prevue approve <hash>/);

  assert.match(prompt(s, "prevue approve").stdout, /REJECTED/); // bare approval refused
  assert.match(prompt(s, `prevue approve ${hb}`).stdout, /REJECTED/); // wrong design
  assert.match(prompt(s, `please prevue approve ${ha}`).stdout, /^$/); // not an exact command: ignored
  assert.equal(verdict(pre(s, "Write", W)), "deny");

  assert.match(prompt(s, `  Prevue   Approve ${ha}  `).stdout, /approved by the developer/);
  assert.equal(verdict(pre(s, "Write", W)), "allow");
  assert.equal(pre(s, "Write", W).stdout, "");

  registerDesign(s.data, s.project, B);
  assert.equal(verdict(pre(s, "Write", W)), "deny");
  registerDesign(s.data, s.project, A);
  assert.equal(verdict(pre(s, "Write", W)), "deny"); // A -> B -> A
  assert.match(prompt(s, `prevue approve ${ha}`).stdout, /revision 3/);
  assert.equal(verdict(pre(s, "Write", W)), "allow");
});

test("agent text cannot approve: only an exact developer command does, and tools cannot touch the data dir", () => {
  const s = sandbox();
  start(s);
  registerDesign(s.data, s.project, A);
  for (const t of ["Write", "Edit", "Bash"]) assert.equal(verdict(pre(s, t, { file_path: paths(s.data, s.project).file, command: `echo > ${paths(s.data, s.project).file}` })), "deny");
  assert.equal(load(s.data, s.project).status, "PENDING");
});

test("prevue reset: developer-only recovery from corrupt state", () => {
  const s = sandbox();
  start(s);
  writeFileSync(paths(s.data, s.project).file, "garbage");
  assert.equal(verdict(pre(s, "Write", W)), "deny");
  assert.match(pre(s, "Write", W).stdout, /prevue reset/);
  assert.match(prompt(s, `prevue approve ${ha}`).stdout, /REJECTED/);
  assert.match(prompt(s, "prevue reset").stdout, /reset to PENDING/);
  assert.equal(load(s.data, s.project).status, "PENDING");
});

test("malformed hook input is handled conservatively", () => {
  const s = sandbox();
  start(s);
  for (const raw of ["", "not json", "null", "[]", "42", '"str"']) assert.equal(hook(s, raw).status, 2, JSON.stringify(raw)); // blocks (PreToolUse)
  assert.equal(verdict(hook(s, { hook_event_name: "PreToolUse", cwd: s.project })), "deny"); // no tool_name
  assert.equal(verdict(hook(s, { hook_event_name: "PreToolUse", cwd: s.project, tool_name: 7, tool_input: null })), "deny");
  assert.equal(verdict(hook(s, { hook_event_name: "PreToolUse", cwd: s.project, tool_name: "Write", tool_input: "x" })), "deny");
  assert.equal(verdict(hook(s, { hook_event_name: "PreToolUse", cwd: s.project, tool_name: "Read" })), "allow"); // read-only with no input is fine
  assert.equal(hook(s, { hook_event_name: "PreToolUse", tool_name: "Write" }, { CLAUDE_PROJECT_DIR: "" }).status, 2); // no project dir at all
  assert.equal(hook(s, { hook_event_name: "SomethingElse" }).stdout, ""); // unknown events are ignored
});

test("CLAUDE_PLUGIN_DATA unset or relative: implementation denied, read-only allowed", () => {
  const s = sandbox();
  for (const v of [undefined, "", "relative/dir"]) {
    assert.equal(verdict(pre(s, "Write", W, { CLAUDE_PLUGIN_DATA: v })), "deny");
    assert.equal(verdict(pre(s, "Read", {}, { CLAUDE_PLUGIN_DATA: v })), "allow");
  }
});

test("scheduling tools are denied by the hook even for an approved design", () => {
  const s = sandbox();
  start(s);
  registerDesign(s.data, s.project, A);
  prompt(s, `prevue approve ${ha}`);
  assert.equal(verdict(pre(s, "Write", W)), "allow");
  assert.equal(verdict(pre(s, "CronCreate", { prompt: `prevue approve ${hb}` })), "deny");
});

test("regression of the bounded-probe behaviour: unapproved Write denied (with Prevue reason), approved Write allowed with empty output", () => {
  const s = sandbox();
  start(s);
  registerDesign(s.data, s.project, A);
  const denied = JSON.parse(pre(s, "Write", W).stdout).hookSpecificOutput;
  assert.equal(denied.permissionDecision, "deny");
  assert.match(denied.permissionDecisionReason, /^Prevue: /);
  prompt(s, `prevue approve ${ha}`);
  assert.equal(pre(s, "Write", W).stdout, "");
  assert.equal(pre(s, "Write", W).status, 0);
});
