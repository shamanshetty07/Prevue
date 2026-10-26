import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isReadOnlyShell } from "../src/classify.js";
import { evaluate } from "../src/gate.js";
import { approve, hashDesign, initIfMissing, registerDesign, paths } from "../src/state.js";
import { env, sandbox } from "./helpers.js";
import { join } from "node:path";
import { symlinkSync, mkdirSync } from "node:fs";

const A = { v: "A" };
const ha = hashDesign(A).slice(0, 12);
const w = { file_path: "src/App.tsx", content: "x" };
const decide = (s: ReturnType<typeof sandbox>, tool: unknown, input: unknown = {}) => evaluate(env(s), tool, input).decision;

const pending = () => { const s = sandbox(); initIfMissing(s.data, s.project); return s; };
const approved = () => { const s = sandbox(); registerDesign(s.data, s.project, A); approve(s.data, s.project, ha); return s; };

test("missing state does not allow implementation (INVALID blocks), read-only still works", () => {
  const s = sandbox(); // no state at all
  assert.equal(evaluate(env(s), "Write", w).status, "INVALID");
  assert.equal(decide(s, "Write", w), "deny");
  assert.equal(decide(s, "Bash", { command: "npm run build" }), "deny");
  assert.equal(decide(s, "Read", { file_path: "a" }), "allow");
});

test("unset or relative CLAUDE_PLUGIN_DATA is INVALID, not 'no gate'", () => {
  const s = sandbox();
  assert.equal(evaluate({ ...env(s), dataDir: undefined }, "Write", w).decision, "deny");
  assert.equal(evaluate({ ...env(s), dataDir: "" }, "Edit", w).decision, "deny");
});

test("PENDING denies every file-modifying tool", () => {
  const s = pending();
  for (const t of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) assert.equal(decide(s, t, w), "deny", t);
});

test("approved Write/Edit/Bash are allowed (existing behaviour preserved)", () => {
  const s = approved();
  for (const [t, i] of [["Write", w], ["Edit", w], ["NotebookEdit", { notebook_path: "a.ipynb" }], ["Bash", { command: "npm run build" }], ["SomeNewTool", {}]] as const)
    assert.equal(decide(s, t, i), "allow", t);
});

test("A -> B -> A through the gate: denied again until re-approved", () => {
  const s = approved();
  registerDesign(s.data, s.project, { v: "B" });
  assert.equal(decide(s, "Write", w), "deny");
  registerDesign(s.data, s.project, A);
  assert.equal(decide(s, "Write", w), "deny");
  approve(s.data, s.project, ha);
  assert.equal(decide(s, "Write", w), "allow");
});

test("unknown tools, unknown MCP tools and malformed names are denied while PENDING", () => {
  const s = pending();
  for (const t of ["FutureTool", "mcp__random__do_it", "mcp__claude_ai_Google_Drive__create_file", "mcp__ide__executeCode", "PowerShell", "Workflow", "EnterWorktree", "ExitWorktree", "PushNotification", "TaskStop", "DesignSync", "Artifact", "SendUserFile", "ReportFindings", "SendFeedback", "CronDelete"])
    assert.equal(decide(s, t, {}), "deny", String(t));
  for (const t of [undefined, null, 42, "", {}, ["Read"]]) assert.equal(decide(s, t, {}), "deny", JSON.stringify(t));
});

test("known read-only tools and Prevue's own MCP tools stay available while PENDING", () => {
  const s = pending();
  for (const t of ["Read", "Glob", "Grep", "LSP", "ToolSearch", "WebSearch", "WebFetch", "AskUserQuestion", "Skill", "ListMcpResourcesTool", "mcp__plugin_prevue_prevue__prevue_ping", "mcp__ide__getDiagnostics", "EnterPlanMode", "ExitPlanMode", "CronList"])
    assert.equal(decide(s, t, {}), "allow", t);
});

test("Monitor is classified by its command; WebSocket-only monitors are denied", () => {
  const s = pending();
  assert.equal(decide(s, "Monitor", { command: "tail -f app.log" }), "allow");
  assert.equal(decide(s, "Monitor", { command: "echo hi > src/a.ts" }), "deny");
  assert.equal(decide(s, "Monitor", { command: "touch x" }), "deny");
  assert.equal(decide(s, "Monitor", { url: "wss://example.com" }), "deny");
  assert.equal(decide(s, "Monitor", undefined), "deny");
});

test("Agent: allowed (its own tool calls are hooked) unless it requests worktree isolation or input is malformed", () => {
  const s = pending();
  assert.equal(decide(s, "Agent", { prompt: "research" }), "allow");
  assert.equal(decide(s, "Task", { prompt: "research" }), "allow");
  assert.equal(decide(s, "Agent", { prompt: "x", isolation: "worktree" }), "deny");
  assert.equal(decide(s, "Agent", "nope"), "deny");
});

