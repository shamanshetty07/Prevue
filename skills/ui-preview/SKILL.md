---
name: ui-preview
description: Prevue workflow for building a new UI (dashboard, page, screen, or component set) from a request that gives no finished design. Use before writing UI code, not for bug fixes, refactors, backend work, or small edits to existing UI.
---

# Prevue UI preview workflow

Prevue lets the developer review and approve a UI design before it is implemented.

## Current status (Phase 1c)

- Prevue tools: `prevue_ping` (health check), `prevue_validate_spec` (checks a UI specification; changes nothing) and `prevue_register_design` (stores a validated specification as the current revision; **Prevue's gate only lets it run once a design is already approved**, see below). **There is no preview tool yet.** Never tell the developer a preview exists or was shown, and never say a design was registered unless a registration result said `registered: true`.
- Prevue starts every session in a PENDING state. While no design is approved, hooks block file edits, writing shell commands, and every tool they cannot classify as read-only, **including `prevue_register_design`**. Only the developer can approve, by typing `prevue approve <hash>`. You can never approve a design, and you must not try to touch Prevue's state.
- If a tool call is denied with a "Prevue:" message, stop and relay it to the developer. Do not look for another route to write the files.

**A valid specification is not an approved design.** Validation confirms conformance to the schema; it does not establish design quality, renderer safety, or developer approval. Implementation stays blocked unless the existing approval workflow permits it, and a validation result never changes that.

## Validation, registration, preview, approval

These are four separate steps. Validation, registration and approval exist; preview does not.

1. **Validation** (available): `prevue_validate_spec` returns the normalized spec and its hash, or issues. It registers, stores and approves nothing.
2. **Registration** (available, see below): validates again, stores the normalized (canonical) spec under its hash, and records it as a new PENDING revision, which revokes any earlier approval. Registering an identical design is a no-op. Registration never approves.
3. **Preview** (not available yet): will show the registered design in the browser.
4. **Approval** (developer only): the developer types `prevue approve <hash>` for the revision they reviewed.

## The specification format (schemaVersion 1)

Plain JSON, strict: an unknown property is an error. Everything visual is a named token. There is no HTML, CSS, URL, file path, script, event handler or image, and text is always plain text. Limits: 64 KB, at most 60 components, containers nested at most 4 deep, at most 12 children per container.

```json
{
  "schemaVersion": 1,
  "screen": { "kind": "dashboard", "name": "Expense dashboard", "purpose": "What the screen is for" },
  "theme": { "mode": "light", "accent": "blue" },
  "layout": {
    "header": { "type": "header", "title": "Expenses", "actions": [{ "type": "button", "label": "Add expense", "variant": "primary" }] },
    "sidebar": { "type": "sidebar", "items": [{ "label": "Overview", "icon": "home", "active": true }] },
    "main": { "gap": "md", "padding": "lg", "children": [ /* components */ ] }
  }
}
```

- `theme.mode`: `light` or `dark`. `theme.accent`: `blue green purple orange red gray`.
- Spacing tokens (`gap`, `padding`): `none xs sm md lg xl`.
- `header` (optional, fixed slot): `title`, optional `subtitle`, up to 3 `button` actions. `sidebar` (optional, fixed slot): 1-10 `items` of `{label, icon?, active?}`, `width` `narrow|normal`. Icons: `home chart list wallet users settings bell file`. Items are inert (no links).
- Components allowed in `main.children` (the `type` value): `stack` (`direction`, `gap`, `align`, `children`), `grid` (`columns` 1-4, `gap`, `children`), `text` (`content`, `variant` heading/subheading/body/caption, `tone`), `button` (`label`, `variant`, `note` describing what it would do), `stat-card` (`label`, `value`, optional `delta {text, trend up|down|flat}`, `hint`), `table` (`columns [{key, header, align}]` up to 8, `rows` up to 12, each row exactly as many cells as columns).
- Any component may carry an `id` (`a-z`, digits, `-`, starts with a letter, unique in the spec). Header and sidebar cannot be nested in `main`.
- Table rows hold sample text, not real data. Do not put real user or customer data in a spec.
- A full example: `docs/examples/expense-dashboard.json`.

## Registering a design

- **Developer (any time, including the first registration):** `CLAUDE_PLUGIN_DATA=<dir> node <plugin>/server/dist/src/cli.js register-design <spec.json|-> [projectDir]`. Exit codes: `0` registered or unchanged, `1` invalid specification, `2` input file problem, `3` refused or failed, `64` usage or configuration (an unset, empty or relative `CLAUDE_PLUGIN_DATA`). Output is one JSON line like the MCP result below.
- **Claude: `prevue_register_design` with `{ "spec": "<the JSON as text>" }`.** Prevue's gate treats it as state-changing, so while no design is approved it is denied like any other write. That means **you cannot make the first registration**, nor re-register while a design is pending. Hand the validated spec to the developer and ask them to run `register-design`. Once a design is approved, you may call the tool to propose a revised design; that immediately returns the gate to PENDING and the developer must approve the new hash.
- Result: `{ "registered": true, "approvedByThisCall": false, "outcome": "created|updated|unchanged", "changed": bool, "revision": n, "hash": "<64 hex>", "status": "PENDING|APPROVED", "design": "written|reused" }`, or `{ "registered": false, "approvedByThisCall": false, "kind": "parse_error|schema_error|config_error|refused|failed", "code": "...", "message": "...", "issues": [...] }`. Nothing is echoed back from your input.
- Tell the developer the `hash` and that they must type `prevue approve <first 12 characters of the hash>` for that exact revision. A registered design is not an approved design.
- Refusal codes (nothing was changed): `state_invalid`, `legacy_registration`, `stored_design_unverifiable` (the developer must run `prevue reset`), `design_cap_reached` (50 stored designs; none are deleted automatically), `design_file_conflict` and `design_store_untrusted` (something unexpected is in the design store), `canonical_too_large`. `config_error` means the plugin data or project directory is unavailable. Do not retry in a loop and do not look for another route.

## Using the validator

- **Claude: use the MCP tool.** Call `prevue_validate_spec` with `{ "spec": "<the JSON as text>" }`. The CLI is not available to you while the design is unapproved (a `node` command is not on the read-only shell list).
- **Developers and CI: use the CLI.** `node <plugin>/server/dist/src/cli.js validate <file|->` prints the same JSON. It needs no `CLAUDE_PLUGIN_DATA` and never touches Prevue state. Exit codes: `0` valid, `1` invalid, `2` file problem, `64` usage.

Success (`valid: true`; `registered` and `approved` are always false):

```json
{ "valid": true, "registered": false, "approved": false, "schemaVersion": 1, "hash": "<64 hex>", "stats": { "nodes": 9, "depth": 1 }, "spec": { "...": "the normalized spec" } }
```

Failure (an invalid spec is a normal result, not a tool error; there is no `spec` or `hash`):

```json
{ "valid": false, "registered": false, "approved": false, "kind": "parse_error | schema_error | file_error", "issues": [{ "path": "/layout/main/children/0/type", "code": "unknown_component", "message": "..." }] }
```

`kind`: `parse_error` = not usable JSON (`invalid_json`, `duplicate_key`, `too_large`, `too_complex`); `schema_error` = JSON that is not a valid spec; `file_error` = CLI only (`file_not_found`, `not_a_file`, `file_unreadable`, `too_large`, `invalid_encoding`). `path` is a JSON pointer.

Common issues and fixes:
- `missing_field` - add the required property named by `path`.
- `unknown_key` - remove it; the format has no `style`, `href`, `onclick`, `class` or similar.
- `unknown_component` - the `type` is not one of the six above (or a header/sidebar was placed in `main`).
- `invalid_value` - use one of the listed tokens; for tables, make every row as wide as `columns`, with unique column keys.
- `limit_exceeded` - too many components, children, rows, columns or sidebar items, text too long, or containers nested too deep. Simplify.
- `duplicate_id` - ids must be unique.
- `unsupported_version` - `schemaVersion` must be `1`.
- `invalid_json` - fix the syntax.
- `duplicate_key` - an object repeats a property name (after decoding escapes, so `"a"` and `"\u0061"` collide). Keep one; the path points at the repeated key.

The hash is of the normalized spec (defaults filled in, text trimmed), so reordering keys or adding explicit defaults does not change it.

## Workflow

1. Clarify the UI requirements. Ask only about what you cannot reasonably infer.
2. Write the design as a specification in the format above (layout regions, components, sample data, theme), and check it with `prevue_validate_spec`. Fix every issue it reports.
3. Show the spec to the developer. Say plainly that it passed validation (not registered unless a registration result said so, not previewed, not approved) and that only a text spec is available. Ask the developer to register it with `register-design` (or, if a design is already approved, register it yourself with `prevue_register_design`), then to approve the reported hash.
4. Revise the spec on feedback. Each revision is a new design that needs registration and fresh approval.
5. Implement only after the developer has approved the current design. Treat approval as given only if the developer said so in this conversation about this version of the design, or a Prevue message reports it. Do not infer approval from silence or from an earlier version.

Call `prevue_ping` to check that the Prevue server is reachable.
