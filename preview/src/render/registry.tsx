import type { ReactElement, ReactNode } from "react";
import type { ButtonSpec, GridSpec, NodeSpec, StackSpec, StatCardSpec, TableSpec, TextSpec } from "../../../server/src/spec/schema.js";
import { Icon } from "./icons.js";
import { PATH_ATTR } from "./paths.js";
import { alignClass, colsClass, gapClass, toneClass, TREND_MARK, trendClass, variantClass } from "./tokens.js";

/**
 * The explicit component registry: one renderer per component type in the schema, looked up by an own-property check.
 * A type that is not listed here cannot render (the guard already rejects it; this is the second wall). Renderers return
 * React elements only. Text is always passed as a React child, which escapes it, so a specification can never inject
 * markup; there is no dangerouslySetInnerHTML, no URL attribute, no event handler and no style attribute anywhere.
 */
export type Renderer<N extends NodeSpec = NodeSpec> = (node: N, key: string, sel?: Selection) => ReactElement;

/**
 * Editor-only selection state. When present, every selectable element carries its structural path (`key`, see paths.ts)
 * and the selected one is marked; when absent the markup is exactly the plain preview. Neither attribute comes from the
 * specification's values: the path is built here from array positions, and the mark is a fixed string.
 */
export type Selection = { selected: string | null };
export const selectAttrs = (path: string, sel: Selection | undefined): Record<string, string | undefined> =>
  sel ? { [PATH_ATTR]: path, "data-pv-selected": sel.selected === path ? "true" : undefined } : {};

/** Buttons describe what they would do; the preview never runs anything, so they are inert (no handler, not focusable). */
export function ButtonView({ b, path, sel }: { b: ButtonSpec; path?: string; sel?: Selection | undefined }): ReactElement {
  return (
    <button type="button" className={`pv-button ${variantClass("btn", b.variant)}`} tabIndex={-1} aria-disabled="true" title={b.note} data-node-id={b.id} {...(path ? selectAttrs(path, sel) : {})}>
      {b.label}
    </button>
  );
}

const renderChildren = (children: NodeSpec[], path: string, sel: Selection | undefined): ReactNode[] => children.map((c, i) => renderNode(c, `${path}.${i}`, sel));

const stack: Renderer<StackSpec> = (n, key, sel) => (
  <div key={key} className={`pv-stack dir-${n.direction === "row" ? "row" : "column"} ${gapClass(n.gap)} ${alignClass(n.align)}`} data-node-id={n.id} {...selectAttrs(key, sel)}>
    {renderChildren(n.children, key, sel)}
  </div>
);

const grid: Renderer<GridSpec> = (n, key, sel) => (
  <div key={key} className={`pv-grid ${colsClass(n.columns)} ${gapClass(n.gap)}`} data-node-id={n.id} {...selectAttrs(key, sel)}>
    {renderChildren(n.children, key, sel)}
  </div>
);

const text: Renderer<TextSpec> = (n, key, sel) => {
  const cls = `pv-text ${variantClass("text", n.variant)} ${toneClass(n.tone)}`;
  const s = selectAttrs(key, sel);
  if (n.variant === "heading") return <h2 key={key} className={cls} data-node-id={n.id} {...s}>{n.content}</h2>;
  if (n.variant === "subheading") return <h3 key={key} className={cls} data-node-id={n.id} {...s}>{n.content}</h3>;
  return <p key={key} className={cls} data-node-id={n.id} {...s}>{n.content}</p>;
};

const button: Renderer<ButtonSpec> = (n, key, sel) => <ButtonView key={key} b={n} path={key} sel={sel} />;

const statCard: Renderer<StatCardSpec> = (n, key, sel) => (
  <div key={key} className="pv-stat" data-node-id={n.id} {...selectAttrs(key, sel)}>
    <div className="pv-stat-label">{n.label}</div>
    <div className="pv-stat-value">{n.value}</div>
    {n.delta && (
      <div className={`pv-stat-delta ${trendClass(n.delta.trend)}`}>
        <span aria-hidden="true">{TREND_MARK[n.delta.trend] ?? ""}</span> {n.delta.text}
      </div>
    )}
    {n.hint && <div className="pv-stat-hint">{n.hint}</div>}
  </div>
);

const table: Renderer<TableSpec> = (n, key, sel) => (
  <div key={key} className="pv-table-wrap" data-node-id={n.id} {...selectAttrs(key, sel)}>
    <table className="pv-table">
      {n.caption && <caption>{n.caption}</caption>}
      <thead>
        <tr>
          {n.columns.map((c) => (
            <th key={c.key} scope="col" className={alignClass(c.align)}>{c.header}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {n.rows.length === 0 ? (
          <tr><td className="pv-table-empty" colSpan={n.columns.length}>{n.emptyText ?? "No rows"}</td></tr>
        ) : (
          n.rows.map((row, r) => (
            <tr key={r}>
              {row.map((cell, c) => (
                <td key={c} className={alignClass(n.columns[c]?.align ?? "start")}>{cell}</td>
              ))}
            </tr>
          ))
        )}
      </tbody>
    </table>
  </div>
);

/** The registry. `satisfies` makes the compiler reject a schema component type that has no renderer. */
export const registry = { stack, grid, text, button, "stat-card": statCard, table } satisfies { [K in NodeSpec["type"]]: Renderer<Extract<NodeSpec, { type: K }>> };

export function renderNode(node: NodeSpec, key: string, sel?: Selection): ReactElement {
  if (!Object.hasOwn(registry, node.type)) throw new Error("unsupported component type");
  return (registry[node.type] as Renderer)(node, key, sel);
}

export { Icon };
