import { z } from "zod";
import { scanDuplicateKeys } from "../spec/dupkeys.js";
import { Button, Grid, Header, LIMITS, Node, Sidebar, Stack, StatCard, Table, Text, uiSpecSchema, type NodeSpec } from "../spec/schema.js";
import { isPathSyntax, type TargetType } from "./paths.js";
import { EDIT_LIMITS, type EditError, type EditErrorCode, type EditOp, type NodeType, type ParentType, type ProposalResult } from "./types.js";

/**
 * Turns an untrusted edit proposal (text or a parsed value) into a normalized Proposal, or one error.
 * Never throws, and never echoes what the caller supplied: messages are fixed text, and a pointer quotes at most a
 * clipped, escaped key. It checks only the proposal's own shape; whether the ops apply to a base is the engine's job.
 */

// A pointer may quote a caller's key: clipped, and with control and bidi-override characters replaced so it reads as stored.
const clip = (s: string, n = 40): string => (s.length > n ? `${s.slice(0, n)}…` : s).replace(/[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩\uD800-\uDFFF]/g, "�");
const pointer = (parts: ReadonlyArray<PropertyKey>): string => parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
const fail = (code: EditErrorCode, message: string, op?: number, at?: string): { ok: false; error: EditError } => {
  const error: EditError = { code, message };
  if (op !== undefined) error.op = op;
  if (at !== undefined) error.at = at;
  return { ok: false, error };
};

/** A Map whose mutators throw, frozen so they cannot be swapped back: the allowlist cannot be widened at runtime. */
function frozenMap<K, V>(entries: Iterable<readonly [K, V]>): ReadonlyMap<K, V> {
  const m = new Map<K, V>(entries);
  const refuse = () => {
    throw new TypeError("read-only map");
  };
  Object.defineProperties(m, { set: { value: refuse }, delete: { value: refuse }, clear: { value: refuse } });
  return Object.freeze(m);
}

/** Setting a property always supplies a value: clearing an optional property is deferred, so null is never accepted. */
function required(s: z.ZodType): z.ZodType {
  let t = s;
  while (t instanceof z.ZodOptional || t instanceof z.ZodDefault) t = t.unwrap() as z.ZodType;
  return t;
}
const props = (shape: Record<string, z.ZodType>, names: string[]): ReadonlyMap<string, z.ZodType> => frozenMap(names.map((n) => [n, required(shape[n]!)] as const));

const mainShape = uiSpecSchema.shape.layout.shape.main.shape;
/**
 * What `set` may change, per target type, with each property's value schema taken from the specification itself so the
 * two cannot drift. Ids, types, children, actions, items, deltas, table columns/rows, screen and theme are deferred.
 */
export const SETTABLE: ReadonlyMap<TargetType, ReadonlyMap<string, z.ZodType>> = frozenMap<TargetType, ReadonlyMap<string, z.ZodType>>([
  ["main", props(mainShape, ["gap", "padding"])],
  ["header", props(Header.shape, ["title", "subtitle"])],
  ["sidebar", props(Sidebar.shape, ["title", "width"])],
  ["stack", props(Stack.shape, ["direction", "gap", "align"])],
  ["grid", props(Grid.shape, ["columns", "gap"])],
  ["text", props(Text.shape, ["content", "variant", "tone"])],
  ["button", props(Button.shape, ["label", "variant", "note"])],
  ["stat-card", props(StatCard.shape, ["label", "value", "hint"])],
  ["table", props(Table.shape, ["caption", "emptyText"])],
]);

const TARGET_TYPES: ReadonlySet<string> = new Set<TargetType>(["header", "sidebar", "main", "stack", "grid", "text", "button", "stat-card", "table"]);
const NODE_TYPES: ReadonlySet<string> = new Set<NodeType>(["stack", "grid", "text", "button", "stat-card", "table"]);
const PARENT_TYPES: ReadonlySet<string> = new Set<ParentType>(["main", "stack", "grid", "header"]);
const OP_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["set", new Set(["op", "path", "expect", "prop", "value"])],
  ["insert", new Set(["op", "parent", "parentExpect", "index", "node"])],
  ["remove", new Set(["op", "path", "expect"])],
  ["move", new Set(["op", "path", "expect", "parent", "parentExpect", "index"])],
]);
const HASH = /^[0-9a-f]{64}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
/** Own data only: the snapshot is a JSON.parse result, but a key such as "toString" must never reach the prototype. */
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);

