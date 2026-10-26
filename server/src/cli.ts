import { readFileSync } from "node:fs";
import { readState, setDesign } from "./gate.js";

/**
 * Developer/experiment helper standing in for the future design-registration tool.
 * Deliberately has no `approve` command: approval only flows through the
 * UserPromptSubmit hook, so the agent cannot approve its own work via Bash.
 *
 *   node dist/cli.js set-design <spec.json|-> [projectDir]
 *   node dist/cli.js status [projectDir]
 */
const [cmd, arg, dirArg] = process.argv.slice(2);
const dir = (cmd === "status" ? arg : dirArg) ?? process.cwd();

if (cmd === "set-design" && arg) {
  const spec = JSON.parse(readFileSync(arg === "-" ? 0 : arg, "utf8"));
  console.log(JSON.stringify(setDesign(dir, spec)));
} else if (cmd === "status") {
  console.log(JSON.stringify(readState(dir)));
} else {
  console.error("usage: cli set-design <spec.json|-> [dir] | status [dir]");
  process.exit(64);
}
