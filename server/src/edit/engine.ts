import { LIMITS, type UiSpec } from "../spec/schema.js";
import { validateSpec, type SpecIssue } from "../spec/validate.js";
import { isSameOrDescendant, resolvePath, type Resolved } from "./paths.js";
import { parseProposal, SETTABLE } from "./proposal.js";
import type { EditError, EditErrorCode, EditResult, InsertOp, MoveOp, RemoveOp, SetOp } from "./types.js";

/**
 * Phase 3a edit engine: applies a parsed proposal to a base specification and returns a validated candidate, or the
 * first error. Pure and deterministic: no state, no I/O, inputs are never mutated, and nothing is registered or approved.
 *
 * Each operation is applied to a copy of the result so far, which is then re-validated in full (schema, limits, ids,
 * nesting, size), so a candidate is only ever returned when every intermediate step was itself a valid specification.
 * On any failure no candidate is returned at all (all or nothing).
 *
 * baseHash limitation: the engine checks only that `baseHash` is well formed and equals the hash of the base it was
 * handed. It cannot know whether that base is the design currently stored and approved. A future adoption step must
 * compare against the stored hash under the state lock, re-read the base itself, re-run applyOps and register the
 * result through the existing path (the gate stays PENDING).
 */
export function applyOps(baseSpec: unknown, proposal: unknown): EditResult {
  try {
    const p = parseProposal(proposal);
    if (!p.ok) return { ok: false, error: p.error };
    // The base is read only through a JSON snapshot, like the proposal: no getter, proxy or inherited property of the
    // caller's is ever validated or hashed.
    const base = snapshot(baseSpec);
    if (base === undefined) return fail("invalid_base", "the base is not plain JSON data within the size limit");
    const b = validateSpec(base);
    if (!b.ok) return { ok: false, error: { code: "invalid_base", message: "the base is not a valid specification", issues: quiet(b.issues) } };
    if (b.hash !== p.proposal.baseHash) return fail("stale_base", "the proposal was written against a different design");

    let cur = b.spec;
    let hash = b.hash;
    let stats = b.stats;
    for (const [i, op] of p.proposal.ops.entries()) {
      const work = structuredClone(cur);
      const err =
        op.op === "set" ? applySet(work, op) : op.op === "insert" ? applyInsert(work, op) : op.op === "remove" ? applyRemove(work, op) : op.op === "move" ? applyMove(work, op) : null;
      if (err) return { ok: false, error: { ...err, op: i } };
      const v = validateSpec(work);
      if (!v.ok) return { ok: false, error: { code: "invalid_result", message: `operation ${i} would make the specification invalid`, op: i, issues: quiet(v.issues) } };
      // Measured on the canonical form, so the candidate always fits the limit parseSpecText enforces on read-back.
      if (Buffer.byteLength(JSON.stringify(v.spec), "utf8") > LIMITS.rawBytes) return fail("too_large", `operation ${i} would make the specification larger than ${LIMITS.rawBytes} bytes`, i);
      ({ spec: cur, hash, stats } = v);
    }
    return { ok: true, spec: cur, hash, baseHash: b.hash, stats, changed: hash !== b.hash };
  } catch {
    // Never let an exception escape or look like success, and never echo its text.
    return fail("internal_error", "the edit could not be applied");
  }
}

type OpError = Omit<EditError, "op">;
const fail = (code: EditErrorCode, message: string, op?: number): EditResult => ({ ok: false, error: op === undefined ? { code, message } : { code, message, op } });
const err = (code: EditErrorCode, message: string): OpError => ({ code, message });
const unresolved = (path: string) => err("path_unresolved", `${path} does not name a component`);
const mismatch = (path: string, type: string) => err("type_mismatch", `${path} is a ${type}, not the expected type`);
const ROOTS: ReadonlySet<string> = new Set(["main", "header", "sidebar"]);

/** Plain JSON data, or undefined when the value cannot be serialized (cycle, BigInt, throwing getter, too deep, too large). */
function snapshot(v: unknown): unknown {
  try {
    const s = JSON.stringify(v);
    return s === undefined || Buffer.byteLength(s, "utf8") > LIMITS.rawBytes ? undefined : JSON.parse(s);
  } catch {
    return undefined;
  }
}

