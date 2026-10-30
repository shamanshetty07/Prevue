import type { ButtonSpec, HeaderSpec, NodeSpec, SidebarSpec, UiSpec } from "../spec/schema.js";

/**
 * Structural paths, ported from the preview (preview/src/render/paths.ts, Phase 2b) because the server cannot import
 * across its rootDir. The grammar below must stay identical to the preview's; a test compares the two definitions.
 *
 *   header                 the header slot
 *   header.actions.<i>     the i-th header action (a button)
 *   sidebar                the sidebar slot (its items are properties of the sidebar, not components)
 *   main                   the main region
 *   main.<i>(.<j>)*        a component in main, then the j-th child of that container, and so on
 *
 * Indexes are canonical decimals (no sign, no leading zero), so each node has exactly one spelling. A path names a
 * position, never an optional `id`. Anything that does not resolve to a node is rejected; nothing is created.
 */
export type TargetType = NodeSpec["type"] | "header" | "sidebar" | "main";
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

/** True when `path` is `ancestor` itself or lies inside it (segment-wise, so "main.1" is not inside "main.10"). */
export const isSameOrDescendant = (path: string, ancestor: string): boolean => path === ancestor || path.startsWith(`${ancestor}.`);
