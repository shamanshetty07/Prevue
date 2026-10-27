import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { registerCanonical } from "./register.js";
import { initIfMissing, load, registerDesign, reset } from "./state.js";
import { readSpecInput } from "./validate-cli.js";
import { validateCommand } from "./validate-cli.js";

/**
 * Developer/experiment helper standing in for the future design-registration tool.
 * Deliberately has no `approve` command: approval only flows through the UserPromptSubmit hook,
 * so the agent cannot approve its own work via Bash.
 *
 *   CLAUDE_PLUGIN_DATA=<dir> node dist/src/cli.js init|status|reset [projectDir]
 *   CLAUDE_PLUGIN_DATA=<dir> node dist/src/cli.js register <spec.json|-> [projectDir]
 *   CLAUDE_PLUGIN_DATA=<dir> node dist/src/cli.js register-design <spec.json|-> [projectDir]
 *       validates, stores the canonical design and registers it as a new PENDING revision; never approves.
 *       exit 0 registered (or unchanged), 1 invalid specification, 2 input file error, 3 refused or failed, 64 usage/configuration
 *   node dist/src/cli.js validate <spec.json|->      read-only schema validation; needs no CLAUDE_PLUGIN_DATA, never registers
 */
const [cmd, arg, dirArg] = process.argv.slice(2);
// Same rule as the hook: an empty or relative CLAUDE_PLUGIN_DATA is unset, never resolved against the cwd, so the CLI
// can only write state in the directory the hook reads.
const rawData = process.env.CLAUDE_PLUGIN_DATA;
const data = rawData && isAbsolute(rawData) ? rawData : undefined;
const dir = (cmd === "register" || cmd === "register-design" ? dirArg : arg) ?? process.cwd();

if (cmd === "validate") {
  process.exitCode = validateCommand(arg);
} else {
  if (!data) {
    console.error("CLAUDE_PLUGIN_DATA must be set to an absolute path");
    process.exit(64);
  }
  if (cmd === "register-design" && arg) {
    const read = readSpecInput(arg);
    if (!read.ok) {
      console.log(JSON.stringify({ registered: false, approvedByThisCall: false, kind: "file_error", code: read.code, message: read.message }));
      process.exitCode = 2;
    } else {
      // The project directory is an explicit argument (or the cwd), so it is made absolute here; the data directory is already absolute.
      const r = registerCanonical({ CLAUDE_PLUGIN_DATA: data, CLAUDE_PROJECT_DIR: resolve(dir) }, read.text);
      const { ok: _ok, ...out } = r;
      console.log(JSON.stringify(out));
      process.exitCode = r.ok ? 0 : r.kind === "parse_error" || r.kind === "schema_error" ? 1 : r.kind === "config_error" ? 64 : 3;
    }
  } else if (cmd === "register" && arg) {
    const r = registerDesign(data, dir, JSON.parse(readFileSync(arg === "-" ? 0 : arg, "utf8")));
    console.log(JSON.stringify(r));
  } else if (cmd === "init") {
    console.log(initIfMissing(data, dir));
  } else if (cmd === "status") {
    console.log(JSON.stringify(load(data, dir)));
  } else if (cmd === "reset") {
    console.log(JSON.stringify(reset(data, dir)));
  } else {
    console.error("usage: cli init|status|reset [dir] | register <spec.json|-> [dir] | register-design <spec.json|-> [dir] | validate <spec.json|->");
    process.exit(64);
  }
}
