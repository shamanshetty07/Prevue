import type { NodeSpec, UiSpec } from "../../../server/src/spec/schema.js";
import { resolvePath, type Resolved, type SelectableType } from "../render/paths.js";

/**
 * What the read-only inspector shows for one selected node. Built only from the validated, normalized specification:
 * every row names the schema property it came from (`key`, a dotted path inside the node) and shows that property's value,
 * so the panel cannot show anything the specification does not contain. Optional properties that are not set appear with
 * `value: null` ("not set") rather than being hidden, because their absence is part of the design. Defaults the schema
 * fills in during validation (e.g. a button's `variant`) show their filled-in value, which is what the renderer uses.
 */
export type Row = { key: string; label: string; value: string | null };
export type Section = { title: "Content" | "Layout" | "Style" | "Identity" | "Items" | "Columns" | "Data"; rows: Row[] };
export type ChildRef = { path: string; type: SelectableType; summary: string };
export type InspectorModel = {
  path: string;
  type: SelectableType;
  typeLabel: string;
  parent: string | null;
  sections: Section[];
  /** Child components (containers, the main region, header actions), each selectable by its path. */
  children: ChildRef[] | null;
  /** How many components in the whole specification carry the same `id` (ids are optional and not required to be unique). */
  idShared: number;
};

export const TYPE_LABEL: Record<SelectableType, string> = {
  header: "Header",
  sidebar: "Sidebar",
  main: "Main region",
  stack: "Stack",
  grid: "Grid",
  text: "Text",
  button: "Button",
  "stat-card": "Stat card",
  table: "Table",
};

/** Display form of a property value. Strings are shown verbatim (React escapes them); the panel never interprets them. */
export const formatValue = (v: unknown): string | null =>
  v === undefined ? null : typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : null;

const row = (obj: object, key: string, label: string): Row => ({ key, label, value: formatValue(get(obj, key)) });

/** Reads a dotted own-property path (`delta.text`, `items.0.label`); never walks the prototype chain. */
export function get(obj: unknown, key: string): unknown {
  let cur: unknown = obj;
  for (const k of key.split(".")) {
    if (cur === null || typeof cur !== "object" || !Object.hasOwn(cur, k)) return undefined;
    cur = (cur as Record<string, unknown>)[k];
  }
  return cur;
}

/** A short, plain-text description of a component for child lists and the outline. */
export function summarize(type: SelectableType, node: unknown): string {
  const n = node as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === "string" ? v : "");
  switch (type) {
    case "header": return s(n.title);
    case "sidebar": return s(n.title) || `${(n.items as unknown[]).length} items`;
    case "main": return `${(n.children as unknown[]).length} children`;
    case "stack": return `${s(n.direction)} · ${(n.children as unknown[]).length} children`;
    case "grid": return `${String(n.columns)} columns · ${(n.children as unknown[]).length} children`;
    case "text": return s(n.content);
    case "button": return s(n.label);
    case "stat-card": return s(n.label);
    case "table": return s(n.caption) || `${(n.columns as unknown[]).length} columns`;
  }
}

const childRefs = (children: NodeSpec[], prefix: string): ChildRef[] => children.map((c, i) => ({ path: `${prefix}.${i}`, type: c.type, summary: summarize(c.type, c) }));

function countId(spec: UiSpec, id: string | undefined): number {
  if (id === undefined) return 0;
  let n = 0;
  const { header, sidebar, main } = spec.layout;
  if (header?.id === id) n++;
  for (const a of header?.actions ?? []) if (a.id === id) n++;
  if (sidebar?.id === id) n++;
  const stack: NodeSpec[] = [...main.children];
  while (stack.length) {
    const c = stack.pop()!;
    if (c.id === id) n++;
    if (c.type === "stack" || c.type === "grid") stack.push(...c.children);
  }
  return n;
}

