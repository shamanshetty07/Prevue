import { readFileSync } from "node:fs";
import { initIfMissing, load, registerDesign, reset } from "./state.js";
import { validateCommand } from "./validate-cli.js";

/**
 * Developer/experiment helper standing in for the future design-registration tool.
 * Deliberately has no `approve` command: approval only flows through the UserPromptSubmit hook,
 * so the agent cannot approve its own work via Bash.
 *
 *   CLAUDE_PLUGIN_DATA=<dir> node dist/src/cli.js init|status|reset [projectDir]
 *   CLAUDE_PLUGIN_DATA=<dir> node dist/src/cli.js register <spec.json|-> [projectDir]
 *   node dist/src/cli.js validate <spec.json|->      read-only schema validation; needs no CLAUDE_PLUGIN_DATA, never registers
 */
const [cmd, arg, dirArg] = process.argv.slice(2);
const data = process.env.CLAUDE_PLUGIN_DATA;
const dir = (cmd === "register" ? dirArg : arg) ?? process.cwd();

if (cmd === "validate") {
  process.exitCode = validateCommand(arg);
} else {
  if (!data) {
    console.error("CLAUDE_PLUGIN_DATA must be set");
    process.exit(64);
  }
  if (cmd === "register" && arg) {
    const r = registerDesign(data, dir, JSON.parse(readFileSync(arg === "-" ? 0 : arg, "utf8")));
    console.log(JSON.stringify(r));
  } else if (cmd === "init") {
    console.log(initIfMissing(data, dir));
  } else if (cmd === "status") {
    console.log(JSON.stringify(load(data, dir)));
  } else if (cmd === "reset") {
    console.log(JSON.stringify(reset(data, dir)));
  } else {
    console.error("usage: cli init|status|reset [dir] | register <spec.json|-> [dir]");
    process.exit(64);
  }
}
