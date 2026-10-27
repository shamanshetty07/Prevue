import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { registerCanonical } from "./register.js";
import { LIMITS } from "./spec/schema.js";
import { parseSpecText, specReport } from "./spec/validate.js";

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

const issueShape = z.object({ path: z.string(), code: z.string(), message: z.string() });

server.registerTool(
  "prevue_validate_spec",
  {
    title: "Validate a Prevue UI specification",
    description:
      "Checks candidate UI specification JSON text against Prevue's schema and returns the normalized spec and its hash, or structured issues. " +
      "Pure: it registers nothing, stores nothing and approves nothing. A valid spec is not an approved design; only the developer can approve.",
    inputSchema: {
      spec: z.string().max(10 * LIMITS.rawBytes).describe("The specification as JSON text (at most 64 KB)"),
    },
    outputSchema: {
      valid: z.boolean(),
      registered: z.literal(false),
      approved: z.literal(false),
      kind: z.enum(["parse_error", "schema_error"]).optional(),
      schemaVersion: z.literal(1).optional(),
      hash: z.string().optional(),
      stats: z.object({ nodes: z.number(), depth: z.number() }).optional(),
      spec: z.record(z.string(), z.unknown()).optional(),
      issues: z.array(issueShape).optional(),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  // An invalid spec is a normal, successful tool result with valid:false (not an MCP error), so the caller can read the issues.
  async ({ spec }) => {
    const report = specReport(parseSpecText(spec));
    return { content: [{ type: "text", text: JSON.stringify(report) }], structuredContent: report as Record<string, unknown> };
  },
);

server.registerTool(
  "prevue_register_design",
  {
    title: "Register a Prevue UI design",
    description:
      "Validates the specification, stores its normalized canonical form, and registers its hash as a new pending revision, which clears any earlier approval. " +
      "It never approves: only the developer can, by typing `prevue approve <hash>`. Unlike prevue_validate_spec it changes state, so Prevue's gate only lets it run once a design is already approved. " +
      "Registering an identical design is a no-op.",
    inputSchema: { spec: z.string().max(10 * LIMITS.rawBytes).describe("The specification as JSON text (at most 64 KB)") },
    outputSchema: {
      registered: z.boolean(),
      approvedByThisCall: z.literal(false),
      outcome: z.enum(["created", "updated", "unchanged"]).optional(),
      changed: z.boolean().optional(),
      revision: z.number().optional(),
      hash: z.string().optional(),
      status: z.enum(["PENDING", "APPROVED"]).optional(),
      design: z.enum(["written", "reused"]).optional(),
      kind: z.enum(["parse_error", "schema_error", "config_error", "refused", "failed"]).optional(),
      code: z.string().optional(),
      message: z.string().optional(),
      issues: z.array(issueShape).optional(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  // A refused or failed registration is a normal result with registered:false, so the caller can read the code.
  async ({ spec }) => {
    const { ok: _ok, ...result } = registerCanonical(process.env, spec);
    return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result as Record<string, unknown> };
  },
);

// stdout is the protocol channel; diagnostics go to stderr only.
process.on("uncaughtException", (e) => {
  console.error("prevue: fatal:", e);
  process.exit(1);
});

await server.connect(new StdioServerTransport());
console.error("prevue: MCP server running on stdio (phase 0)");
