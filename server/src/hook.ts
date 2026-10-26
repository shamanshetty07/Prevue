import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { evaluate } from "./gate.js";
import { approve, initIfMissing, load, reset } from "./state.js";

/**
 * Hook entry point for SessionStart, PreToolUse and UserPromptSubmit.
 * Malformed input or an unexpected error exits 2: that blocks a PreToolUse call (fail closed) and is
 * merely reported for the other events.
 */
const APPROVE = /^\s*prevue\s+approve(?:\s+(\S+))?\s*$/i;
const RESET = /^\s*prevue\s+reset\s*$/i;

const emit = (hookEventName: string, extra: Record<string, unknown>): void => {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName, ...extra } }));
};

function describe(dataDir: string, projectDir: string): string {
  const l = load(dataDir, projectDir);
  if (l.status === "INVALID") return `Prevue gate: INVALID (${l.reason}). Implementation tools are blocked until the developer types "prevue reset".`;
  const h = l.state.designHash ? `design revision ${l.state.revision} (hash ${l.state.designHash.slice(0, 12)})` : "no design registered";
  return l.status === "APPROVED"
    ? `Prevue gate: APPROVED for ${h}.`
    : `Prevue gate: PENDING, ${h}. File-modifying and unclassified tools are blocked until the developer approves a design by typing "prevue approve <hash>". Do not try to work around a Prevue denial.`;
}

function main(): void {
  const input = JSON.parse(readFileSync(0, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("hook input is not a JSON object");
  const rawData = process.env.CLAUDE_PLUGIN_DATA;
  const dataDir = rawData && isAbsolute(rawData) ? rawData : undefined;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || input.cwd;
  if (typeof projectDir !== "string" || !isAbsolute(projectDir)) throw new Error("cannot determine the project directory");
  const cwd = typeof input.cwd === "string" ? input.cwd : projectDir;

  switch (input.hook_event_name) {
    case "SessionStart": {
      if (!dataDir) return emit("SessionStart", { additionalContext: "Prevue gate: INVALID (CLAUDE_PLUGIN_DATA is not set). Implementation tools are blocked." });
      initIfMissing(dataDir, projectDir); // PENDING before the first prompt; never overwrites an existing file
      return emit("SessionStart", { additionalContext: describe(dataDir, projectDir) });
    }
    case "PreToolUse": {
      const d = evaluate({ dataDir, projectDir, cwd }, input.tool_name, input.tool_input);
      if (d.decision === "deny") emit("PreToolUse", { permissionDecision: "deny", permissionDecisionReason: d.reason });
      return;
    }
    case "UserPromptSubmit": {
      // Developer-typed commands. Caveat: Claude Code also fires this event for turns it starts on its own
      // and documents no origin field, so Prevue disables the tools that could schedule such turns.
      const prompt = String(input.prompt ?? "");
      const isApprove = APPROVE.exec(prompt);
      if (!isApprove && !RESET.test(prompt)) return;
      if (!dataDir) return emit("UserPromptSubmit", { additionalContext: "Prevue: CLAUDE_PLUGIN_DATA is not set; nothing was changed." });
      let message: string;
      try {
        if (isApprove) {
          const s = approve(dataDir, projectDir, isApprove[1]);
          message = `Prevue: design revision ${s.revision} (${s.designHash!.slice(0, 12)}) approved by the developer.`;
        } else {
          const r = reset(dataDir, projectDir);
          message = `Prevue: state reset to PENDING${r.quarantinedTo ? " (previous state quarantined)" : ""}. All approvals are revoked.`;
        }
      } catch (e) {
        message = `Prevue: request REJECTED. ${(e as Error).message}`;
      }
      return emit("UserPromptSubmit", { additionalContext: message });
    }
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`Prevue hook error (failing closed): ${(e as Error).message}\n`);
  process.exit(2);
}
