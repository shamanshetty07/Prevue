import { strict as assert } from "node:assert";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LIMITS } from "../src/spec/schema.js";
import { specHash, validateSpec } from "../src/spec/validate.js";
import { load, registerDesign } from "../src/state.js";
import { sandbox } from "./helpers.js";

const SERVER = join(import.meta.dirname, "..", "src", "index.js");
const repoRoot = process.env.PREVUE_REPO_ROOT ?? join(import.meta.dirname, "..", "..", "..");
const exampleText = readFileSync(join(repoRoot, "docs", "examples", "expense-dashboard.json"), "utf8");
const example = (): any => JSON.parse(exampleText);

/** Starts the real server over stdio. Prevue's data directory is passed in so any state access would be visible. */
async function withClient<T>(data: string | undefined, fn: (c: Client) => Promise<T>): Promise<T> {
  const transport = new StdioClientTransport({ command: "node", args: [SERVER], env: { PATH: process.env.PATH ?? "", ...(data ? { CLAUDE_PLUGIN_DATA: data } : {}) } });
  const client = new Client({ name: "prevue-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    return await fn(client);
  } finally {
    await client.close();
  }
}
const validate = (c: Client, spec: unknown) => c.callTool({ name: "prevue_validate_spec", arguments: { spec } as any }) as Promise<any>;

function snapshot(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d).sort()) {
      const p = join(d, n);
      const st = statSync(p, { bigint: true });
      out.push(`${p}|${st.isDirectory() ? "dir" : readFileSync(p).toString("base64")}|${st.mtimeNs}`);
      if (st.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.join("\n");
}

test("MCP: the tool is listed with a read-only annotation, and there is no registration or approval tool", async () => {
  await withClient(undefined, async (c) => {
    const { tools } = await c.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["prevue_ping", "prevue_validate_spec"]);
    const t = tools.find((x) => x.name === "prevue_validate_spec")!;
    assert.equal(t.annotations?.readOnlyHint, true);
    assert.equal(t.annotations?.destructiveHint, false);
    assert.ok(t.outputSchema);
    assert.match(t.description ?? "", /not an approved design/);
    assert.ok(!tools.some((x) => /register|approve|reset/i.test(x.name)));
  });
});

test("MCP: a valid specification returns valid:true, the normalized spec and the same hash as the CLI/engine", async () => {
  await withClient(undefined, async (c) => {
    const res = await validate(c, exampleText);
    assert.notEqual(res.isError, true);
    const sc = res.structuredContent;
    const expected = validateSpec(example());
    assert.ok(expected.ok);
    assert.equal(sc.valid, true);
    assert.equal(sc.registered, false);
    assert.equal(sc.approved, false);
    assert.equal(sc.schemaVersion, 1);
    assert.equal(sc.hash, specHash((expected as any).spec));
    assert.equal(sc.hash, "35697edb15a494a516be9faf1075a9b41ddc7c6ea0ba0e8d92808e37a94c4cd5");
    assert.deepEqual(sc.stats, { nodes: 9, depth: 1 });
    assert.deepEqual(sc.spec, JSON.parse(JSON.stringify((expected as any).spec)));
    assert.deepEqual(JSON.parse(res.content[0].text), sc); // text and structured content agree
    assert.equal((await validate(c, JSON.stringify(example(), null, 8))).structuredContent.hash, sc.hash);
  });
});

test("MCP: malformed JSON is a normal result with kind parse_error, and the text is not echoed", async () => {
  await withClient(undefined, async (c) => {
    for (const t of ["", "{", '{"schemaVersion": 1, "leak": "TOP-SECRET-MARKER" oops}', "[1,]", "﻿{}"]) {
      const res = await validate(c, t);
      assert.notEqual(res.isError, true, JSON.stringify(t));
      assert.equal(res.structuredContent.valid, false);
      assert.equal(res.structuredContent.kind, "parse_error");
      assert.equal(res.structuredContent.issues[0].code, "invalid_json");
      assert.ok(!res.content[0].text.includes("TOP-SECRET-MARKER") && !res.content[0].text.includes("oops"));
    }
    const big = await validate(c, "x".repeat(LIMITS.rawBytes + 1));
    assert.equal(big.structuredContent.issues[0].code, "too_large");
    assert.ok(big.content[0].text.length < 500);
  });
});