/** Iterative, like validate.ts guardRaw, so hostile nesting or a cycle is rejected before anything recursive runs. */
function tooComplex(value: unknown): boolean {
  let seen = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++seen > EDIT_LIMITS.rawJsonValues) return true;
    if (v && typeof v === "object") {
      if (depth > EDIT_LIMITS.rawJsonDepth) return true;
      for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, depth + 1]);
    }
  }
  return false;
}

/** Ids are deferred in 3a: an inserted subtree may not carry one anywhere (checked on the raw snapshot, iteratively). */
function hasIdKey(value: unknown): boolean {
  const stack: unknown[] = [value];
  while (stack.length) {
    const v = stack.pop();
    if (!v || typeof v !== "object") continue;
    if (!Array.isArray(v) && Object.hasOwn(v, "id")) return true;
    for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push(c);
  }
  return false;
}

const validIndex = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= LIMITS.children;

export function parseProposal(value: unknown): ProposalResult {
  try {
    if (tooComplex(value)) return fail("too_complex", `the proposal is nested deeper than ${EDIT_LIMITS.rawJsonDepth} levels or has more than ${EDIT_LIMITS.rawJsonValues} values`);
    // From here on only this snapshot is read: no getters, proxies, prototypes or functions of the caller's survive it.
    let snap: unknown;
    try {
      const s = JSON.stringify(value);
      if (typeof s !== "string") return fail("invalid_proposal", "the proposal must be a JSON object");
      // The same bound parseProposalText applies to text, so an in-process object cannot carry more than a serialized one.
      if (Buffer.byteLength(s, "utf8") > EDIT_LIMITS.rawBytes) return fail("too_large", `the proposal is larger than ${EDIT_LIMITS.rawBytes} bytes`);
      snap = JSON.parse(s);
    } catch {
      return fail("invalid_proposal", "the proposal is not plain JSON data");
    }
    // toJSON or a getter could have produced something the first guard never saw.
    if (tooComplex(snap)) return fail("too_complex", `the proposal is nested deeper than ${EDIT_LIMITS.rawJsonDepth} levels or has more than ${EDIT_LIMITS.rawJsonValues} values`);
    if (!isObj(snap)) return fail("invalid_proposal", "the proposal must be a JSON object");
    for (const k of Object.keys(snap)) {
      if (k !== "baseHash" && k !== "ops") return fail("unknown_key", "unknown property (a proposal has only baseHash and ops)", undefined, pointer([clip(k)]));
    }
    const baseHash = own(snap, "baseHash");
    const ops = own(snap, "ops");
    if (baseHash === undefined || ops === undefined) return fail("invalid_proposal", "a proposal needs baseHash and ops");
    if (typeof baseHash !== "string" || !HASH.test(baseHash)) return fail("invalid_base_hash", "baseHash must be 64 lowercase hexadecimal characters", undefined, "/baseHash");
    if (!Array.isArray(ops) || ops.length === 0) return fail("invalid_proposal", "ops must be a non-empty array", undefined, "/ops");
    if (ops.length > EDIT_LIMITS.ops) return fail("too_many_ops", `a proposal may have at most ${EDIT_LIMITS.ops} ops`, undefined, "/ops");
    const out: EditOp[] = [];
    for (let i = 0; i < ops.length; i++) {
      const r = parseOp(ops[i], i);
      if (!r.ok) return r;
      out.push(r.op);
    }
    // Every value in `out` was built from the snapshot or by zod; the clone makes "no shared references" unconditional.
    return { ok: true, proposal: structuredClone({ baseHash, ops: out }) };
  } catch {
    return fail("internal_error", "the proposal could not be read");
  }
}

