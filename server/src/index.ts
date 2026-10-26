import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "prevue", version: "0.0.1" });

server.registerTool(
  "prevue_ping",
  {
    title: "Prevue ping",
    description: "Health check for the Prevue proof-of-concept MCP server. Takes no side effects.",
    inputSchema: { message: z.string().max(200).optional().describe("Optional text echoed back") },
    outputSchema: {
      service: z.literal("prevue"),
      status: z.literal("ok"),
      phase: z.literal(0),
      echo: z.string().optional(),
    },
  },
  async ({ message }) => {
    const result = { service: "prevue" as const, status: "ok" as const, phase: 0 as const, ...(message ? { echo: message } : {}) };
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result };
  },
);

// stdout is the protocol channel; diagnostics go to stderr only.
process.on("uncaughtException", (e) => {
  console.error("prevue: fatal:", e);
  process.exit(1);
});

await server.connect(new StdioServerTransport());
console.error("prevue: MCP server running on stdio (phase 0)");
