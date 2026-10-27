import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { load } from "../src/state.js";
import { sandbox, start, tmp } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "src", "cli.js");

/** Runs the real CLI in `cwd`; `data` is the literal CLAUDE_PLUGIN_DATA (undefined = not set at all). */
function cli(args: string[], cwd: string, data: string | undefined) {
  const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_DATA: data };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  return spawnSync("node", [CLI, ...args], { env: e as NodeJS.ProcessEnv, encoding: "utf8", cwd, timeout: 20000 });
}

const spec = (dir: string): string => {
  const p = join(dir, "design.json");
  writeFileSync(p, JSON.stringify({ screen: "a", version: "A" }));
  return p;
};

test("CLI: an unset, empty or relative CLAUDE_PLUGIN_DATA is rejected (exit 64) by every state command and creates nothing", () => {
  const cwd = tmp("cliwd");
  const project = tmp("proj");
  const design = spec(tmp("spec"));
  const before = readdirSync(cwd).sort();
  const commands = [["init", project], ["status", project], ["reset", project], ["register", design, project]];
  for (const data of [undefined, "", "relative-data", "./data", "../data", ".", "data/with/sub"]) {
    for (const args of commands) {
      const r = cli(args, cwd, data);
      const label = `${args[0]} with CLAUDE_PLUGIN_DATA=${JSON.stringify(data)}`;
      assert.equal(r.status, 64, `${label}: ${r.stderr}`);
      assert.match(r.stderr, /CLAUDE_PLUGIN_DATA must be set to an absolute path/, label);
      assert.equal(r.stdout, "", label);
    }
    assert.deepEqual(readdirSync(cwd).sort(), before, `nothing is created in the cwd for ${JSON.stringify(data)}`);
    assert.ok(!existsSync(join(cwd, "relative-data")) && !existsSync(join(cwd, "data")) && !existsSync(join(cwd, "projects")));
  }
  assert.deepEqual(readdirSync(project), []);
});

test("CLI: a relative CLAUDE_PLUGIN_DATA is never resolved against the cwd, and the hook agrees it is unusable", () => {
  const cwd = tmp("cliwd");
  const s = sandbox();
  assert.equal(cli(["register", spec(tmp("spec")), s.project], cwd, "rel").status, 64);
  assert.ok(!existsSync(join(cwd, "rel")));
  // The hook treats the same value as unset, so a state the CLI wrote there would never have been read by the gate.
  const h = spawnSync("node", [join(import.meta.dirname, "..", "src", "hook.js")], {
    input: JSON.stringify({ hook_event_name: "SessionStart", cwd: s.project, source: "startup" }),
    env: { ...process.env, CLAUDE_PLUGIN_DATA: "rel", CLAUDE_PROJECT_DIR: s.project } as NodeJS.ProcessEnv,
    encoding: "utf8",
    cwd,
  });
  assert.match(h.stdout, /INVALID \(CLAUDE_PLUGIN_DATA is not set\)/);
});

test("CLI: a valid absolute CLAUDE_PLUGIN_DATA behaves exactly as before for init, register, status and reset", () => {
  const cwd = tmp("cliwd");
  const s = sandbox();
  const design = spec(tmp("spec"));
  assert.equal(cli(["init", s.project], cwd, s.data).stdout.trim(), "created");
  assert.equal(cli(["init", s.project], cwd, s.data).stdout.trim(), "exists");
  const reg = cli(["register", design, s.project], cwd, s.data);
  assert.equal(reg.status, 0, reg.stderr);
  assert.equal(JSON.parse(reg.stdout).state.revision, 1);
  assert.equal(JSON.parse(cli(["status", s.project], cwd, s.data).stdout).status, "PENDING");
  const rs = JSON.parse(cli(["reset", s.project], cwd, s.data).stdout);
  assert.ok(rs.quarantinedTo);
  assert.equal(load(s.data, s.project).status, "PENDING");
  assert.equal((load(s.data, s.project) as any).state.revision, 0);
  assert.deepEqual(readdirSync(cwd), []); // state went under the absolute data dir only
  assert.equal(cli(["bogus"], cwd, s.data).status, 64);
});

test("CLI: validate still needs no CLAUDE_PLUGIN_DATA, even a relative or empty one", () => {
  const cwd = tmp("cliwd");
  const p = join(tmp("spec"), "bad.json");
  writeFileSync(p, "{");
  for (const data of [undefined, "", "rel"]) assert.equal(cli(["validate", p], cwd, data).status, 1);
  assert.deepEqual(readdirSync(cwd), []);
});
