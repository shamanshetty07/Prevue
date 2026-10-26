import { readFileSync } from "node:fs";
import { APPROVE_PROMPT, approve, evaluate } from "./gate.js";

/**
 * Hook entry point for PreToolUse and UserPromptSubmit.
 * Any unexpected error exits 2, which blocks a PreToolUse call (fail closed).
 */
function main(): void {
  const input = JSON.parse(readFileSync(0, "utf8")) as Record<string, any>;
  const projectDir = process.env.CLAUDE_PROJECT_DIR ?? input.cwd;
  const event = input.hook_event_name;

  if (event === "PreToolUse") {
    const d = evaluate(projectDir, input.tool_name, input.tool_input ?? {});
    if (d.decision === "deny") {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: d.reason,
          },
        }),
      );
    }
    return;
  }

  if (event === "UserPromptSubmit") {
    // Only text typed by the developer reaches this event; the model cannot emit it.
    const m = APPROVE_PROMPT.exec(String(input.prompt ?? ""));
    if (!m) return;
    let message: string;
    try {
      const s = approve(projectDir, m[1]);
      message = `Prevue: design v${s.designVersion} (${s.designHash.slice(0, 12)}) approved by the developer.`;
    } catch (e) {
      message = `Prevue: approval REJECTED. ${(e as Error).message}`;
    }
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: message } }),
    );
  }
}

try {
  main();
} catch (e) {
  process.stderr.write(`Prevue hook error (failing closed): ${(e as Error).message}\n`);
  process.exit(2);
}
