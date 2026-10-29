import type { ReactElement } from "react";
import type { UiSpec } from "../../../server/src/spec/schema.js";
import { checkRenderable } from "./guard.js";
import { ButtonView, Icon, renderNode, selectAttrs, type Selection } from "./registry.js";
import { gapClass, padClass } from "./tokens.js";

/**
 * Pure view of a normalized, guard-checked specification. No state, no effects, no randomness: same input, same markup.
 * `sel` (editor-only) adds structural-path and selected-state attributes; it never changes what the design renders.
 */
function Screen({ spec, sel }: { spec: UiSpec; sel?: Selection | undefined }): ReactElement {
  const { header, sidebar, main } = spec.layout;
  return (
    <div className="pv-app" data-mode={spec.theme.mode} data-accent={spec.theme.accent} data-screen={spec.screen.kind} data-selectable={sel ? "true" : undefined}>
      {header && (
        <header className="pv-header" data-node-id={header.id} {...selectAttrs("header", sel)}>
          <div className="pv-header-titles">
            <h1 className="pv-header-title">{header.title}</h1>
            {header.subtitle && <div className="pv-header-subtitle">{header.subtitle}</div>}
          </div>
          <div className="pv-header-actions">
            {header.actions.map((a, i) => (
              <ButtonView key={i} b={a} path={`header.actions.${i}`} sel={sel} />
            ))}
          </div>
        </header>
      )}
      <div className="pv-body">
        {sidebar && (
          <nav className={`pv-sidebar ${sidebar.width === "narrow" ? "w-narrow" : "w-normal"}`} aria-label={sidebar.title ?? "Navigation"} data-node-id={sidebar.id} {...selectAttrs("sidebar", sel)}>
            {sidebar.title && <div className="pv-sidebar-title">{sidebar.title}</div>}
            <ul className="pv-sidebar-items">
              {sidebar.items.map((it, i) => (
                <li key={i} className={it.active ? "pv-nav-item active" : "pv-nav-item"} aria-current={it.active ? "page" : undefined}>
                  {it.icon && <Icon name={it.icon} />}
                  <span>{it.label}</span>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <main className={`pv-main ${gapClass(main.gap)} ${padClass(main.padding)}`} {...selectAttrs("main", sel)}>{main.children.map((c, i) => renderNode(c, `main.${i}`, sel))}</main>
      </div>
    </div>
  );
}

/** Renders an untrusted value: guard first, then the registry. A rejected specification renders an error, never partial UI. */
export function SpecView({ value, selection }: { value: unknown; selection?: Selection | undefined }): ReactElement {
  const r = checkRenderable(value);
  if (!r.ok) {
    return (
      <div className="pv-render-error" role="alert">
        <strong>This design cannot be rendered.</strong>
        <ul>
          {r.issues.map((m, i) => (
            <li key={i}>{m}</li>
          ))}
        </ul>
      </div>
    );
  }
  return <Screen spec={r.spec} sel={selection} />;
}