function parseOp(raw: unknown, i: number): { ok: true; op: EditOp } | { ok: false; error: EditError } {
  const err = (code: EditErrorCode, message: string, field?: string) => fail(code, message, i, field === undefined ? `/ops/${i}` : `/ops/${i}/${field}`);
  if (!isObj(raw)) return err("unknown_op", "each op must be an object naming one of set, insert, remove, move");
  const name = own(raw, "op");
  const keys = typeof name === "string" ? OP_KEYS.get(name) : undefined;
  if (!keys) return err("unknown_op", "op must be one of set, insert, remove, move");
  for (const k of Object.keys(raw)) {
    if (!keys.has(k)) return fail("unknown_key", `unknown property for a ${name} op`, i, pointer(["ops", i, clip(k)]));
  }
  for (const k of keys) if (own(raw, k) === undefined) return err("invalid_proposal", `a ${name} op is missing a required property`, k);

  const path = own(raw, "path");
  if (keys.has("path") && !isPathSyntax(path)) return err("invalid_path", "path is not a valid structural path", "path");
  const parent = own(raw, "parent");
  if (keys.has("parent") && !isPathSyntax(parent)) return err("invalid_path", "parent is not a valid structural path", "parent");
  const expect = own(raw, "expect");
  if (keys.has("expect") && !(typeof expect === "string" && (name === "set" ? TARGET_TYPES : NODE_TYPES).has(expect))) return err("invalid_proposal", "expect is not a component type this op can target", "expect");
  const parentExpect = own(raw, "parentExpect");
  if (keys.has("parentExpect") && !(typeof parentExpect === "string" && PARENT_TYPES.has(parentExpect))) return err("invalid_proposal", "parentExpect must be one of main, stack, grid, header", "parentExpect");
  const index = own(raw, "index");
  if (keys.has("index") && !validIndex(index)) return err("invalid_proposal", `index must be an integer from 0 to ${LIMITS.children}`, "index");

  switch (name) {
    case "set": {
      const prop = own(raw, "prop");
      if (typeof prop !== "string") return err("invalid_proposal", "prop must be a string", "prop");
      const schema = SETTABLE.get(expect as TargetType)?.get(prop);
      if (!schema) return err("property_not_allowed", `that property cannot be set on a ${expect as TargetType}`, "prop");
      const value = own(raw, "value");
      if (typeof value !== "string" && typeof value !== "number") return err("invalid_value", "value must be a string or a number", "value");
      const r = schema.safeParse(value);
      if (!r.success) return err("invalid_value", `value is not allowed for ${expect as TargetType}.${prop}`, "value");
      return { ok: true, op: { op: "set", path: path as string, expect: expect as TargetType, prop, value: r.data as string | number } };
    }
    case "insert": {
      const node = own(raw, "node");
      if (hasIdKey(node)) return err("invalid_component", "inserted components may not carry an id yet", "node");
      const r = (parentExpect === "header" ? Button : Node).safeParse(node);
      if (!r.success) return err("invalid_component", parentExpect === "header" ? "the header accepts only a valid button" : "node is not a valid component", "node");
      return { ok: true, op: { op: "insert", parent: parent as string, parentExpect: parentExpect as ParentType, index: index as number, node: r.data as NodeSpec } };
    }
    case "remove":
      return { ok: true, op: { op: "remove", path: path as string, expect: expect as NodeType } };
    default:
      return { ok: true, op: { op: "move", path: path as string, expect: expect as NodeType, parent: parent as string, parentExpect: parentExpect as ParentType, index: index as number } };
  }
}

/** Size, JSON syntax and duplicate keys on the raw text, then parseProposal. V8's parse messages are never passed on. */
export function parseProposalText(text: unknown): ProposalResult {
  try {
    if (typeof text !== "string") return fail("invalid_json", "the proposal is not text");
    if (Buffer.byteLength(text, "utf8") > EDIT_LIMITS.rawBytes) return fail("too_large", `the proposal is larger than ${EDIT_LIMITS.rawBytes} bytes`);
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (e) {
      return e instanceof RangeError ? fail("too_complex", "the proposal is nested too deeply") : fail("invalid_json", "the proposal is not valid JSON");
    }
    // JSON.parse keeps the last of two equal keys; reject them so the reviewed text and the applied value cannot differ.
    const dups = scanDuplicateKeys(text);
    if (dups === "malformed") return fail("invalid_json", "the proposal is not valid JSON");
    if (dups.length) {
      const at = dups[0]!.path;
      const m = /^\/ops\/(0|[1-9][0-9]*)(?:\/|$)/.exec(at);
      return fail("duplicate_key", "an object repeats a property name; each name may appear once", m ? Number(m[1]) : undefined, at);
    }
    return parseProposal(value);
  } catch {
    return fail("internal_error", "the proposal could not be read");
  }
}
