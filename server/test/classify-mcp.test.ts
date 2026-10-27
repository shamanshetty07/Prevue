import { strict as assert } from "node:assert";
import { test } from "node:test";
import { classifyPending } from "../src/classify.js";
import { evaluate } from "../src/gate.js";
import { initIfMissing } from "../src/state.js";
import { env, sandbox } from "./helpers.js";

const allowed = (name: unknown, input: unknown = {}) => classifyPending(name, input).allow;
const P = "mcp__plugin_prevue_prevue__";

test("classification: the known read-only Prevue tools are allowed, by exact name", () => {
  assert.equal(allowed(`${P}prevue_ping`), true);
  assert.equal(allowed(`${P}prevue_validate_spec`, { spec: "{}" }), true);
  assert.equal(allowed("mcp__ide__getDiagnostics"), true);
});

test("classification: tools that do not exist yet are denied (registration, approval, reset, anything new)", () => {
  for (const t of ["prevue_register_design", "prevue_approve", "prevue_reset", "prevue_status", "prevue_anything_new"]) assert.equal(allowed(`${P}${t}`), false, t);
  assert.equal(allowed(P), false);
});

test("classification: sharing a prefix or resembling an allowed name grants nothing", () => {
  for (const t of [
    `${P}prevue_ping2`, `${P}prevue_ping_`, `${P}prevue_ping__x`, `${P}prevue_pin`, `${P}prevue_validate_spec2`, `${P}prevue_validate_spec_and_register`,
    `${P}prevue_ping `, ` ${P}prevue_ping`, `${P}prevue_ping\n`, `${P}prevue_ping\0`, `${P}PREVUE_PING`, `${P}prevue_validate_spec/`,
    "mcp__plugin_prevue_prevue_prevue_ping", "mcp__plugin_prevue_prevueX__prevue_ping", "mcp__plugin_prevue2_prevue__prevue_ping", "mcp__plugin_other_prevue__prevue_ping",
    "mcp__prevue__prevue_ping", "mcp__plugin_prevue_prevue", "plugin_prevue_prevue__prevue_ping", "MCP__plugin_prevue_prevue__prevue_ping",
    "mcp__ide__getDiagnostics2", "mcp__ide__getDiagnostics ", "mcp__ide__executeCode", "mcp__ide__",
  ]) assert.equal(allowed(t), false, JSON.stringify(t));
});

test("classification: existing read-only tools and default deny are unchanged", () => {
  for (const t of ["Read", "Glob", "Grep", "LSP", "ToolSearch", "WebSearch", "WebFetch", "AskUserQuestion", "Skill", "ListMcpResourcesTool", "EnterPlanMode", "ExitPlanMode", "CronList", "TaskList"]) assert.equal(allowed(t), true, t);
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit", "FutureTool", "mcp__random__do_it", "mcp__claude_ai_Google_Drive__create_file", "", undefined, null, 42, {}]) assert.equal(allowed(t), false, String(t));
  assert.equal(allowed("Bash", { command: "ls" }), true);
  assert.equal(allowed("Bash", { command: "touch x" }), false);
});

test("classification: through the gate, while PENDING, only the exact Prevue tools pass", () => {
  const s = sandbox();
  initIfMissing(s.data, s.project);
  const d = (t: string) => evaluate(env(s), t, {}).decision;
  assert.equal(d(`${P}prevue_ping`), "allow");
  assert.equal(d(`${P}prevue_validate_spec`), "allow");
  assert.equal(d(`${P}prevue_register_design`), "deny");
  assert.equal(d(`${P}prevue_ping2`), "deny");
});
