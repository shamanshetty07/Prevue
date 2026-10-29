import { readDesignFile, type DesignFailure } from "./design-store.js";
import type { UiSpec } from "./spec/schema.js";
import { load } from "./state.js";

/**
 * The preview's only view of Prevue state: the current registered design of one project, or a reason there is none.
 * Read-only by construction: it calls `load` and `readDesignFile` and nothing that writes, registers, approves or resets.
 * The project and data directory are fixed by whoever starts the preview; no caller-supplied path, hash or revision is
 * accepted, so a request can only ever see the design the state itself points at, after the gate's own integrity checks.
 * Failures carry a code and a fixed message only: no paths, parser output or file content.
 */
export type DesignView =
  | { ok: true; status: "PENDING" | "APPROVED"; revision: number; hash: string; approved: boolean; spec: UiSpec }
  | { ok: false; code: "no_state" | "state_invalid" | "no_design" | "no_canonical_design" | DesignFailure; message: string };

const MESSAGES: Record<string, string> = {
  no_state: "Prevue has no state for this project yet. Start a Claude Code session with the plugin enabled.",
  state_invalid: "Prevue's state for this project is invalid. The developer can recover it with `prevue reset`.",
  no_design: "No design has been registered yet.",
  no_canonical_design: "The current registration has no stored canonical design (it predates canonical storage). Register it again.",
  design_missing: "The stored design for the current revision is missing.",
  design_untrusted: "The stored design is not a regular file in the design store, so it was not read.",
  design_unreadable: "The stored design could not be read.",
  design_too_large: "The stored design is larger than the allowed size.",
  design_invalid: "The stored design is not a valid specification.",
  design_hash_mismatch: "The stored design does not match the registered hash.",
};
const fail = (code: Extract<DesignView, { ok: false }>["code"]): DesignView => ({ ok: false, code, message: MESSAGES[code] ?? "The design could not be loaded." });

export function loadCurrentDesign(dataDir: string, projectDir: string): DesignView {
  const l = load(dataDir, projectDir);
  if (l.status === "INVALID") return fail(l.missing ? "no_state" : "state_invalid");
  const s = l.state;
  if (s.designHash === null) return fail("no_design");
  if (!s.canonical) return fail("no_canonical_design");
  const d = readDesignFile(dataDir, projectDir, s.designHash);
  if (!d.ok) return fail(d.code);
  return { ok: true, status: l.status, revision: s.revision, hash: s.designHash, approved: l.status === "APPROVED", spec: d.spec };
}
