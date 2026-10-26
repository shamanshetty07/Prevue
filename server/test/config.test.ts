import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

// Static checks only. The authoritative check is `claude plugin validate` (see README).
const root = join(import.meta.dirname, "..", "..", "..");
const json = (p: string) => JSON.parse(readFileSync(join(root, p), "utf8"));

test("plugin.json: only documented fields, kebab-case name", () => {
  const m = json(".claude-plugin/plugin.json");
  assert.equal(m.name, "prevue");
  const documented = new Set(["name", "displayName", "version", "description", "author", "homepage", "repository", "license", "keywords"]);
  for (const k of Object.keys(m)) assert.ok(documented.has(k), `unexpected field ${k}`);
});

test(".mcp.json: wrapped in mcpServers, stdio, uses CLAUDE_PLUGIN_ROOT", () => {
  const s = json(".mcp.json").mcpServers.prevue;
  assert.equal(s.command, "node");
  assert.ok(s.args[0].startsWith("${CLAUDE_PLUGIN_ROOT}/"));
});

test("hooks.json: wrapper, known events, fail-closed PreToolUse", () => {
  const h = json("hooks/hooks.json").hooks;
  assert.deepEqual(Object.keys(h).sort(), ["PreToolUse", "UserPromptSubmit"]);
  const pre = h.PreToolUse[0].hooks[0];
  assert.equal(pre.type, "command");
  assert.equal(pre.onFailure, "block");
});

test("SKILL.md: frontmatter with name+description, no unsupported fields", () => {
  const p = "skills/ui-preview/SKILL.md";
  assert.ok(existsSync(join(root, p)));
  const text = readFileSync(join(root, p), "utf8");
  const fm = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(fm, "frontmatter missing");
  const keys = [...fm[1].matchAll(/^([a-z-]+):/gm)].map((m) => m[1]);
  assert.ok(keys.includes("description"));
  for (const k of keys) assert.ok(["name", "description", "when_to_use", "disable-model-invocation", "user-invocable", "allowed-tools", "paths"].includes(k), k);
  assert.ok(fm[1].length < 1536);
});
