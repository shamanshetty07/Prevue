import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Approval gate state for one project. Stored at <project>/.prevue/state.json.
 *
 * The gate is inactive when no state file exists (no design has been registered).
 * An approval is bound to a design hash, so any design change invalidates it.
 */
export interface GateState {
  designVersion: number;
  designHash: string;
  approvedHash: string | null;
  approvedAt: string | null;
}

export type Decision = { decision: "allow" } | { decision: "deny"; reason: string };

export const statePath = (projectDir: string): string => join(projectDir, ".prevue", "state.json");

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => a.localeCompare(b)))
      : val,
  );

export const hashDesign = (spec: unknown): string =>
  createHash("sha256").update(canonical(spec)).digest("hex");

/** Returns null when the gate is inactive. Throws on a corrupt file (callers fail closed). */
export function readState(projectDir: string): GateState | null {
  let raw: string;
  try {
    raw = readFileSync(statePath(projectDir), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  const s = JSON.parse(raw) as Partial<GateState>;
  if (
    typeof s.designVersion !== "number" ||
    typeof s.designHash !== "string" ||
    !(s.approvedHash === null || typeof s.approvedHash === "string")
  ) {
    throw new Error(`Corrupt Prevue state file: ${statePath(projectDir)}`);
  }
  return s as GateState;
}

function writeState(projectDir: string, s: GateState): void {
  const p = statePath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, p);
}

/** Register a new (or changed) design. Existing approval stays on file but no longer matches. */
export function setDesign(projectDir: string, spec: unknown): GateState {
  const prev = readState(projectDir);
  const next: GateState = {
    designVersion: (prev?.designVersion ?? 0) + 1,
    designHash: hashDesign(spec),
    approvedHash: prev?.approvedHash ?? null,
    approvedAt: prev?.approvedAt ?? null,
  };
  writeState(projectDir, next);
  return next;
}

export const isApproved = (s: GateState): boolean => s.approvedHash === s.designHash;

/**
 * Approve the current design. If hashPrefix is given it must match the current design hash,
 * so a user can only approve the exact design they looked at.
 */
export function approve(projectDir: string, hashPrefix?: string): GateState {
  const s = readState(projectDir);
  if (!s) throw new Error("No design registered; nothing to approve.");
  if (hashPrefix && !s.designHash.startsWith(hashPrefix.toLowerCase())) {
    throw new Error(
      `Design hash ${hashPrefix} does not match current design ${s.designHash.slice(0, 12)} (v${s.designVersion}). Not approved.`,
    );
  }
  const next = { ...s, approvedHash: s.designHash, approvedAt: new Date().toISOString() };
  writeState(projectDir, next);
  return next;
}

const FILE_WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const SHELL_META = /[;&|<>`$\\\n\r(){}]/;
const READ_ONLY_CMDS = new Set(["ls", "pwd", "cat", "head", "tail", "wc", "grep", "echo", "which", "file", "stat"]);
const READ_ONLY_GIT = new Set(["status", "diff", "log", "show", "rev-parse"]);

/**
 * Conservative allowlist for shell commands that cannot modify files.
 * Anything not provably read-only is rejected (fail closed).
 */
export function isReadOnlyBash(command: string): boolean {
  if (SHELL_META.test(command)) return false;
  const words = command.trim().split(/\s+/);
  const [cmd, sub] = words;
  if (!cmd) return false;
  if (cmd === "git") return READ_ONLY_GIT.has(sub ?? "") && !words.some((w) => w.startsWith("--output"));
  if (cmd === "find") return !words.some((w) => /^-(exec|execdir|ok|okdir|delete|fprint|fprint0|fprintf|fls)$/.test(w));
  return READ_ONLY_CMDS.has(cmd);
}

const touchesPrevueDir = (toolInput: Record<string, unknown>): boolean =>
  /(^|[^\w.-])\.prevue\b/.test(JSON.stringify(toolInput));

/** Decide whether a tool call may proceed. Pure with respect to the state file. */
export function evaluate(projectDir: string, toolName: string, toolInput: Record<string, unknown>): Decision {
  const state = readState(projectDir);
  if (!state) return { decision: "allow" };

  const readOnlyBash = toolName === "Bash" && isReadOnlyBash(String(toolInput.command ?? ""));

  // The model must never be able to forge approval by editing the state file.
  if (touchesPrevueDir(toolInput) && !readOnlyBash && toolName !== "Read" && toolName !== "Grep" && toolName !== "Glob") {
    return { decision: "deny", reason: "Prevue: .prevue/ holds approval state and is not writable by the agent." };
  }

  if (isApproved(state)) return { decision: "allow" };

  const blocked =
    FILE_WRITE_TOOLS.has(toolName) || (toolName === "Bash" && !readOnlyBash);
  if (!blocked) return { decision: "allow" };

  return {
    decision: "deny",
    reason:
      `Prevue: design v${state.designVersion} (${state.designHash.slice(0, 12)}) is not approved, so ${toolName} is blocked. ` +
      `Ask the developer to review the design and reply with "prevue approve ${state.designHash.slice(0, 12)}".`,
  };
}

/** Matches the developer-typed approval phrase. Capture group 1 is the optional hash prefix. */
export const APPROVE_PROMPT = /^\s*prevue approve(?:\s+([0-9a-f]{6,64}))?\s*$/i;
