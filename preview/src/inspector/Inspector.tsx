import type { ReactElement } from "react";
import type { UiSpec } from "../../../server/src/spec/schema.js";
import { allPaths } from "../render/paths.js";
import { inspect, resolvePathSummary, TYPE_LABEL } from "./inspect.js";

/**
 * The read-only inspector: the selected node's schema properties, and an outline of every selectable node. Nothing here
 * can change the design: there are no inputs, and the only callback is `onSelect`, which changes editor-only selection.
 * The outline doubles as the keyboard route to selection (the rendered design itself stays non-focusable, as in Phase 2a).
 */
export function Inspector({ spec, selected, onSelect }: { spec: UiSpec | null; selected: string | null; onSelect: (path: string | null) => void }): ReactElement {
  const model = spec ? inspect(spec, selected) : null;
  return (
    <aside className="insp" aria-label="Inspector">
      <div className="insp-head">
        <h2>Inspector</h2>
        <span className="insp-tag">Read-only</span>
      </div>
      <section className="insp-selection" aria-live="polite">
        {!model ? (
          <p className="insp-empty">{spec ? "Click a component in the preview, or pick one from the outline below." : "No design is loaded."}</p>
        ) : (
          <>
            <div className="insp-title">
              <strong>{model.typeLabel}</strong>
              <code className="insp-path">{model.path}</code>
            </div>
            <div className="insp-actions">
              <button type="button" className="shell-btn" disabled={!model.parent} onClick={() => model.parent && onSelect(model.parent)}>
                Select parent
              </button>
              <button type="button" className="shell-btn" onClick={() => onSelect(null)}>
                Clear selection
              </button>
            </div>
            {model.idShared > 1 && <p className="insp-note">{model.idShared} components share this id. Selection uses the structural path, so this does not affect it.</p>}
            {model.sections.map((s) => (
              <div key={s.title} className="insp-section">
                <h3>{s.title}</h3>
                <dl>
                  {s.rows.map((r) => (
                    <div key={r.key} className="insp-row" data-key={r.key}>
                      <dt>{r.label}</dt>
                      <dd className={r.value === null ? "unset" : undefined}>{r.value ?? "not set"}</dd>
                    </div>
                  ))}
                </dl>
              </div>
            ))}
            {model.children && (
              <div className="insp-section">
                <h3>{model.type === "header" ? "Actions" : "Children"} ({model.children.length})</h3>
                {model.children.length === 0 ? (
                  <p className="insp-empty">None</p>
                ) : (
                  <ul className="insp-list">
                    {model.children.map((c) => (
                      <li key={c.path}>
                        <button type="button" className="insp-link" onClick={() => onSelect(c.path)}>
                          <span className="insp-kind">{TYPE_LABEL[c.type]}</span> <span className="insp-sum">{c.summary}</span> <code>{c.path}</code>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </>
        )}
      </section>
      {spec && (
        <nav className="insp-outline" aria-label="Component outline">
          <h3>Outline</h3>
          <ul className="insp-list">
            {allPaths(spec).map((p) => (
              <li key={p.path} className={`depth-${Math.min(p.depth, 6)}`}>
                <button type="button" className="insp-link" aria-current={p.path === selected ? "true" : undefined} onClick={() => onSelect(p.path)}>
                  <span className="insp-kind">{TYPE_LABEL[p.type]}</span> <span className="insp-sum">{resolvePathSummary(spec, p.path)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </aside>
  );
}