test("scheduling / cross-session tools are denied in EVERY state (they can forge a developer turn)", () => {
  for (const s of [pending(), approved(), sandbox()])
    for (const t of ["CronCreate", "ScheduleWakeup", "RemoteTrigger", "SendMessage"]) assert.equal(decide(s, t, {}), "deny", t);
});

test("approved state: the plugin data directory is off limits (case-insensitive, relative, symlinked, via shell)", () => {
  const s = approved();
  const { file } = paths(s.data, s.project);
  assert.equal(decide(s, "Write", { file_path: file }), "deny");
  assert.equal(decide(s, "Edit", { file_path: file.toUpperCase() }), process.platform === "darwin" ? "deny" : "allow"); // case-insensitive FS only
  assert.equal(decide(s, "NotebookEdit", { notebook_path: file }), "deny");
  assert.equal(decide(s, "Write", { file_path: file + ".tmp" }), "deny"); // nonexistent sibling
  const link = join(s.project, "link");
  symlinkSync(s.data, link);
  assert.equal(decide(s, "Write", { file_path: join(link, "projects", "x") }), "deny"); // via symlink
  mkdirSync(join(s.project, "sub"));
  assert.equal(evaluate({ ...env(s), cwd: join(s.project, "sub") }, "Write", { file_path: join("..", "link", "x") }).decision, "deny");
  assert.equal(decide(s, "Bash", { command: `rm -f ${file}` }), "deny");
  assert.equal(decide(s, "Bash", { command: "rm -rf ~/.claude/plugins/data" }), "deny");
  assert.equal(decide(s, "Write", w), "allow"); // ordinary project files unaffected
  // text that merely mentions a ".prevue" directory is no longer special
  assert.equal(decide(s, "Write", { file_path: "README.md", content: "add .prevue/ to .gitignore" }), "allow");
});

test("KNOWN LIMITATION: once APPROVED, an obfuscated shell command can still reach the data directory", () => {
  const s = approved();
  assert.equal(decide(s, "Bash", { command: "cd ~/.cla* && rm -rf plug*/dat*" }), "allow"); // documented in docs/ENFORCEMENT.md
});

// ---- shell classifier regression --------------------------------------------------------------

const unsafe = [
  "echo hi > src/App.tsx", "echo hi >> a.txt", "cat a | tee b", "sed -i s/a/b/ f", "python3 -c 'open(1)'", "node -e 'fs.writeFileSync()'",
  "git apply p.diff", "git checkout -- .", "cp a b", "mv a b", "touch a", "rm a", "npm install", "ls; touch a", "ls && touch a", "ls $(touch a)",
  "ls `touch a`", "find . -delete", "find . -exec touch {} +", "find . -fprint out", "find . -fls out", "find . -okdir rm {} ;", "printf x | sh", "bash -c 'touch a'",
  "cat <<EOF\nx\nEOF", "ls\ntouch a", "ls\u0000touch a",
  // `file -C` writes a compiled magic file; `file` is no longer allowlisted at all
  "file -C", "file -C -m magic", "file --compile", "file -bC x", "file x",
  // git: abbreviated long options and non-read-only subcommands
  "git diff --output=out.txt", "git diff --out=out.txt", "git log --outp=x", "git show --output x", "git diff --ext-diff", "git diff --ext-d",
  "git -c core.pager=x log", "git config --global x y", "git branch newb", "git stash", "git commit -m x", "git clean -fd",
  // other ambiguity
  "FOO=bar ls", "'ls'", "ls ${HOME}", "ls $HOME", "ls <(touch a)", "ls > /dev/null", "ls &", "ls || touch a", "tee out", "sort -o out in", "dd of=out", "curl -o out http://x",
  "", "   ", "x".repeat(2001),
];
const safe = ["ls -la", "pwd", "git status", "git status --porcelain", "git diff HEAD", "git log --oneline", "git show HEAD", "git rev-parse HEAD", "cat package.json", "head -n 5 a", "tail -n 5 a", "wc -l a", "grep -rn foo src", "find . -name '*.ts'", "echo hello", "which node", "stat a"];

test("shell classifier: every known-unsafe or ambiguous command is rejected", () => {
  for (const c of unsafe) assert.equal(isReadOnlyShell(c), false, JSON.stringify(c));
  for (const c of [undefined, null, 5, {}, []]) assert.equal(isReadOnlyShell(c), false);
});

test("shell classifier: plain read-only commands are accepted", () => {
  for (const c of safe) assert.equal(isReadOnlyShell(c), true, c);
});

test("every unsafe command is denied end-to-end through the gate while PENDING", () => {
  const s = pending();
  for (const command of unsafe) assert.equal(decide(s, "Bash", { command }), "deny", JSON.stringify(command));
});
