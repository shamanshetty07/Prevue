import type { UiSpec } from "../../../server/src/spec/schema.js";
import { resolvePath } from "./paths.js";

/**
 * Every change to the editor's selection, as one pure function. The selection is only a structural path (a string) or null;
 * it holds no design data, is never sent anywhere, and nothing here can change the specification. A path is accepted only
 * if it resolves to a node in the validated specification that is on screen, so a stale, forged or malformed path becomes
 * "no selection" rather than naming something else.
 */
export type SelectionEvent =
  /** A click in the preview, an outline or child-list entry, "Select parent", or "Clear selection" (path null). `path` is untrusted. */
  | { type: "pick"; path: unknown }
  | { type: "escape" }
  /** A poll returned a design. `changed` means its hash differs from the one on screen. */
  | { type: "design"; changed: boolean }
  /** No design could be loaded (error, missing, failed integrity check). */
  | { type: "unavailable" };

export function nextSelection(prev: string | null, ev: SelectionEvent, spec: UiSpec | null): string | null {
  switch (ev.type) {
    case "pick":
      return spec !== null && resolvePath(spec, ev.path) !== null ? (ev.path as string) : null;
    case "escape":
    case "unavailable":
      return null;
    case "design":
      // A path names a position, so in a different design it may name a different node: a new design starts unselected.
      // A poll of the same design must not disturb the selection.
      return ev.changed ? null : prev;
  }
}
