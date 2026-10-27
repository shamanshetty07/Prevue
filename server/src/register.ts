import { closeSync, constants, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { verifyDesignFile, verifyStoredDesign } from "./design-store.js";
import { resolveRuntime } from "./runtime.js";
import { LIMITS } from "./spec/schema.js";
import { parseSpecText, type SpecIssue } from "./spec/validate.js";
import { canonicalJson, load, paths, registerLocked, withLock, type GateState } from "./state.js";

/**
 * Registers a validated UI specification: stores its canonical form, then records its hash and a new revision.
 * Registration never approves. Everything from the state check to the state write happens under the state lock
 * that `registerDesign` and `approve` already use, so concurrent callers see one consistent sequence of revisions.
 *
 * Order, and why it is safe: (1) validate, serialize, size-check, all without touching disk; (2) under the lock, decide
 * from the current state; (3) write and re-verify the content-addressed design file (never overwriting a file); (4) only
 * then update the state, with the `canonical` marker. A failure before (4) leaves the previous state and approval untouched;
 * a failure at (4) can leave an orphan design file, which is harmless (the gate only reads the file the state names).
 */
export const DESIGN_CAP = 50;

export type RegisterOk = {
  ok: true;
  registered: true;
  approvedByThisCall: false;
  outcome: "created" | "updated" | "unchanged";
  changed: boolean;
  revision: number;
  hash: string;
  status: "PENDING" | "APPROVED";
  design: "written" | "reused";
};
export type RegisterFail = {
  ok: false;
  registered: false;
  approvedByThisCall: false;
  kind: "parse_error" | "schema_error" | "config_error" | "refused" | "failed";
  code: string;
  message: string;
  issues?: SpecIssue[];
};
export type RegisterResult = RegisterOk | RegisterFail;

const fail = (kind: RegisterFail["kind"], code: string, message: string, issues?: SpecIssue[]): RegisterFail => ({ ok: false, registered: false, approvedByThisCall: false, kind, code, message, ...(issues ? { issues } : {}) });
const DESIGN_NAME = /^[0-9a-f]{64}\.json$/;

/** Test seam: replaces the final state write, to prove that a failure there leaves the previous state intact. */
export interface RegisterDeps {
  registerState?: typeof registerLocked;
  /** Replaces the 64 KB canonical-size limit (the schema's own limits make that size unreachable, so the check needs a seam to be tested). */
  canonicalLimit?: number;
}

export function registerCanonical(env: NodeJS.ProcessEnv, text: string, projectOverride?: string, deps: RegisterDeps = {}): RegisterResult {
  const rt = resolveRuntime(env, projectOverride);
  if (!rt.ok) return fail("config_error", rt.code, rt.message);

  // 1. Validate and serialize without touching disk.
  const parsed = parseSpecText(text);
  if (!parsed.ok) return fail(parsed.kind, parsed.issues[0]?.code ?? "invalid", "the specification is not valid; nothing was registered", parsed.issues);
  const body = canonicalJson(parsed.spec);
  const limit = deps.canonicalLimit ?? LIMITS.rawBytes;
  if (Buffer.byteLength(body, "utf8") > limit) return fail("refused", "canonical_too_large", `the normalized specification is larger than ${limit} bytes`);
  const hash = parsed.hash;
  const { dataDir, projectDir } = rt;

  const p = paths(dataDir, projectDir);
  try {
    return withLock(p.dir, p.lock, () => {
      // 2. Decide from the current state.
      const cur = load(dataDir, projectDir);
      if (cur.status === "INVALID" && !cur.missing) return fail("refused", "state_invalid", 'the Prevue state is invalid; the developer must run "prevue reset"');
      let unchanged = false;
      if (cur.status !== "INVALID" && cur.state.designHash === hash) {
        if (!cur.state.canonical) return fail("refused", "legacy_registration", 'the current registration of this design predates canonical storage; the developer must run "prevue reset", then register again');
        if (!verifyStoredDesign(dataDir, projectDir, cur.state).ok) return fail("refused", "stored_design_unverifiable", 'the stored design for the current registration cannot be verified; the developer must run "prevue reset"');
        unchanged = true;
      }
      const outcomeFor = (): RegisterOk["outcome"] => (unchanged ? "unchanged" : cur.status === "INVALID" || cur.state.revision === 0 ? "created" : "updated");

      // 3. Persist and verify the design file. Never overwrites, never follows a symlink.
      const dir = join(p.dir, "designs");
      const file = join(dir, `${hash}.json`);
      const store = ensureStore(dir);
      if (store) return store;
      let design: RegisterOk["design"] = "reused";
      let exists = true;
      try {
        if (!lstatSync(file).isFile()) return fail("refused", "design_store_untrusted", "the design store contains an unexpected kind of file");
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") return fail("failed", "design_write_failed", "the design store could not be inspected");
        exists = false;
      }
      if (exists) {
        if (!verifyDesignFile(dataDir, projectDir, hash).ok) return fail("refused", "design_file_conflict", "a file already stored under this hash does not verify; it was not overwritten");
      } else {
        let count = 0;
        try {
          count = readdirSync(dir).filter((n) => DESIGN_NAME.test(n)).length;
        } catch {
          return fail("failed", "design_write_failed", "the design store could not be inspected");
        }
        if (count >= DESIGN_CAP) return fail("refused", "design_cap_reached", `this project already stores ${DESIGN_CAP} designs; none are deleted automatically`);
        const err = writeNew(dir, file, body);
        if (err) return err;
        design = "written";
        if (!verifyDesignFile(dataDir, projectDir, hash).ok) {
          rmSync(file, { force: true }); // we created it a moment ago under the lock; it is ours to remove
          return fail("failed", "design_write_failed", "the stored design did not verify after writing; it was removed");
        }
      }

      // 4. Only now point the state at it. The marker is set here and nowhere earlier.
      if (unchanged) return { ok: true, registered: true, approvedByThisCall: false, outcome: "unchanged", changed: false, revision: (cur as { state: GateState }).state.revision, hash, status: cur.status as "PENDING" | "APPROVED", design };
      try {
        const r = (deps.registerState ?? registerLocked)(dataDir, projectDir, parsed.spec, { canonical: true });
        return { ok: true, registered: true, approvedByThisCall: false, outcome: outcomeFor(), changed: r.changed, revision: r.state.revision, hash, status: "PENDING", design };
      } catch {
        return fail("failed", "state_write_failed", "the state could not be updated; the previous state is unchanged (a stored design file may remain unused)");
      }
    });
  } catch {
    return fail("failed", "lock_failed", "the Prevue state lock could not be acquired or the state directory is not writable");
  }
}

/** Ensures `designs/` exists as a real directory (never a symlink). Returns a failure, or null when usable. */
function ensureStore(dir: string): RegisterFail | null {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") return fail("failed", "design_write_failed", "the design store could not be created");
  }
  try {
    return lstatSync(dir).isDirectory() ? null : fail("refused", "design_store_untrusted", "the design store is not a regular directory");
  } catch {
    return fail("failed", "design_write_failed", "the design store could not be inspected");
  }
}

/** Temp file (exclusive, 0600, fsynced) then a hard link to the final name: link fails if the name exists, so nothing is overwritten. */
function writeNew(dir: string, file: string, body: string): RegisterFail | null {
  const tmp = join(dir, `${file.slice(dir.length + 1)}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`);
  let fd: number | undefined;
  try {
    fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    linkSync(tmp, file);
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EEXIST" ? fail("refused", "design_file_conflict", "a file appeared under this hash while registering; it was not overwritten") : fail("failed", "design_write_failed", "the design file could not be written");
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
    rmSync(tmp, { force: true });
  }
}