test("MCP: a schema-invalid specification returns structured, bounded issues and no spec or hash", async () => {
  await withClient(undefined, async (c) => {
    const s = example();
    delete s.screen.purpose;
    s.theme.accent = "TOP-SECRET-MARKER";
    s.layout.main.children[1].content = "x".repeat(600) + "TOP-SECRET-MARKER";
    s.layout.main.children.push({ type: "script", src: "https://evil.example/x.js" });
    const res = await validate(c, JSON.stringify(s));
    const sc = res.structuredContent;
    assert.equal(res.isError === true, false);
    assert.equal(sc.valid, false);
    assert.equal(sc.kind, "schema_error");
    const codes = sc.issues.map((i: any) => `${i.code}@${i.path}`);
    for (const c2 of ["missing_field@/screen/purpose", "invalid_value@/theme/accent", "unknown_component@/layout/main/children/3/type"]) assert.ok(codes.includes(c2), `${c2} in ${codes}`);
    assert.ok(codes.some((c2: string) => c2.startsWith("limit_exceeded@/layout/main/children/1/content")));
    assert.ok(!("spec" in sc) && !("hash" in sc));
    assert.ok(!res.content[0].text.includes("TOP-SECRET-MARKER") && !res.content[0].text.includes("evil.example"));
    for (const i of sc.issues) assert.ok(i.message.length <= 200 && i.path.length <= 200);
    assert.equal((await validate(c, JSON.stringify({ ...example(), schemaVersion: 2 }))).structuredContent.issues[0].code, "unsupported_version");
  });
});

test("MCP: responses stay bounded for hostile input (issue count capped, oversize rejected without echo)", async () => {
  await withClient(undefined, async (c) => {
    const s = example();
    s.layout.main.children = Array.from({ length: 12 }, () => ({ type: "grid", columns: 9, children: Array.from({ length: 12 }, () => ({ type: "nope", junk: "z".repeat(50) })) }));
    const res = await validate(c, JSON.stringify(s));
    assert.equal(res.structuredContent.valid, false);
    assert.ok(res.structuredContent.issues.length <= 50);
    assert.ok(res.content[0].text.length < 30_000, `${res.content[0].text.length} bytes`);

    const tooBig = await validate(c, "y".repeat(10 * LIMITS.rawBytes + 1)); // beyond the tool's input limit: a protocol-level error
    assert.equal(tooBig.isError, true);
    assert.ok(tooBig.content[0].text.length < 500);
    assert.ok(!tooBig.content[0].text.includes("yyyyyyyy"));

    for (const bad of [42, null, { a: 1 }, ["x"]]) assert.equal((await validate(c, bad)).isError, true, JSON.stringify(bad));
    const noArg = (await c.callTool({ name: "prevue_validate_spec", arguments: {} })) as any;
    assert.equal(noArg.isError, true);
  });
});

test("MCP: validation does not register, approve, persist or change revision, even with the data directory available", async () => {
  const s = sandbox();
  registerDesign(s.data, s.project, { screen: "existing", version: "A" });
  const before = snapshot(s.data);
  const rev = (load(s.data, s.project) as any).state.revision;
  await withClient(s.data, async (c) => {
    await validate(c, exampleText);
    await validate(c, "{");
    await validate(c, JSON.stringify({ schemaVersion: 2 }));
    await validate(c, JSON.stringify(example()));
  });
  assert.equal(snapshot(s.data), before);
  const after = load(s.data, s.project) as any;
  assert.equal(after.status, "PENDING");
  assert.equal(after.state.revision, rev);
  assert.equal(after.state.approvedRevision, null);

  const empty = sandbox();
  await withClient(empty.data, async (c) => {
    await validate(c, exampleText);
  });
  assert.deepEqual(readdirSync(empty.data), []);
  assert.equal(load(empty.data, empty.project).status, "INVALID"); // nothing was created
});

test("MCP: prevue_ping is unchanged", async () => {
  await withClient(undefined, async (c) => {
    const res = (await c.callTool({ name: "prevue_ping", arguments: {} })) as any;
    assert.deepEqual(res.structuredContent, { service: "prevue", status: "ok", phase: 0 });
    assert.equal(((await c.callTool({ name: "prevue_ping", arguments: { message: "hi" } })) as any).structuredContent.echo, "hi");
  });
});
