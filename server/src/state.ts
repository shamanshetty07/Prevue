import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, openSync, closeSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Per-project approval state, stored under the plugin data directory
 * (${CLAUDE_PLUGIN_DATA}/projects/<project key>/state.json), not in the project tree.
 *
 *   PENDING   no approved design (including "no design registered yet")
 *   APPROVED  the current revision has been approved
 *   INVALID   state is missing, malformed, inconsistent, or belongs to another project
 *
 * Approval is bound to a revision number, not only to a content hash: every accepted design
 * change bumps `revision` and clears the approval, so A -> B -> A needs a fresh approval.
 * Invariant: approvedRevision is either null or equal to revision.
 */
export type GateStatus = "PENDING" | "APPROVED" | "INVALID";

export interface GateState {
  schema: 2;
  project: string;
  revision: number;
  designHash: string | null;
  approvedRevision: number | null;
  approvedHash: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type Loaded =
  | { status: "PENDING" | "APPROVED"; state: GateState }
  | { status: "INVALID"; reason: string; missing: boolean };

const HEX64 = /^[0-9a-f]{64}$/;
const caseFold = process.platform === "darwin" || process.platform === "win32";

export function normalizePath(p: string): string {
  let r: string;
  try {
    r = realpathSync(p);
  } catch {
    r = resolve(p);
  }
  return caseFold ? r.toLowerCase() : r;
}

export const projectKey = (projectDir: string): string =>
  createHash("sha256").update(normalizePath(projectDir)).digest("hex").slice(0, 32);

export function paths(dataDir: string, projectDir: string) {
  const dir = join(dataDir, "projects", projectKey(projectDir));
  return { dir, file: join(dir, "state.json"), lock: join(dir, "state.lock") };
}

const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(Object.entries(val).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : val,
  );

export const hashDesign = (spec: unknown): string => createHash("sha256").update(canonical(spec)).digest("hex");

const bad = (reason: string, missing = false): Loaded => ({ status: "INVALID", reason, missing });

/** Never throws. Anything that is not a well-formed, self-consistent state for this project is INVALID. */
export function load(dataDir: string, projectDir: string): Loaded {
  const { file } = paths(dataDir, projectDir);
  let st;
  try {
    st = lstatSync(file);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? bad("state file is missing", true) : bad(`state file unreadable: ${(e as Error).message}`);
  }
  if (!st.isFile()) return bad("state path is not a regular file");
  let o: any;
  try {
    o = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return bad(`state file is not valid JSON: ${(e as Error).message}`);
  }
  const isInt = (v: unknown, min: number) => Number.isInteger(v) && (v as number) >= min;
  const hashOrNull = (v: unknown) => v === null || (typeof v === "string" && HEX64.test(v));
  if (!o || typeof o !== "object" || Array.isArray(o)) return bad("state is not an object");
  if (o.schema !== 2) return bad(`unsupported schema ${JSON.stringify(o.schema)}`);
  if (o.project !== projectKey(projectDir)) return bad("state belongs to a different project");
  if (!isInt(o.revision, 0)) return bad("revision is not a non-negative integer");
  if (!hashOrNull(o.designHash) || !hashOrNull(o.approvedHash)) return bad("hash field malformed");
  if ((o.revision === 0) !== (o.designHash === null)) return bad("revision and designHash disagree");
  if (o.approvedRevision !== null && !isInt(o.approvedRevision, 1)) return bad("approvedRevision malformed");
  if ((o.approvedRevision === null) !== (o.approvedHash === null) || (o.approvedRevision === null) !== (o.approvedAt === null))
    return bad("approval fields are partially set");
  if (o.approvedRevision !== null) {
    if (o.approvedRevision !== o.revision) return bad("approvedRevision does not match revision");
    if (o.approvedHash !== o.designHash) return bad("approvedHash does not match designHash");
    if (typeof o.approvedAt !== "string") return bad("approvedAt malformed");
  }
  if (typeof o.createdAt !== "string" || typeof o.updatedAt !== "string") return bad("timestamps malformed");
  return { status: o.approvedRevision === null ? "PENDING" : "APPROVED", state: o as GateState };
}

const fresh = (projectDir: string): GateState => {
  const now = new Date().toISOString();
  return { schema: 2, project: projectKey(projectDir), revision: 0, designHash: null, approvedRevision: null, approvedHash: null, approvedAt: null, createdAt: now, updatedAt: now };
};

function writeAtomic(file: string, s: GateState): void {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), { mode: 0o600 });
  renameSync(tmp, file);
}

