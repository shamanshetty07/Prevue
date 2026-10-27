import { hashDesign } from "../state.js";
import { LIMITS, SPEC_SCHEMA_VERSION, uiSpecSchema, type NodeSpec, type UiSpec } from "./schema.js";

/**
 * Turns untrusted text or a parsed value into a validated, normalized UiSpec, or a list of issues.
 * Never throws, never reads or writes Prevue state, and never approves anything: a valid spec is only data
 * that can later be handed to registerDesign(), which leaves the gate PENDING.
 */
export interface SpecIssue {
  /** JSON pointer into the input ("" is the document itself). */
  path: string;
  code: string;
  message: string;
}
export type SpecResult =
  | { ok: true; spec: UiSpec; hash: string; stats: { nodes: number; depth: number } }
  | { ok: false; kind: "parse_error" | "schema_error"; issues: SpecIssue[] };

const clip = (s: string, n = 160): string => (s.length > n ? `${s.slice(0, n)}…` : s);
const pointer = (parts: ReadonlyArray<PropertyKey>): string => parts.map((p) => `/${String(p).replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
const parseError = (code: string, message: string): SpecResult => ({ ok: false, kind: "parse_error", issues: [{ path: "", code, message }] });
const schemaError = (issues: SpecIssue[]): SpecResult => ({ ok: false, kind: "schema_error", issues });

/** The hash the developer approves: computed from the validated, normalized spec, never from the raw input. */
export const specHash = (spec: UiSpec): string => hashDesign(spec);

/** Stages 1-3: size, JSON syntax, and an iterative complexity guard (so deep input cannot overflow the stack later). */
export function parseSpecText(text: string): SpecResult {
  if (typeof text !== "string") return parseError("invalid_json", "input is not text");
  if (Buffer.byteLength(text, "utf8") > LIMITS.rawBytes) return parseError("too_large", `input is larger than ${LIMITS.rawBytes} bytes`);
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (e) {
    return e instanceof RangeError ? parseError("too_complex", "input is nested too deeply") : parseError("invalid_json", clip((e as Error).message));
  }
  return validateSpec(value);
}

/** Iterative so that hostile nesting is rejected before any recursive code sees it. */
function guardRaw(value: unknown): SpecIssue | null {
  let seen = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++seen > LIMITS.rawJsonValues) return { path: "", code: "too_complex", message: `input has more than ${LIMITS.rawJsonValues} JSON values` };
    if (v && typeof v === "object") {
      if (depth > LIMITS.rawJsonDepth) return { path: "", code: "too_complex", message: `input is nested deeper than ${LIMITS.rawJsonDepth} levels` };
      for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, depth + 1]);
    }
  }
  return null;
}

/** Stages 3-6 on an already parsed value. */
export function validateSpec(value: unknown): SpecResult {
  try {
    const guard = guardRaw(value);
    if (guard) return { ok: false, kind: "parse_error", issues: [guard] };

    if (!value || typeof value !== "object" || Array.isArray(value)) return schemaError([{ path: "", code: "invalid_type", message: "the specification must be a JSON object" }]);
    const version = (value as Record<string, unknown>).schemaVersion;
    if (version === undefined) return schemaError([{ path: "/schemaVersion", code: "missing_field", message: "schemaVersion is required" }]);
    if (version !== SPEC_SCHEMA_VERSION) return schemaError([{ path: "/schemaVersion", code: "unsupported_version", message: `unsupported schemaVersion; this engine supports ${SPEC_SCHEMA_VERSION}` }]);

    const r = uiSpecSchema.safeParse(value);
    if (!r.success) return schemaError(r.error.issues.flatMap(mapIssue).slice(0, 50));

    const spec = r.data as UiSpec;
    const limits = checkLimits(spec);
    if (limits.issues.length) return schemaError(limits.issues);
    return { ok: true, spec, hash: specHash(spec), stats: limits.stats };
  } catch (e) {
    // Defensive: an unexpected internal error must never look like success or escape as an exception.
    return schemaError([{ path: "", code: "internal_error", message: clip(String((e as Error)?.message ?? e)) }]);
  }
}

function mapIssue(i: { code: string; path: PropertyKey[]; message: string; keys?: string[] }): SpecIssue[] {
  const path = pointer(i.path);
  switch (i.code) {
    case "unrecognized_keys":
      return (i.keys ?? ["?"]).map((k) => ({ path: pointer([...i.path, clip(k, 40)]), code: "unknown_key", message: "unknown property (not part of the specification format)" }));
    case "invalid_union":
      return i.path[i.path.length - 1] === "type"
        ? [{ path, code: "unknown_component", message: "unknown component type" }]
        : [{ path, code: "invalid_value", message: clip(i.message) }];
    case "invalid_type":
      return [{ path, code: /received undefined/.test(i.message) ? "missing_field" : "invalid_type", message: clip(i.message) }];
    case "too_big":
    case "too_small":
      return [{ path, code: "limit_exceeded", message: clip(i.message) }];
    case "custom":
      return [{ path, code: "invalid_value", message: clip(i.message) }];
    default:
      return [{ path, code: "invalid_value", message: clip(i.message) }];
  }
}

/** Counts components, measures container nesting and checks id uniqueness (iteratively). */
function checkLimits(spec: UiSpec): { issues: SpecIssue[]; stats: { nodes: number; depth: number } } {
  const issues: SpecIssue[] = [];
  const ids = new Map<string, string>();
  let nodes = 0;
  let depth = 0;
  const noteId = (id: string | undefined, path: string) => {
    if (id === undefined) return;
    if (ids.has(id)) issues.push({ path: `${path}/id`, code: "duplicate_id", message: `id "${id}" is already used at ${ids.get(id)}` });
    else ids.set(id, path);
  };

  const { header, sidebar, main } = spec.layout;
  if (header) {
    nodes++;
    noteId(header.id, "/layout/header");
    header.actions.forEach((b, i) => {
      nodes++;
      noteId(b.id, `/layout/header/actions/${i}`);
    });
  }
  if (sidebar) {
    nodes++;
    noteId(sidebar.id, "/layout/sidebar");
  }
  const stack: Array<[NodeSpec, number, string]> = main.children.map((n, i) => [n, 0, `/layout/main/children/${i}`]);
  while (stack.length) {
    const [n, nest, path] = stack.pop()!;
    nodes++;
    noteId(n.id, path);
    if (n.type === "stack" || n.type === "grid") {
      const d = nest + 1;
      depth = Math.max(depth, d);
      if (d > LIMITS.nesting) issues.push({ path, code: "limit_exceeded", message: `containers are nested deeper than ${LIMITS.nesting} levels` });
      else n.children.forEach((c, i) => stack.push([c, d, `${path}/children/${i}`]));
    }
  }
  if (nodes > LIMITS.nodes) issues.push({ path: "", code: "limit_exceeded", message: `the specification has ${nodes} components; the maximum is ${LIMITS.nodes}` });
  issues.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { issues, stats: { nodes, depth } };
}
