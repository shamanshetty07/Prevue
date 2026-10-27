import { strict as assert } from "node:assert";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LIMITS } from "../src/spec/schema.js";
import { approve, load, paths } from "../src/state.js";
import { sandbox, tmp, type Sandbox } from "./helpers.js";

const SERVER = join(import.meta.dirname, "..", "src", "index.js");
const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const HASH = "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5";

/** The server is started with a working directory that is NOT the project, as Claude Code may do. */
async function withClient<T>(env: Record<string, string>, fn: (c: Client) => Promise<T>, cwd = tmp("mcp-cwd")): Promise<T> {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER], env: { PATH: process.env.PATH ?? "", ...env }, cwd });
  const client = new Client({ name: "prevue-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
const full = (s: Sandbox) => ({ CLAUDE_PLUGIN_DATA: s.data, CLAUDE_PROJECT_DIR: s.project });
const call = (c: Client, name: string, spec: unknown) => c.callTool({ name, arguments: { spec } as any }) as Promise<any>;

test("MCP register: success returns a structured result, stores the design, and approves nothing", async () => {
  const s = sandbox();
  await withClient(full(s), async (c) => {
    const res = await call(c, "prevue_register_design", exampleText);
    assert.notEqual(res.isError, true);
    const sc = res.structuredContent;
    assert.deepEqual([sc.registered, sc.approvedByThisCall, sc.outcome, sc.changed, sc.revision, sc.status, sc.hash, sc.design], [true, false, "created", true, 1, "PENDING", HASH, "written"]);
    assert.deepEqual(JSON.parse(res.content[0].text), sc);
    const again = (await call(c, "prevue_register_design", exampleText)).structuredContent;
    assert.deepEqual([again.outcome, again.revision], ["unchanged", 1]);
  });
  const l = load(s.data, s.project) as any;
  assert.deepEqual([l.status, l.state.revision, l.state.canonical, l.state.approvedRevision], ["PENDING", 1, true, null]);
  assert.ok(existsSync(join(paths(s.data, s.project).dir, "designs", `${HASH}.json`)));
});

test("MCP register: the project comes from CLAUDE_PROJECT_DIR, never from the server's working directory", async () => {
  const s = sandbox();
  const cwd = tmp("elsewhere");
  await withClient(full(s), async (c) => {
    assert.equal((await call(c, "prevue_register_design", exampleText)).structuredContent.registered, true);
  }, cwd);
  assert.equal((load(s.data, s.project) as any).state.revision, 1);
  assert.deepEqual(readdirSync(cwd), []);
  // Without CLAUDE_PROJECT_DIR the server refuses, even though its cwd is a perfectly good directory.
  const t = sandbox();
  await withClient({ CLAUDE_PLUGIN_DATA: t.data }, async (c) => {
    const sc = (await call(c, "prevue_register_design", exampleText)).structuredContent;
    assert.deepEqual([sc.registered, sc.kind, sc.code], [false, "config_error", "env_project_dir"]);
  }, t.project);
  assert.deepEqual(readdirSync(t.data), []);
});

test("MCP register: a missing, empty or relative data directory is a structured failure and creates nothing", async () => {
  const s = sandbox();
  const extras: Array<Record<string, string>> = [{}, { CLAUDE_PLUGIN_DATA: "" }, { CLAUDE_PLUGIN_DATA: "relative" }];
  for (const extra of extras) {
    await withClient({ CLAUDE_PROJECT_DIR: s.project, ...extra }, async (c) => {
      const res = await call(c, "prevue_register_design", exampleText);
      assert.notEqual(res.isError, true);
      assert.deepEqual([res.structuredContent.registered, res.structuredContent.code], [false, "env_data_dir"]);
    }, s.project);
  }
  assert.deepEqual(readdirSync(s.project), []);
  assert.deepEqual(readdirSync(s.data), []);
});

test("MCP register: invalid, duplicate-key and oversized specifications are bounded structured failures that change nothing", async () => {
  const s = sandbox();
  await withClient(full(s), async (c) => {
    const bad = [["{", "invalid_json"], ['{"schemaVersion":2}', "unsupported_version"], [exampleText.replace('"name": "Expense dashboard"', '"name": "LEAK-MARKER", "name": "x"'), "duplicate_key"], ["x".repeat(LIMITS.rawBytes + 1), "too_large"]];
    for (const [text, code] of bad) {
      const res = await call(c, "prevue_register_design", text);
      assert.notEqual(res.isError, true, code);
      assert.deepEqual([res.structuredContent.registered, res.structuredContent.code], [false, code]);
      assert.ok(res.structuredContent.issues.length <= 50 && res.content[0].text.length < 30_000);
      assert.ok(!res.content[0].text.includes("LEAK-MARKER"));
    }
    const huge = await call(c, "prevue_register_design", "y".repeat(10 * LIMITS.rawBytes + 1));
    assert.equal(huge.isError, true);
    assert.ok(huge.content[0].text.length < 500 && !huge.content[0].text.includes("yyyyyyyy"));
    for (const v of [42, null, { a: 1 }]) assert.equal((await call(c, "prevue_register_design", v)).isError, true);
  });
  assert.deepEqual(readdirSync(s.data), []);
});

test("MCP register: a refused registration reports a code and does not disturb an existing approval", async () => {
  const s = sandbox();
  await withClient(full(s), async (c) => {
    await call(c, "prevue_register_design", exampleText);
    approve(s.data, s.project, HASH.slice(0, 12));
    const before = readFileSync(paths(s.data, s.project).file, "utf8");
    // Corrupt the registered design: registering the same design again must be refused, not silently repaired.
    writeFileSync(join(paths(s.data, s.project).dir, "designs", `${HASH}.json`), "{");
    const res = await call(c, "prevue_register_design", exampleText);
    assert.deepEqual([res.structuredContent.registered, res.structuredContent.code, res.structuredContent.kind], [false, "stored_design_unverifiable", "refused"]);
    assert.equal(readFileSync(paths(s.data, s.project).file, "utf8"), before);
    assert.ok(!JSON.stringify(res).includes(s.data));
  });
});

test("MCP: validation is still read-only when the registration tool exists", async () => {
  const s = sandbox();
  await withClient(full(s), async (c) => {
    const v = await call(c, "prevue_validate_spec", exampleText);
    assert.deepEqual([v.structuredContent.valid, v.structuredContent.registered], [true, false]);
  });
  assert.deepEqual(readdirSync(s.data), []);
});