const sleep = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/** Serialize read-modify-write cycles across processes with an mkdir lock (atomic on POSIX). */
function withLock<T>(dir: string, lock: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15000) rmSync(lock, { recursive: true, force: true }); // stale
      } catch {}
      if (Date.now() > deadline) throw new Error("timed out waiting for the Prevue state lock");
      sleep(10 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return fn();
  } finally {
    rmSync(lock, { recursive: true, force: true });
  }
}

/** Create a PENDING state if none exists. Never overwrites an existing (even invalid) file. */
export function initIfMissing(dataDir: string, projectDir: string): "created" | "exists" {
  const { dir, file } = paths(dataDir, projectDir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    const fd = openSync(file, "wx", 0o600); // O_EXCL: concurrent sessions cannot both create it
    writeSync(fd, JSON.stringify(fresh(projectDir), null, 2));
    closeSync(fd);
    return "created";
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return "exists";
    throw e;
  }
}

/** Register the current design. Unchanged content is a no-op; any change bumps the revision and clears approval. */
export function registerDesign(dataDir: string, projectDir: string, spec: unknown): { state: GateState; changed: boolean } {
  const { dir, file, lock } = paths(dataDir, projectDir);
  return withLock(dir, lock, () => {
    let cur = load(dataDir, projectDir);
    if (cur.status === "INVALID" && cur.missing) {
      writeAtomic(file, fresh(projectDir));
      cur = load(dataDir, projectDir);
    }
    if (cur.status === "INVALID") throw new Error(`Prevue state is INVALID (${cur.reason}); the developer must run "prevue reset".`);
    const designHash = hashDesign(spec);
    if (cur.state.designHash === designHash) return { state: cur.state, changed: false };
    const next: GateState = { ...cur.state, revision: cur.state.revision + 1, designHash, approvedRevision: null, approvedHash: null, approvedAt: null, updatedAt: new Date().toISOString() };
    writeAtomic(file, next);
    return { state: next, changed: true };
  });
}

/** Approve the current revision. The hash prefix is mandatory so the developer approves the exact design they reviewed. */
export function approve(dataDir: string, projectDir: string, hashPrefix: string | undefined): GateState {
  if (!hashPrefix || !/^[0-9a-f]{8,64}$/i.test(hashPrefix)) throw new Error("approval needs the design hash prefix (8+ hex characters): prevue approve <hash>");
  const { dir, file, lock } = paths(dataDir, projectDir);
  return withLock(dir, lock, () => {
    const cur = load(dataDir, projectDir);
    if (cur.status === "INVALID") throw new Error(`state is INVALID (${cur.reason}); run "prevue reset" first`);
    const s = cur.state;
    if (s.designHash === null) throw new Error("no design has been registered; nothing to approve");
    if (!s.designHash.startsWith(hashPrefix.toLowerCase())) throw new Error(`hash ${hashPrefix} does not match the current design (revision ${s.revision}, ${s.designHash.slice(0, 12)})`);
    if (cur.status === "APPROVED") return s;
    const now = new Date().toISOString();
    const next: GateState = { ...s, approvedRevision: s.revision, approvedHash: s.designHash, approvedAt: now, updatedAt: now };
    writeAtomic(file, next);
    return next;
  });
}

/** Developer recovery: quarantine whatever is on disk (never deleted) and start a fresh PENDING state. */
export function reset(dataDir: string, projectDir: string): { quarantinedTo: string | null } {
  const { dir, file, lock } = paths(dataDir, projectDir);
  return withLock(dir, lock, () => {
    let q: string | null = null;
    try {
      lstatSync(file);
      q = `${file}.invalid-${Date.now()}-${randomBytes(3).toString("hex")}`;
      renameSync(file, q);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    writeAtomic(file, fresh(projectDir));
    return { quarantinedTo: q };
  });
}
