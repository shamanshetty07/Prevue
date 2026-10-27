import { existsSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { normalizePath } from "./state.js";

/**
 * Conservative tool classification. While the gate is not APPROVED only tools that are known to be
 * read-only (under the threat model "Claude accidentally or deliberately implementing early") are
 * allowed; everything else, including tools this code has never heard of, is denied.
 * A PreToolUse hook can only protect operations that pass through it.
 */

const READ_ONLY_TOOLS = new Set([
  "Read", "Glob", "Grep", "LSP", "ToolSearch", "WaitForMcpServers",
  "ListMcpResourcesTool", "ReadMcpResourceTool", "ReadMcpResourceDirTool",
  "CronList", "ListAgents", "TaskGet", "TaskList",
  "WebSearch", "WebFetch", "AskUserQuestion", "EnterPlanMode", "ExitPlanMode",
  "TodoWrite", "TaskCreate", "TaskUpdate", "Skill", "EndConversation", "SubagentHandback",
  // Subagents are allowed because their own tool calls also pass through PreToolUse (verified for Write in
  // non-interactive mode; see docs/ENFORCEMENT.md). Worktree isolation is denied below.
  "Agent", "Task",
]);
/** Exact names only: sharing a prefix with an allowed tool grants nothing. A new Prevue tool is denied until it is added here. */
const READ_ONLY_MCP = new Set(["mcp__plugin_prevue_prevue__prevue_ping", "mcp__plugin_prevue_prevue__prevue_validate_spec", "mcp__ide__getDiagnostics"]);
/**
 * The one state-changing tool the gate lets through while PENDING: it stores a validated design and records a new
 * PENDING revision, and can never approve (approval exists only in the UserPromptSubmit hook). It is deliberately NOT in
 * READ_ONLY_MCP, and the gate admits it only through isPendingRegistration, so it is never allowed for INVALID state.
 */
export const REGISTER_DESIGN_TOOL = "mcp__plugin_prevue_prevue__prevue_register_design";
const MAX_SPEC_CHARS = 10 * 64 * 1024; // the tool's own input limit; the gate refuses anything larger before the server sees it

/** Exact name, and an input that is exactly `{spec: <bounded string>}`: no other property can ride along. */
export function isPendingRegistration(toolName: unknown, toolInput: unknown): boolean {
  if (toolName !== REGISTER_DESIGN_TOOL) return false;
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return false;
  const keys = Object.keys(toolInput);
  const spec = (toolInput as Record<string, unknown>).spec;
  return keys.length === 1 && keys[0] === "spec" && typeof spec === "string" && spec.length <= MAX_SPEC_CHARS;
}

const SHELL_TOOLS = new Set(["Bash", "Monitor"]);
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

/** Tools that can start a later turn (or a turn in another session) whose text UserPromptSubmit cannot attribute to the developer. */
const PROMPT_INJECTION_TOOLS = new Set(["CronCreate", "ScheduleWakeup", "RemoteTrigger", "SendMessage"]);

export type Verdict = { allow: true } | { allow: false; reason: string };
const deny = (reason: string): Verdict => ({ allow: false, reason });

export const alwaysDenied = (toolName: unknown): string | null =>
  typeof toolName === "string" && PROMPT_INJECTION_TOOLS.has(toolName)
    ? `${toolName} can start a later turn that Prevue cannot tell apart from developer input, so it is disabled while Prevue is active.`
    : null;

// ---- shell classification -------------------------------------------------------------------

const SHELL_META = /[;&|<>`$\\\n\r\0(){}]/;
const READ_ONLY_CMDS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "echo", "which", "stat"]); // `file` removed: `file -C` writes a .mgc file
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse"]);
const FIND_UNSAFE = /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/;
// git accepts any unambiguous prefix of a long option, so "--out=x" means "--output=x".
const GIT_UNSAFE_LONG = ["--output", "--ext-diff", "--open-files-in-pager"];

/** True only for commands that provably cannot write. Anything ambiguous is false. */
export function isReadOnlyShell(command: unknown): boolean {
  if (typeof command !== "string" || command.length === 0 || command.length > 2000) return false;
  if (SHELL_META.test(command)) return false;
  const words = command.trim().split(/\s+/);
  const [cmd, sub] = words;
  if (!cmd) return false;
  if (cmd === "git") {
    if (!READ_ONLY_GIT.has(sub ?? "")) return false;
    return !words.slice(2).some((w) => {
      if (!w.startsWith("--")) return false;
      const name = w.split("=")[0];
      return name.length >= 3 && GIT_UNSAFE_LONG.some((u) => u.startsWith(name));
    });
  }
  if (cmd === "find") return !words.some((w) => FIND_UNSAFE.test(w));
  return READ_ONLY_CMDS.has(cmd);
}

// ---- path helpers ---------------------------------------------------------------------------

/** All string values stored under path-like keys anywhere in a tool input. */
export function pathsIn(input: unknown, out: string[] = []): string[] {
  if (Array.isArray(input)) input.forEach((v) => pathsIn(v, out));
  else if (input && typeof input === "object")
    for (const [k, v] of Object.entries(input)) {
      if (typeof v === "string" && /^(file_path|notebook_path|path|filePath)$/.test(k)) out.push(v);
      else pathsIn(v, out);
    }
  return out;
}

/** realpath of the deepest existing ancestor + the not-yet-existing remainder; case-folded on macOS/Windows. */
export function resolveReal(p: string, cwd: string): string {
  const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
  let head = abs;
  const tail: string[] = [];
  while (!existsSync(head) && dirname(head) !== head) {
    tail.unshift(head.slice(dirname(head).length + 1));
    head = dirname(head);
  }
  let real: string;
  try {
    real = realpathSync(head);
  } catch {
    real = head;
  }
  return normalizePath(join(real, ...tail));
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// ---- policy ---------------------------------------------------------------------------------

/** Verdict for a tool call while the gate is PENDING or INVALID. */
export function classifyPending(toolName: unknown, toolInput: unknown): Verdict {
  if (typeof toolName !== "string" || toolName.length === 0) return deny("tool name is missing or malformed");
  const input = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? (toolInput as Record<string, unknown>) : null;
  if (FILE_TOOLS.has(toolName)) return deny(`${toolName} modifies files`);
  if (SHELL_TOOLS.has(toolName)) {
    return input && isReadOnlyShell(input.command) ? { allow: true } : deny(`${toolName} command is not provably read-only`);
  }
  if (toolName === "Agent" || toolName === "Task") {
    if (!input) return deny("malformed tool input");
    return input.isolation ? deny("subagent worktree isolation creates files outside the hooks' view") : { allow: true };
  }
  if (READ_ONLY_TOOLS.has(toolName)) return { allow: true };
  if (toolName.startsWith("mcp__")) {
    return READ_ONLY_MCP.has(toolName) ? { allow: true } : deny(`MCP tool ${toolName} is not on Prevue's read-only list`);
  }
  return deny(`tool ${toolName} is not on Prevue's read-only list`);
}