/** validateSpec reports an unexpected exception with its text; an edit result never carries exception text. */
const quiet = (issues: SpecIssue[]): SpecIssue[] => issues.map((x) => (x.code === "internal_error" ? { ...x, message: "the specification could not be checked" } : x));

/** The collection a parent holds: main and containers hold components, the header holds its action buttons. */
function listOf(r: Resolved): unknown[] | null {
  switch (r.type) {
    case "main":
      return r.node.children;
    case "stack":
    case "grid":
      // Resolved's `type` does not narrow `node` for main-tree members; check the node's own discriminant.
      return r.node.type === "stack" || r.node.type === "grid" ? r.node.children : null;
    case "header":
      return r.node.actions;
    default:
      return null;
  }
}

/** Removes a resolved, non-root node from its parent's collection; the identity check guards against a path mix-up. */
function detach(work: UiSpec, r: Resolved & { parent: string }): unknown {
  const parent = resolvePath(work, r.parent);
  const list = parent && listOf(parent);
  const i = Number(r.path.slice(r.path.lastIndexOf(".") + 1));
  if (!list || list[i] !== r.node) throw new Error("detach");
  return list.splice(i, 1)[0];
}

function applySet(work: UiSpec, op: SetOp): OpError | null {
  const r = resolvePath(work, op.path);
  if (!r) return unresolved(op.path);
  if (r.type !== op.expect) return mismatch(op.path, r.type);
  // The parser already allowlisted prop for this type; re-check by Map lookup so no other key can ever be written.
  if (!SETTABLE.get(r.type)?.has(op.prop)) return err("property_not_allowed", `that property cannot be set on a ${r.type}`);
  (r.node as Record<string, unknown>)[op.prop] = op.value;
  return null;
}

function applyInsert(work: UiSpec, op: InsertOp): OpError | null {
  const r = resolvePath(work, op.parent);
  if (!r) return unresolved(op.parent);
  if (r.type !== op.parentExpect) return mismatch(op.parent, r.type);
  const list = listOf(r);
  if (!list || (r.type === "header" && op.node.type !== "button")) return err("invalid_parent", `${op.parent} cannot hold that component`);
  if (!Number.isSafeInteger(op.index) || op.index < 0 || op.index > list.length) return err("index_out_of_range", `index is outside ${op.parent}`);
  list.splice(op.index, 0, structuredClone(op.node));
  return null;
}

function applyRemove(work: UiSpec, op: RemoveOp): OpError | null {
  if (ROOTS.has(op.path)) return err("not_removable", `${op.path} is a fixed region and cannot be removed`);
  const r = resolvePath(work, op.path);
  if (!r) return unresolved(op.path);
  if (r.parent === null) return err("not_removable", `${op.path} is a fixed region and cannot be removed`);
  if (r.type !== op.expect) return mismatch(op.path, r.type);
  detach(work, r);
  return null;
}

function applyMove(work: UiSpec, op: MoveOp): OpError | null {
  if (ROOTS.has(op.path)) return err("not_movable", `${op.path} is a fixed region and cannot be moved`);
  const src = resolvePath(work, op.path);
  if (!src) return unresolved(op.path);
  if (src.parent === null) return err("not_movable", `${op.path} is a fixed region and cannot be moved`);
  if (src.type !== op.expect) return mismatch(op.path, src.type);
  // The destination is resolved before the source is taken out, so `parent` names a position in the current tree.
  const dst = resolvePath(work, op.parent);
  if (!dst) return unresolved(op.parent);
  if (dst.type !== op.parentExpect) return mismatch(op.parent, dst.type);
  if (isSameOrDescendant(dst.path, src.path)) return err("move_into_self", `${op.path} cannot be moved into itself`);
  // Header actions stay in the header; main-tree components stay in main and its containers.
  const list = listOf(dst);
  if (!list || (src.parent === "header") !== (dst.type === "header")) return err("invalid_parent", `${op.path} cannot be moved into ${op.parent}`);
  const node = detach(work, src);
  // The index is the final position in the destination, counted after the source has been removed.
  if (!Number.isSafeInteger(op.index) || op.index < 0 || op.index > list.length) return err("index_out_of_range", `index is outside ${op.parent}`);
  list.splice(op.index, 0, node);
  return null;
}
