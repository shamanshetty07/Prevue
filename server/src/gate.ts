import { alwaysDenied, classifyPending, isInside, pathsIn, resolveReal } from "./classify.js";
import { load, normalizePath, type GateStatus } from "./state.js";

export interface GateEnv {
  /** ${CLAUDE_PLUGIN_DATA}; undefined means the gate cannot find its state and treats it as INVALID. */
  dataDir: string | undefined;
  projectDir: string;
  cwd: string;
}

export type Decision = { decision: "allow"; status: GateStatus } | { decision: "deny"; status: GateStatus; reason: string };

const SHELL_TOOLS = new Set(["Bash", "Monitor", "PowerShell"]);

/** Decide whether a tool call may proceed. Never throws for malformed input; unknown means deny while not APPROVED. */
export function evaluate(env: GateEnv, toolName: unknown, toolInput: unknown): Decision {
  const name = typeof toolName === "string" ? toolName : "";
  const prompt = alwaysDenied(toolName);
  const loaded = env.dataDir && env.dataDir.length > 0 ? load(env.dataDir, env.projectDir) : null;
  const status: GateStatus = loaded ? loaded.status : "INVALID";
  const why = loaded ? (loaded.status === "INVALID" ? loaded.reason : "") : "CLAUDE_PLUGIN_DATA is not set";
  if (prompt) return { decision: "deny", status, reason: `Prevue: ${prompt}` };

  if (status === "APPROVED" && loaded && loaded.status === "APPROVED") {
    // Even when approved, the agent must not touch the state it is judged by.
    const dd = normalizePath(env.dataDir!);
    for (const p of pathsIn(toolInput)) {
      if (isInside(resolveReal(p, env.cwd), dd)) return { decision: "deny", status, reason: "Prevue: the plugin data directory holds approval state and is not writable by the agent." };
    }
    if (SHELL_TOOLS.has(name)) {
      const cmd = String((toolInput as any)?.command ?? "").toLowerCase();
      if (cmd.includes(dd) || cmd.includes(env.dataDir!.toLowerCase()) || /plugins[\\/]+data/.test(cmd))
        return { decision: "deny", status, reason: "Prevue: shell commands may not reference the plugin data directory." };
    }
    return { decision: "allow", status };
  }

  const v = classifyPending(toolName, toolInput);
  if (v.allow) return { decision: "allow", status };
  const hint =
    status === "INVALID"
      ? `Prevue state is INVALID (${why}). Implementation is blocked. The developer can recover by typing "prevue reset".`
      : `No design is approved. Ask the developer to review the design and type "prevue approve <hash>".`;
  return { decision: "deny", status, reason: `Prevue: ${name || "tool"} blocked (${v.reason}). ${hint}` };
}
