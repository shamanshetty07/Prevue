import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactElement } from "react";
import { fetchDesign, type DesignResponse } from "./api.js";
import { Inspector } from "./inspector/Inspector.js";
import { checkRenderable } from "./render/guard.js";
import { pathFromTarget, resolvePath } from "./render/paths.js";
import { nextSelection } from "./render/selection.js";
import { SpecView } from "./render/SpecView.js";

type Viewport = "desktop" | "tablet" | "mobile";
const VIEWPORTS: Array<{ id: Viewport; label: string; width: string }> = [
  { id: "desktop", label: "Desktop", width: "1200 px" },
  { id: "tablet", label: "Tablet", width: "820 px" },
  { id: "mobile", label: "Mobile", width: "390 px" },
];
type Load = { phase: "loading" } | { phase: "error"; code: string; message: string } | { phase: "ready"; design: Extract<DesignResponse, { ok: true }> };

export function App(): ReactElement {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  const [viewport, setViewport] = useState<Viewport>("desktop");
  // Editor-only: a structural path (see render/paths.ts). It lives in this component's state and is never sent anywhere.
  const [selected, setSelected] = useState<string | null>(null);
  const lastHash = useRef<string | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    const r = await fetchDesign(signal);
    if (signal?.aborted) return;
    if (!r.ok) {
      lastHash.current = null;
      setSelected((p) => nextSelection(p, { type: "unavailable" }, null));
      setLoad({ phase: "error", code: r.code, message: r.message });
    } else {
      // Re-render only when the design changed (a poll of an unchanged design must not reset the view).
      const changed = r.hash !== lastHash.current;
      lastHash.current = r.hash;
      setSelected((p) => nextSelection(p, { type: "design", changed }, null));
      setLoad((prev) => (changed || prev.phase !== "ready" || prev.design.status !== r.status || prev.design.revision !== r.revision ? { phase: "ready", design: r } : prev));
    }
  }, []);

  useEffect(() => {
    const ctrl = new AbortController();
    void refresh(ctrl.signal);
    // Pick up a newly registered revision without a manual reload; paused while the tab is hidden.
    const id = window.setInterval(() => {
      if (!document.hidden) void refresh(ctrl.signal);
    }, 3000);
    return () => {
      ctrl.abort();
      window.clearInterval(id);
    };
  }, [refresh]);

  const design = load.phase === "ready" ? load.design : null;
  const parsed = design ? checkRenderable(design.spec) : null;
  const spec = parsed && parsed.ok ? parsed.spec : null;
  const name = spec ? spec.screen.name : null;
  // Only a path that resolves in the current validated design counts as a selection.
  const current = spec && selected && resolvePath(spec, selected) ? selected : null;
  const select = useCallback((p: string | null) => setSelected((prev) => nextSelection(prev, { type: "pick", path: p }, spec)), [spec]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelected((p) => nextSelection(p, { type: "escape" }, null));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // One delegated listener for the whole design: the innermost stamped element under the click is selected. A click on
  // the frame outside any component clears the selection.
  const onFrameClick = (e: MouseEvent<HTMLDivElement>) => {
    if (!spec || !frameRef.current) return;
    const p = pathFromTarget(e.target, frameRef.current);
    select(p);
  };

  return (
    <div className="shell">
      <div className="shell-toolbar" role="toolbar" aria-label="Preview toolbar">
        <div className="shell-brand"><span className="shell-logo" aria-hidden="true" />Prevue</div>
        <span className="shell-sep" aria-hidden="true" />
        <div className="shell-name" title={name ?? undefined}>{name ?? (load.phase === "loading" ? "Loading design…" : "No design")}</div>
        {design && (
          <div className="shell-meta">
            <span>Revision {design.revision}</span>
            <span className="shell-code" title={design.hash}>{design.hash.slice(0, 12)}</span>
            <span className={`shell-pill ${design.approved ? "approved" : "pending"}`}>{design.approved ? "Approved" : "Pending approval"}</span>
          </div>
        )}
        <div className="shell-spacer" />
        <span className="shell-readonly">Read-only preview · selection only</span>
        <div className="shell-seg" role="group" aria-label="Viewport">
          {VIEWPORTS.map((v) => (
            <button key={v.id} type="button" aria-pressed={viewport === v.id} onClick={() => setViewport(v.id)} title={v.width}>{v.label}</button>
          ))}
        </div>
        <button type="button" className="shell-btn" onClick={() => void refresh()}>Refresh</button>
      </div>
      <div className="shell-body">
        <div className="shell-workspace">
          {load.phase === "loading" && (
            <div className="shell-state" role="status" aria-live="polite">
              <div className="shell-spinner" />
              <h2>Loading the registered design…</h2>
            </div>
          )}
          {load.phase === "error" && (
            <div className="shell-state" role="alert">
              <h2>No design to show</h2>
              <p>{load.message}</p>
              <p><code className="shell-code">{load.code}</code></p>
              <button type="button" className="shell-btn" onClick={() => void refresh()}>Try again</button>
            </div>
          )}
          {design && (
            <>
              <div className="shell-frame" data-viewport={viewport} ref={frameRef} onClick={onFrameClick}>
                <SpecView value={design.spec} selection={{ selected: current }} />
              </div>
              <p className="shell-caption">{VIEWPORTS.find((v) => v.id === viewport)?.label} · up to {VIEWPORTS.find((v) => v.id === viewport)?.width}. Click a component to inspect it; Esc clears. Approval happens in Claude Code, not here.</p>
            </>
          )}
        </div>
        {design && <Inspector spec={spec} selected={current} onSelect={select} />}
      </div>
    </div>
  );
}
