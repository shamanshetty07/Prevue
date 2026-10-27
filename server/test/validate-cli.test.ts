import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { evaluate } from "../src/gate.js";
import { LIMITS } from "../src/spec/schema.js";
import { specHash, validateSpec } from "../src/spec/validate.js";
import { hashDesign, load, registerDesign } from "../src/state.js";
import { validateFile } from "../src/validate-cli.js";
import { env, prompt, sandbox, tmp } from "./helpers.js";

const CLI = join(import.meta.dirname, "..", "src", "cli.js");
const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const example = (): any => JSON.parse(exampleText);

/** Runs the real CLI. CLAUDE_PLUGIN_DATA is only set when a test passes it, so `validate` is shown to need none. */
function cli(args: string[], opts: { data?: string; input?: string } = {}) {
  const e: Record<string, string | undefined> = { ...process.env, CLAUDE_PLUGIN_DATA: opts.data };
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
  const r = spawnSync("node", [CLI, ...args], { env: e as NodeJS.ProcessEnv, encoding: "utf8", input: opts.input, timeout: 20000 });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, json: () => JSON.parse(r.stdout) };
}
const put = (dir: string, name: string, content: string | Buffer): string => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

/** Every file under dir with its bytes and mtime; any create/modify/delete shows up as a difference. */
function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p, { bigint: true });
      out.push(`${p}|${st.isDirectory() ? "dir" : `${st.size}|${readFileSync(p).toString("base64")}`}|${st.mtimeNs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join("\n");
}

test("validate: a valid specification prints one JSON document with the normalized spec and its hash, exit 0, no CLAUDE_PLUGIN_DATA needed", () => {
  const d = tmp("vcli");
  const r = cli(["validate", put(d, "ok.json", exampleText)]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trimEnd().split("\n").length, 1);
  const out = r.json();
  const expected = validateSpec(example());
  assert.ok(expected.ok);
  assert.equal(out.valid, true);
  assert.equal(out.registered, false);
  assert.equal(out.approved, false);
  assert.equal(out.schemaVersion, 1);
  assert.equal(out.hash, specHash((expected as any).spec));
  assert.equal(out.hash, "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5");
  assert.deepEqual(out.stats, { nodes: 9, depth: 1 });
  assert.deepEqual(out.spec, JSON.parse(JSON.stringify((expected as any).spec)));
  assert.equal(r.stderr, "");
});

test("validate: defaults are filled into the returned spec, and equivalent inputs print the same hash", () => {
  const d = tmp("vcli");
  const a = cli(["validate", put(d, "a.json", exampleText)]).json();
  const spaced = cli(["validate", put(d, "b.json", JSON.stringify(example(), null, 8))]).json();
  assert.equal(a.hash, spaced.hash);
  assert.equal(a.spec.layout.main.gap, "md");
  assert.equal(a.spec.layout.sidebar.width, "normal");
});

test("validate: stdin ('-') works", () => {
  const r = cli(["validate", "-"], { input: exampleText });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.json().valid, true);
  const bad = cli(["validate", "-"], { input: "{" });
  assert.equal(bad.status, 1);
});

test("validate: malformed JSON -> parse_error, exit 1, and the offending text is not echoed", () => {
  const d = tmp("vcli");
  const r = cli(["validate", put(d, "bad.json", '{"schemaVersion": 1, "secret": "TOP-SECRET-MARKER" oops}')]);
  assert.equal(r.status, 1);
  const out = r.json();
  assert.equal(out.valid, false);
  assert.equal(out.kind, "parse_error");
  assert.equal(out.issues[0].code, "invalid_json");
  assert.ok(!r.stdout.includes("TOP-SECRET-MARKER") && !r.stdout.includes("oops"));
  for (const t of ["", "{", "[1,2,]", "﻿{}"]) assert.equal(cli(["validate", put(d, "x.json", t)]).json().kind, "parse_error", JSON.stringify(t));
});

test("validate: schema-invalid specification -> schema_error with structured issues, exit 1", () => {
  const d = tmp("vcli");
  const s = example();
  delete s.screen.name;
  s.theme.mode = "sepia";
  s.layout.main.children[0].onclick = "alert(1)";
  s.layout.main.children.push({ type: "iframe" });
  const r = cli(["validate", put(d, "invalid.json", JSON.stringify(s))]);
  assert.equal(r.status, 1);
  const out = r.json();
  assert.equal(out.kind, "schema_error");
  const codes = out.issues.map((i: any) => `${i.code}@${i.path}`);
  for (const c of ["missing_field@/screen/name", "invalid_value@/theme/mode", "unknown_key@/layout/main/children/0/onclick", "unknown_component@/layout/main/children/3/type"]) assert.ok(codes.includes(c), `${c} in ${codes}`);
  assert.ok(!("spec" in out) && !("hash" in out)); // nothing to approve from an invalid spec
  assert.ok(!r.stdout.includes("alert(1)"));
  assert.equal(cli(["validate", put(d, "v.json", JSON.stringify({ ...example(), schemaVersion: 2 }))]).json().issues[0].code, "unsupported_version");
});

test("validate: file problems -> file_error, exit 2, no path or content in the message", () => {
  const d = tmp("vcli");
  const missing = cli(["validate", join(d, "does-not-exist.json")]);
  assert.equal(missing.status, 2);
  assert.equal(missing.json().kind, "file_error");
  assert.equal(missing.json().issues[0].code, "file_not_found");
  assert.ok(!missing.stdout.includes(d));
  assert.equal(cli(["validate", join(d, "nope", "deeper.json")]).json().issues[0].code, "file_not_found");

  const dir = cli(["validate", d]);
  assert.equal(dir.status, 2);
  assert.equal(dir.json().issues[0].code, "not_a_file");

  const big = cli(["validate", put(d, "big.json", "x".repeat(LIMITS.rawBytes + 1))]);
  assert.equal(big.status, 2);
  assert.equal(big.json().issues[0].code, "too_large");
  assert.equal(cli(["validate", put(d, "max.json", " ".repeat(LIMITS.rawBytes))]).status, 1); // exactly at the limit is read (and is then invalid JSON)

  const bin = cli(["validate", put(d, "bin.json", Buffer.from([0x7b, 0xff, 0xfe, 0x7d]))]);
  assert.equal(bin.status, 2);
  assert.equal(bin.json().issues[0].code, "invalid_encoding");
});

test("validate: a FIFO is refused instead of blocking", () => {
  const d = tmp("vcli");
  const fifo = join(d, "pipe");
  if (spawnSync("mkfifo", [fifo]).status !== 0) return; // not available: nothing to assert
  const r = cli(["validate", fifo]);
  assert.equal(r.status, 2);
  assert.equal(r.json().issues[0].code, "not_a_file");
});

test("validate: an unreadable file is a file_error (skipped when the process can read it anyway, e.g. root)", () => {
  const d = tmp("vcli");
  const p = put(d, "secret.json", exampleText);
  chmodSync(p, 0o000);
  try {
    if (spawnSync("test", ["-r", p]).status === 0) return;
    const r = cli(["validate", p]);
    assert.equal(r.status, 2);
    assert.equal(r.json().issues[0].code, "file_unreadable");
    assert.ok(!r.stdout.includes(d));
  } finally {
    chmodSync(p, 0o600);
  }
});

test("validate: usage errors exit 64 and print nothing on stdout", () => {
  const r = cli(["validate"]);
  assert.equal(r.status, 64);
  assert.equal(r.stdout, "");
  assert.match(r.stderr, /usage/);
});

test("validateFile never throws on odd paths", () => {
  for (const p of ["", "\0", "a\0b", "/", "/dev/null", ".", "..", "x".repeat(5000)]) {
    let r: ReturnType<typeof validateFile> | undefined;
    assert.doesNotThrow(() => { r = validateFile(p); }, JSON.stringify(p));
    assert.notEqual(r!.exit, 0, JSON.stringify(p));
  }
});

test("validate does not modify state, approval or revision (PENDING and APPROVED), and creates nothing in the data directory", () => {
  const s = sandbox();
  const d = tmp("vcli");
  const reg = cli(["register", put(d, "design.json", JSON.stringify({ screen: "x", version: "A" })), s.project], { data: s.data });
  assert.equal(reg.status, 0, reg.stderr);
  assert.equal(load(s.data, s.project).status, "PENDING");
  const h12 = hashDesign({ screen: "x", version: "A" }).slice(0, 12);

  const before = snapshot(s.data);
  for (const t of [exampleText, "{", JSON.stringify({ schemaVersion: 2 })]) cli(["validate", put(d, "c.json", t)], { data: s.data });
  assert.equal(snapshot(s.data), before, "PENDING state changed");

  assert.match(prompt(s, `prevue approve ${h12}`).stdout, /approved by the developer/);
  const approved = load(s.data, s.project);
  assert.equal(approved.status, "APPROVED");
  const before2 = snapshot(s.data);
  for (const t of [exampleText, "{", JSON.stringify({ schemaVersion: 2 })]) cli(["validate", put(d, "c.json", t)], { data: s.data });
  assert.equal(snapshot(s.data), before2, "APPROVED state changed");
  const after = load(s.data, s.project);
  assert.equal(after.status, "APPROVED");
  assert.equal((after as any).state.revision, (approved as any).state.revision);
  assert.equal(evaluate(env(s), "Write", { file_path: join(s.project, "a.txt"), content: "x" }).decision, "allow"); // approved design stays approved
});

test("validate with no state at all creates no state (the gate would still treat a missing file as INVALID)", () => {
  const s = sandbox();
  cli(["validate", put(tmp("vcli"), "ok.json", exampleText)], { data: s.data });
  assert.deepEqual(readdirSync(s.data), []);
  assert.equal(load(s.data, s.project).status, "INVALID");
});

// ---- regression: existing commands and Phase 1a behaviour are unchanged -----------------------------------------------

test("register is unchanged: it still takes arbitrary JSON (the experiment harness relies on this), is idempotent, and needs CLAUDE_PLUGIN_DATA", () => {
  const s = sandbox();
  const d = tmp("vcli");
  const design = { screen: "expense dashboard", layout: "sidebar+cards", version: "A" };
  const p = put(d, "design.json", JSON.stringify(design));
  const r1 = cli(["register", p, s.project], { data: s.data });
  assert.equal(r1.status, 0, r1.stderr);
  assert.equal(r1.json().state.revision, 1);
  assert.equal(r1.json().state.designHash, hashDesign(design));
  assert.equal(r1.json().changed, true);
  const r2 = cli(["register", p, s.project], { data: s.data });
  assert.equal(r2.json().changed, false);
  assert.equal(r2.json().state.revision, 1);
  assert.equal(cli(["status", s.project], { data: s.data }).json().status, "PENDING");
  const noData = cli(["register", p, s.project]);
  assert.equal(noData.status, 64);
  assert.match(noData.stderr, /CLAUDE_PLUGIN_DATA must be set/);
  assert.equal(cli(["bogus"], { data: s.data }).status, 64);
});

test("approve is unchanged: only the UserPromptSubmit hook approves, and the CLI still has no approve command", () => {
  const s = sandbox();
  const d = tmp("vcli");
  const design = { screen: "a" };
  cli(["register", put(d, "d.json", JSON.stringify(design)), s.project], { data: s.data });
  assert.equal(cli(["approve", hashDesign(design).slice(0, 12), s.project], { data: s.data }).status, 64);
  assert.equal(load(s.data, s.project).status, "PENDING");
  assert.match(prompt(s, "prevue approve 00000000").stdout, /REJECTED/);
  assert.match(prompt(s, `prevue approve ${hashDesign(design).slice(0, 12)}`).stdout, /approved by the developer/);
  assert.equal(load(s.data, s.project).status, "APPROVED");
});

test("a validated Phase 1a spec still registers as before and stays PENDING", () => {
  const s = sandbox();
  const r = validateSpec(example());
  assert.ok(r.ok);
  const reg = registerDesign(s.data, s.project, (r as any).spec);
  assert.equal(reg.state.designHash, "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5");
  assert.equal(reg.state.approvedRevision, null);
});

test("the validation path (spec modules, validate-cli, the MCP server) never imports state-changing, gate, hook or approval code", () => {
  const src = join(import.meta.dirname, "..", "src");
  const importsOf = (file: string) => {
    const text = readFileSync(join(src, file), "utf8");
    return { text, specs: [...text.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]!) };
  };
  const allowed: Record<string, string[]> = {
    "validate-cli.js": ["node:fs", "./spec/schema.js", "./spec/validate.js"],
    "index.js": ["@modelcontextprotocol/sdk/server/mcp.js", "@modelcontextprotocol/sdk/server/stdio.js", "zod", "./spec/schema.js", "./spec/validate.js"],
    "spec/schema.js": ["zod"],
    "spec/validate.js": ["../state.js", "./schema.js"],
  };
  for (const [file, ok] of Object.entries(allowed)) {
    const { text, specs } = importsOf(file);
    for (const spec of specs) assert.ok(ok.includes(spec), `${file} imports ${spec}`);
    assert.ok(!/\b(approve|initIfMissing|registerDesign|reset|load|withLock|writeAtomic)\b\s*\(/.test(text), `${file} calls state code`);
    assert.ok(!/CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR/.test(text.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), `${file} reads Prevue environment variables in code`);
  }
  for (const m of importsOf("spec/validate.js").text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\.\/state\.js["']/g)) assert.equal(m[1]!.trim(), "hashDesign");
  // Only the CLI wrapper may touch the filesystem; the validation modules and the MCP server must not.
  for (const f of ["spec/schema.js", "spec/validate.js", "index.js"]) assert.ok(!/node:fs|node:child_process|node:net|node:http|fetch\(/.test(importsOf(f).text), `${f} uses fs/network`);
  assert.ok(existsSync(join(src, "validate-cli.js")));
});
