import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyStoredDesign } from "../src/design-store.js";

/** Every test runs in throwaway directories under the OS temp dir; nothing touches the repo or ~/.claude. */
const made: string[] = [];
process.on("exit", () => made.forEach((d) => rmSync(d, { recursive: true, force: true })));
export const tmp = (label: string): string => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), `prevue-${label}-`)));
  if (!d.startsWith(realpathSync(tmpdir()))) throw new Error("refusing to use a non-temp directory");
  made.push(d);
  return d;
};

export const HOOK = join(import.meta.dirname, "..", "src", "hook.js");

export interface Sandbox { data: string; project: string }
export const sandbox = (): Sandbox => ({ data: tmp("data"), project: tmp("proj") });

export const env = (s: Sandbox) => ({ dataDir: s.data, projectDir: s.project, cwd: s.project, verifyDesign: verifyStoredDesign });

/** Run the real hook script as Claude Code would: JSON on stdin, plugin/project dirs in the environment. */
export function hook(s: Sandbox, payload: unknown, extraEnv: Record<string, string | undefined> = {}) {
  const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_DATA: s.data, CLAUDE_PROJECT_DIR: s.project, ...extraEnv };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync("node", [HOOK], { input: typeof payload === "string" ? payload : JSON.stringify(payload), env: e as NodeJS.ProcessEnv, encoding: "utf8" });
}

export const pre = (s: Sandbox, tool_name: unknown, tool_input: unknown = {}, extraEnv = {}) =>
  hook(s, { hook_event_name: "PreToolUse", cwd: s.project, tool_name, tool_input }, extraEnv);

/** "deny" | "allow" from a PreToolUse hook run (exit 2 counts as deny). */
export const verdict = (r: ReturnType<typeof hook>): "allow" | "deny" =>
  r.status === 2 ? "deny" : r.stdout.includes('"permissionDecision":"deny"') ? "deny" : "allow";

export const prompt = (s: Sandbox, text: string) => hook(s, { hook_event_name: "UserPromptSubmit", cwd: s.project, prompt: text });
export const start = (s: Sandbox) => hook(s, { hook_event_name: "SessionStart", cwd: s.project, source: "startup" });