function sectionsFor(r: Resolved): { sections: Section[]; children: ChildRef[] | null } {
  const idRow = (o: object): Section => ({ title: "Identity", rows: [row(o, "id", "id")] });
  switch (r.type) {
    case "header": {
      const n = r.node;
      return {
        sections: [{ title: "Content", rows: [row(n, "title", "Title"), row(n, "subtitle", "Subtitle")] }, idRow(n)],
        children: n.actions.map((a, i) => ({ path: `header.actions.${i}`, type: "button", summary: summarize("button", a) })),
      };
    }
    case "sidebar": {
      const n = r.node;
      return {
        sections: [
          { title: "Content", rows: [row(n, "title", "Title")] },
          { title: "Layout", rows: [row(n, "width", "Width")] },
          { title: "Items", rows: n.items.flatMap((_, i) => [row(n, `items.${i}.label`, `${i + 1}. Label`), row(n, `items.${i}.icon`, `${i + 1}. Icon`), row(n, `items.${i}.active`, `${i + 1}. Active`)]) },
          idRow(n),
        ],
        children: null,
      };
    }
    case "main": {
      const n = r.node;
      return { sections: [{ title: "Layout", rows: [row(n, "gap", "Gap"), row(n, "padding", "Padding")] }], children: childRefs(n.children, r.path) };
    }
  }
  const n = r.node;
  switch (n.type) {
    case "stack":
      return { sections: [{ title: "Layout", rows: [row(n, "direction", "Direction"), row(n, "gap", "Gap"), row(n, "align", "Align")] }, idRow(n)], children: childRefs(n.children, r.path) };
    case "grid":
      return { sections: [{ title: "Layout", rows: [row(n, "columns", "Columns"), row(n, "gap", "Gap")] }, idRow(n)], children: childRefs(n.children, r.path) };
    case "text":
      return { sections: [{ title: "Content", rows: [row(n, "content", "Content")] }, { title: "Style", rows: [row(n, "variant", "Variant"), row(n, "tone", "Tone")] }, idRow(n)], children: null };
    case "button":
      return { sections: [{ title: "Content", rows: [row(n, "label", "Label"), row(n, "note", "Note")] }, { title: "Style", rows: [row(n, "variant", "Variant")] }, idRow(n)], children: null };
    case "stat-card": {
      const delta = n.delta ? [row(n, "delta.text", "Delta")] : [row(n, "delta", "Delta")];
      return {
        sections: [
          { title: "Content", rows: [row(n, "label", "Label"), row(n, "value", "Value"), ...delta, row(n, "hint", "Hint")] },
          ...(n.delta ? [{ title: "Style" as const, rows: [row(n, "delta.trend", "Delta trend")] }] : []),
          idRow(n),
        ],
        children: null,
      };
    }
    case "table":
      return {
        sections: [
          { title: "Content", rows: [row(n, "caption", "Caption"), row(n, "emptyText", "Empty text")] },
          { title: "Columns", rows: n.columns.flatMap((_, i) => [row(n, `columns.${i}.header`, `${i + 1}. Header`), row(n, `columns.${i}.key`, `${i + 1}. Key`), row(n, `columns.${i}.align`, `${i + 1}. Align`)]) },
          { title: "Data", rows: [{ key: "rows", label: "Rows", value: String(n.rows.length) }] },
          idRow(n),
        ],
        children: null,
      };
  }
}

/** The outline's one-line description of the node at `path`. */
export function resolvePathSummary(spec: UiSpec, path: string): string {
  const r = resolvePath(spec, path);
  return r ? summarize(r.type, r.node) : "";
}

/** The inspector's view of `path` in `spec`, or null when the path does not name a node. */
export function inspect(spec: UiSpec, path: string | null): InspectorModel | null {
  const r = path === null ? null : resolvePath(spec, path);
  if (!r) return null;
  const { sections, children } = sectionsFor(r);
  const id = r.type === "main" ? undefined : (r.node as { id?: string }).id;
  return { path: r.path, type: r.type, typeLabel: TYPE_LABEL[r.type], parent: r.parent, sections, children, idShared: countId(spec, id) };
}
