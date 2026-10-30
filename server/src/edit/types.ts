import type { NodeSpec, UiSpec } from "../spec/schema.js";
import type { SpecIssue } from "../spec/validate.js";
import type { TargetType } from "./paths.js";

/**
 * Phase 3a edit proposals: the shared contract between the proposal parser (proposal.ts) and the engine (engine.ts).
 *
 * A proposal is plain data: the hash of the design it was written against, and an ordered list of operations that each
 * name their target by structural path (never by optional id) together with the component type expected there. The
 * engine checks `baseHash` against the base it is given; it cannot know whether that base is the design currently stored
 * and approved. A future adoption step must re-check the stored hash under the state lock before registering anything.
 */
export const EDIT_LIMITS = {
  /** Serialized proposal size; the same bound as a specification. */
  rawBytes: 64 * 1024,
  rawJsonDepth: 24,
  rawJsonValues: 2000,
  ops: 32,
} as const;

/** Collections that accept insert and move: main and containers take any node, the header takes buttons only. */
export type ParentType = "main" | "stack" | "grid" | "header";
export type NodeType = NodeSpec["type"];

export type SetOp = { op: "set"; path: string; expect: TargetType; prop: string; value: string | number };
export type InsertOp = { op: "insert"; parent: string; parentExpect: ParentType; index: number; node: NodeSpec };
export type RemoveOp = { op: "remove"; path: string; expect: NodeType };
export type MoveOp = { op: "move"; path: string; expect: NodeType; parent: string; parentExpect: ParentType; index: number };
export type EditOp = SetOp | InsertOp | RemoveOp | MoveOp;
export interface Proposal {
  baseHash: string;
  ops: EditOp[];
}

export type EditErrorCode =
  // reading a serialized proposal
  | "invalid_json"
  | "too_large"
  | "too_complex"
  | "duplicate_key"
  // proposal shape
  | "invalid_proposal"
  | "unknown_key"
  | "unknown_op"
  | "invalid_base_hash"
  | "too_many_ops"
  | "invalid_path"
  | "property_not_allowed"
  | "invalid_value"
  | "invalid_component"
  // applying to a base
  | "invalid_base"
  | "stale_base"
  | "path_unresolved"
  | "type_mismatch"
  | "invalid_parent"
  | "index_out_of_range"
  | "not_removable"
  | "not_movable"
  | "move_into_self"
  | "invalid_result"
  | "internal_error";

/**
 * Messages are fixed text or quote only values that already passed validation (canonical paths, allowlisted names);
 * nothing a caller supplied is echoed otherwise.
 */
export interface EditError {
  code: EditErrorCode;
  message: string;
  /** Index of the operation that failed, when one did. */
  op?: number;
  /** JSON pointer into the proposal, when the problem is at a specific place in it. */
  at?: string;
  /** Specification issues (from validateSpec) when the base or an intermediate result is invalid. */
  issues?: SpecIssue[];
}

export type ProposalResult = { ok: true; proposal: Proposal } | { ok: false; error: EditError };

export type EditResult =
  | { ok: true; spec: UiSpec; hash: string; baseHash: string; stats: { nodes: number; depth: number }; changed: boolean }
  | { ok: false; error: EditError };
