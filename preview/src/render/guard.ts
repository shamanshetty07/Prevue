import { LIMITS, uiSpecSchema, type NodeSpec, type UiSpec } from "../../../server/src/spec/schema.js";

/**
 * The renderer's own gate. The server only serves specifications it has already verified, but nothing the renderer is
 * handed is trusted: it is re-parsed with the same strict schema (unknown properties, URLs-as-properties, unknown component
 * types and bad tokens all fail) and re-checked against the same size, depth and component-count limits. Rendering uses
 * the parsed, normalized value, never the input object. Deterministic and side-effect free.
 */
export type Renderable = { ok: true; spec: UiSpec } | { ok: false; issues: string[] };

const fail = (...issues: string[]): Renderable => ({ ok: false, issues: issues.slice(0, 10) });

/** Iterative, so hostile nesting is rejected before the (recursive) schema parser sees it. */
function rawWithinLimits(value: unknown): string | null {
  let seen = 0;
  const stack: Array<[unknown, number]> = [[value, 1]];
  while (stack.length) {
    const [v, depth] = stack.pop()!;
    if (++seen > LIMITS.rawJsonValues) return `the specification has more than ${LIMITS.rawJsonValues} values`;
    if (v && typeof v === "object") {
      if (depth > LIMITS.rawJsonDepth) return `the specification is nested deeper than ${LIMITS.rawJsonDepth} levels`;
      for (const c of Array.isArray(v) ? v : Object.values(v)) stack.push([c, depth + 1]);
    }
  }
  return null;
}

export function checkRenderable(value: unknown): Renderable {
  const raw = rawWithinLimits(value);
  if (raw) return fail(raw);
  const r = uiSpecSchema.safeParse(value);
  if (!r.success) {
    return fail(...r.error.issues.slice(0, 5).map((i) => `${i.path.map(String).join("/") || "(root)"}: ${i.code === "unrecognized_keys" ? "unknown property" : i.code === "invalid_union" ? "unsupported component or value" : i.message}`.slice(0, 160)));
  }
  const spec = r.data as UiSpec;
  let nodes = (spec.layout.header ? 1 + spec.layout.header.actions.length : 0) + (spec.layout.sidebar ? 1 : 0);
  const stack: Array<[NodeSpec, number]> = spec.layout.main.children.map((n) => [n, 0]);
  while (stack.length) {
    const [n, nest] = stack.pop()!;
    nodes++;
    if (n.type === "stack" || n.type === "grid") {
      if (nest + 1 > LIMITS.nesting) return fail(`containers are nested deeper than ${LIMITS.nesting} levels`);
      for (const c of n.children) stack.push([c, nest + 1]);
    }
  }
  if (nodes > LIMITS.nodes) return fail(`the specification has ${nodes} components; the maximum is ${LIMITS.nodes}`);
  return { ok: true, spec };
}
