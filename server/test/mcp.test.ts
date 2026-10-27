import { strict as assert } from "node:assert";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("MCP server starts over stdio and prevue_ping responds", async () => {
  const transport = new StdioClientTransport({ command: "node", args: [join(import.meta.dirname, "..", "src", "index.js")] });
  const client = new Client({ name: "prevue-test", version: "0.0.0" });
  await client.connect(transport);
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ["prevue_ping", "prevue_validate_spec"]); // validation is pure; there is no registration or approval tool

    const res = await client.callTool({ name: "prevue_ping", arguments: {} });
    assert.deepEqual(res.structuredContent, { service: "prevue", status: "ok", phase: 0 });

    const echo = await client.callTool({ name: "prevue_ping", arguments: { message: "hi" } });
    assert.equal((echo.structuredContent as { echo: string }).echo, "hi");

    const bad = await client.callTool({ name: "prevue_ping", arguments: { message: 42 } });
    assert.equal(bad.isError, true); // invalid input is reported, not swallowed
  } finally {
    await client.close();
  }
});
