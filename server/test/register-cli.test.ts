import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { approve, load, paths } from "../src/state.js";
import { sandbox, tmp } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "src", "cli.js");
const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const HASH = "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5";

function cli(args: string[], opts: { data?: string; input?: string; cwd?: string } = {}) {
  const e: Record<string, string | undefined> = { PATH: process.env.PATH, CLAUDE_PLUGIN_DATA: opts.data };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync("node", [CLI, ...args], { env: e as NodeJS.ProcessEnv, encoding: "utf8", input: opts.input, cwd: opts.cwd, timeout: 20000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}
const file = (text: string): string => {
  const p = join(tmp("spec"), "spec.json");
  writeFileSync(p, text);
  return p;
};

test("cli register-design: a valid specification is registered as PENDING and approves nothing (exit 0)", () => {
  const s = sandbox();
  const r = cli(["register-design", file(exampleText), s.project], { data: s.data });
  assert.equal(r.status, 0, r.stderr);
  const out = r.json();
  assert.deepEqual([out.registered, out.approvedByThisCall, out.outcome, out.revision, out.status, out.hash, out.design], [true, false, "created", 1, "PENDING", HASH, "written"]);
  assert.ok(!("ok" in out));
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.canonical, l.state.approvedRevision], ["PENDING", true, null]);
  assert.ok(existsSync(join(paths(s.data, s.project).dir, "designs", `${HASH}.json`)));
  assert.equal(cli(["register-design", file(exampleText), s.project], { data: s.data }).json().outcome, "unchanged");
});

test("cli register-design: reads stdin with '-', and defaults the project to the working directory", () => {
  const s = sandbox();
  const r = cli(["register-design", "-"], { data: s.data, input: exampleText, cwd: s.project });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((load(s.data, s.project) as any).state.revision, 1);
});

test("cli register-design: a relative project argument is resolved against the working directory", () => {
  const s = sandbox();
  const r = cli(["register-design", file(exampleText), "."], { data: s.data, cwd: s.project });
  assert.equal(r.status, 0, r.stderr);
  assert.equal((load(s.data, s.project) as any).state.revision, 1);
});

test("cli register-design: an invalid specification exits 1 with structured issues and changes nothing", () => {
  const s = sandbox();
  for (const text of ["{", "", '{"schemaVersion":2}', exampleText.replace('"name": "Expense dashboard"', '"name": "a", "name": "b"')]) {
    const r = cli(["register-design", file(text), s.project], { data: s.data });
    assert.equal(r.status, 1, text);
    const out = r.json();
    assert.deepEqual([out.registered, out.approvedByThisCall], [false, false]);
    assert.ok(["parse_error", "schema_error"].includes(out.kind) && out.issues.length >= 1);
  }
  assert.deepEqual(readdirSync(s.data), []);
});

test("cli register-design: input file problems exit 2 and change nothing", () => {
  const s = sandbox();
  const dir = tmp("dir");
  for (const p of [join(dir, "missing.json"), dir]) {
    const r = cli(["register-design", p, s.project], { data: s.data });
    assert.equal(r.status, 2);
    assert.equal(r.json().kind, "file_error");
    assert.ok(!r.stdout.includes(dir));
  }
  assert.equal(cli(["register-design", file("x".repeat(70_000)), s.project], { data: s.data }).status, 2);
  assert.deepEqual(readdirSync(s.data), []);
});

test("cli register-design: an unset, empty or relative CLAUDE_PLUGIN_DATA exits 64 and writes nothing", () => {
  const s = sandbox();
  const cwd = tmp("cwd");
  for (const data of [undefined, "", "rel", "./rel"]) {
    const r = cli(["register-design", file(exampleText), s.project], { data, cwd });
    assert.equal(r.status, 64, String(data));
    assert.equal(r.stdout, "");
  }
  assert.deepEqual(readdirSync(cwd), []);
  assert.deepEqual(readdirSync(s.project), []);
});

test("cli register-design: a refused registration exits 3 (invalid state, cap, conflict) and leaves state alone", () => {
  const s = sandbox();
  mkdirSync(paths(s.data, s.project).dir, { recursive: true });
  writeFileSync(paths(s.data, s.project).file, "{");
  const r = cli(["register-design", file(exampleText), s.project], { data: s.data });
  assert.equal(r.status, 3);
  assert.equal(r.json().code, "state_invalid");
  assert.equal(readFileSync(paths(s.data, s.project).file, "utf8"), "{");
});

test("cli register-design: usage error without a file", () => {
  const s = sandbox();
  const r = cli(["register-design"], { data: s.data });
  assert.equal(r.status, 64);
  assert.match(r.stderr, /usage/);
});

test("cli: validate stays read-only and the existing commands still behave the same", () => {
  const s = sandbox();
  const before = readdirSync(s.data).length;
  assert.equal(cli(["validate", file(exampleText)]).status, 0);
  assert.equal(readdirSync(s.data).length, before);
  // The old stand-in still registers arbitrary JSON without a marker or a stored file.
  const p = file(JSON.stringify({ screen: "phase 0 design" }));
  const reg = cli(["register", p, s.project], { data: s.data });
  assert.equal(reg.status, 0, reg.stderr);
  assert.equal(reg.json().state.revision, 1);
  assert.equal("canonical" in reg.json().state, false);
  assert.equal(cli(["status", s.project], { data: s.data }).json().status, "PENDING");
  assert.equal(existsSync(join(paths(s.data, s.project).dir, "designs")), false);
  assert.equal(cli(["init", s.project], { data: s.data }).stdout.trim(), "exists");
  assert.ok(cli(["reset", s.project], { data: s.data }).json().quarantinedTo);
  assert.throws(() => approve(s.data, s.project, undefined), /needs the design hash prefix/); // approve is still hook-only
  assert.equal(cli(["approve", "abcdef12", s.project], { data: s.data }).status, 64);
});
