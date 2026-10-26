---
name: ui-preview
description: Prevue workflow for building a new UI (dashboard, page, screen, or component set) from a request that gives no finished design. Use before writing UI code, not for bug fixes, refactors, backend work, or small edits to existing UI.
---

# Prevue UI preview workflow

Prevue lets the developer review and approve a UI design before it is implemented.

## Current status (Phase 0 proof of concept)

- The only Prevue tool is `prevue_ping` (a health check). **There is no preview tool yet.** Never tell the developer a preview exists or was shown.
- Approval is enforced by a hook only when a design has been registered in `.prevue/state.json`. You cannot register or approve a design yourself, and you must not edit `.prevue/`.
- If a tool call is denied with a "Prevue:" message, stop and relay it to the developer. Do not look for another route to write the files.

## Workflow

1. Clarify the UI requirements. Ask only about what you cannot reasonably infer.
2. Write a structured design spec: screens, layout regions, components, data shown, states (empty, loading, error), and visual style.
3. Show the spec to the developer. When a Prevue preview tool is available, request a preview through it. Otherwise say plainly that only a text spec is available.
4. Revise the spec on feedback. Each revision is a new design that needs fresh approval.
5. Implement only after the developer has approved the current design. Treat approval as given only if the developer said so in this conversation about this version of the design, or a Prevue message reports it. Do not infer approval from silence or from an earlier version.

Call `prevue_ping` to check that the Prevue server is reachable.
