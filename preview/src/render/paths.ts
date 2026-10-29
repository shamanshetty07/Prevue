import type { ButtonSpec, HeaderSpec, NodeSpec, SidebarSpec, UiSpec } from "../../../server/src/spec/schema.js";

/**
 * Structural paths: the editor's only notion of identity. A path is derived from where a node sits in the normalized
 * specification, never from its optional `id` (ids may be missing or repeated), so the same specification always yields
 * the same paths. Grammar:
 *
 *   header                 the header slot
 *   header.actions.<i>     the i-th header action (a button)
 *   sidebar                the sidebar slot (its items are properties of the sidebar, not components)
 *   main                   the main region
 *   main.<i>(.<j>)*        a component in main, then the j-th child of that container, and so on
 *
 * Indexes are canonical decimals (no sign, no leading zero), so each node has exactly one spelling. A path is a lookup
 * key into the validated specification and nothing more: anything that does not resolve to a node is rejected.
 */
export type SelectableType = NodeSpec["type"] | "header" | "sidebar" | "main";
export type MainRegion = UiSpec["layout"]["main"];
export type Resolved =
  | { path: string; type: "header"; node: HeaderSpec; parent: null }
  | { path: string; type: "sidebar"; node: SidebarSpec; parent: null }
  | { path: string; type: "main"; node: MainRegion; parent: null }
  | { path: string; type: NodeSpec["type"]; node: NodeSpec; parent: string };

const INDEX = "(?:0|[1-9][0-9]?)";
const PATH = new RegExp(`^(?:header(?:\\.actions\\.${INDEX})?|sidebar|main(?:\\.${INDEX}){0,8})$`);
/** Longer than any real path (nesting is capped at 4 containers); a cheap bound before the regex runs. */
const MAX_PATH = 64;

export const isPathSyntax = (p: unknown): p is string => typeof p === "string" && p.length <= MAX_PATH && PATH.test(p);

/** Finds the node a path names in a normalized specification, or null. Own array indexes only; nothing is created. */
export function resolvePath(spec: UiSpec, path: unknown): Resolved | null {
  if (!isPathSyntax(path)) return null;
  const [head, ...rest] = path.split(".");
  const { header, sidebar, main } = spec.layout;
  if (head === "header") {
    if (!header) return null;
    if (rest.length === 0) return { path, type: "header", node: header, parent: null };
    const b: ButtonSpec | undefined = at(header.actions, rest[1]);
    return b ? { path, type: "button", node: b, parent: "header" } : null;
  }
  if (head === "sidebar") return sidebar ? { path, type: "sidebar", node: sidebar, parent: null } : null;
  if (rest.length === 0) return { path, type: "main", node: main, parent: null };
  let children: NodeSpec[] = main.children;
  let node: NodeSpec | undefined;
  for (let i = 0; i < rest.length; i++) {
    node = at(children, rest[i]);
    if (!node) return null;
    if (i < rest.length - 1) {
      if (node.type !== "stack" && node.type !== "grid") return null;
      children = node.children;
    }
  }
  return node ? { path, type: node.type, node, parent: path.slice(0, path.lastIndexOf(".")) } : null;
}

function at<T>(list: readonly T[], seg: string | undefined): T | undefined {
  const i = Number(seg);
  return Array.isArray(list) && Number.isInteger(i) && i >= 0 && i < list.length && Object.hasOwn(list, i) ? list[i] : undefined;
}

/** Every selectable path in document order (header, its actions, sidebar, main, then main depth-first). */
export function allPaths(spec: UiSpec): Array<{ path: string; type: SelectableType; depth: number }> {
  const out: Array<{ path: string; type: SelectableType; depth: number }> = [];
  const { header, sidebar, main } = spec.layout;
  if (header) {
    out.push({ path: "header", type: "header", depth: 0 });
    header.actions.forEach((_, i) => out.push({ path: `header.actions.${i}`, type: "button", depth: 1 }));
  }
  if (sidebar) out.push({ path: "sidebar", type: "sidebar", depth: 0 });
  out.push({ path: "main", type: "main", depth: 0 });
  const walk = (children: NodeSpec[], prefix: string, depth: number): void =>
    children.forEach((c, i) => {
      const p = `${prefix}.${i}`;
      out.push({ path: p, type: c.type, depth });
      if (c.type === "stack" || c.type === "grid") walk(c.children, p, depth + 1);
    });
  walk(main.children, "main", 1);
  return out;
}

/** The DOM attribute the renderer stamps on each selectable element (only when selection is enabled). */
export const PATH_ATTR = "data-pv-path";

type ElementLike = { closest(selector: string): { getAttribute(name: string): string | null } | null };
type ContainerLike = { contains(other: unknown): boolean };

/**
 * Click-to-select: the innermost stamped element that contains the click target wins, because `closest` starts at the
 * target and walks outwards. One delegated listener on the preview frame, no per-node handlers and no stopPropagation, so
 * a click inside a nested component can never resolve to one of its ancestors. Elements outside `root` are ignored.
 */
export function pathFromTarget(target: unknown, root: ContainerLike): string | null {
  if (!target || typeof (target as Partial<ElementLike>).closest !== "function") return null;
  const el = (target as ElementLike).closest(`[${PATH_ATTR}]`);
  if (!el || !root.contains(el)) return null;
  const p = el.getAttribute(PATH_ATTR);
  return isPathSyntax(p) ? p : null;
}
