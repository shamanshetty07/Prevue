# Design note: persisting the canonical specification (Phase 1c, not implemented)

Status: proposal. Nothing here exists yet. `prevue_register_design` is not implemented; today only validation exists, and it never persists anything.

## What the Phase 1b diagnostic settled (Claude Code 2.1.311, `--plugin-dir`, `claude -p`, one run)

A plugin MCP server process received an absolute `CLAUDE_PLUGIN_DATA`, equal to the value the plugin's SessionStart hook received, and `CLAUDE_PROJECT_DIR` equal to the project directory. Its working directory was the project directory. This was observed for one temporary plugin loaded by `--plugin-dir` in one non-interactive session; a marketplace install and interactive mode were not tested.

## Proposal

**Store the normalized spec content-addressed, next to `state.json`, and leave `state.json` (schema 2), `gate.ts`, `classify.ts` and the hook unchanged.**

```
${CLAUDE_PLUGIN_DATA}/projects/<key>/state.json          unchanged: revision, designHash, approval fields
${CLAUDE_PLUGIN_DATA}/projects/<key>/designs/<hash>.json the normalized spec whose canonical SHA-256 is <hash>
```

Why a separate file and not a field in `state.json`: the hook reads `state.json` on every tool call, and the gate has no use for the spec. Why content-addressed: the file name is the claim, and a reader can check it (`hashDesign(parsed) === name === state.designHash`), so a stored spec that disagrees with its hash is detectable without trusting either file.

**Registration (tool `prevue_register_design`, takes spec text, never a path):**

1. Resolve `CLAUDE_PLUGIN_DATA` (absolute, else fail) and `CLAUDE_PROJECT_DIR` (absolute, else fail) with the hook's rules. The model supplies neither.
2. `parseSpecText`; on any failure return the validation report and stop. Nothing is written.
3. `load()` the state. If INVALID and not merely missing, refuse; the developer runs `prevue reset`.
4. Write `designs/<hash>.json` (temp file, mode 0600, rename; directory 0700). If a regular file with that name already exists and verifies, keep it. Refuse if the path exists and is a symlink or non-regular file (`lstat`).
5. Call the existing `registerDesign(dataDir, projectDir, spec)` under its lock. It bumps the revision and clears approval only when the hash changed.
6. Return `{registered: true, approved: false, revision, hash, changed}`. Registration never approves.

## Behaviour

| Case | Result |
| --- | --- |
| First registration | revision 0 to 1, PENDING, design file written |
| Identical registration | no state change (existing no-op); the design file is re-verified and re-written if it was missing, which is the repair path |
| Changed registration | revision + 1, approval cleared, new design file; the old one is kept |
| A, B, A | revisions 1, 2, 3. `designs/A.json` is reused, but approval of revision 1 does not return because approval is bound to `(approvedRevision, approvedHash)` |
| Invalid spec | validation report, no file, no state change |
| Crash between steps 4 and 5 | an orphan design file, no state change; harmless |
| Crash inside step 5 | existing temp-file-and-rename atomicity; the old state stays |
| Concurrent register / register | each writes its own design file; `registerDesign` serializes, revisions stay unique |
| Concurrent register / approve | both take the same lock; approve either sees the old hash (and the developer's prefix still matches that design) or the new one (prefix mismatch error). Approval needs the hash the developer saw |
| `prevue reset` | existing quarantine of `state.json`; `designs/` is untouched, so re-registering the same spec reuses it. Revision restarts at 0, so the hash, not the revision, identifies a design across a reset |
| Existing schema-2 states | stay valid; they simply have no stored spec |

## Reader rule (preview, later)

Render only if `designs/<state.designHash>.json` exists as a regular file (no symlinks) within the size limit, parses, passes `validateSpec`, and hashes to `state.designHash`. Otherwise show "no verified specification for the current revision" and render nothing. The preview must display `state.designHash` and the revision from `state.json`, so what the developer approves is what they were shown.

## Invariants checked against the proposal

1. Validation never registers: unchanged, it imports no state code (tested).
2. Registration never approves: it only calls `registerDesign`, which clears approval.
3. Invalid input never changes state: validate first, write after.
4. Preview, stored spec and approved hash match: by the reader rule, since all three are tied to `designHash`.
5. A change invalidates approval: existing `registerDesign` behaviour (tested).
6. Identical registration is a no-op for state: existing.
7. A, B, A creates a new revision and does not revive approval: existing.
8. Fail-closed gate: unchanged, because the gate decides from `state.json` alone.

## State-machine assumptions that make this harder

- **The gate does not know about the spec.** An APPROVED state with a missing or corrupt design file stays APPROVED: implementation is allowed for a design nobody can re-inspect. Making the gate require a verified spec would change `gate.ts`/`hook.ts`; I have not done that. Decision for the maintainer: accept this (the approval was given on a hash the developer saw), or require the spec for APPROVED.
- **`registerDesign` accepts anything.** It hashes `unknown`. The registration tool must validate first, and the `register` CLI (used by the experiment harness with non-spec JSON) keeps registering designs with no stored spec. A real project can therefore be PENDING or APPROVED on a hash that has no design file.
- **Two files cannot change atomically.** The design is written before the state change, so a crash leaves only a harmless orphan.
- **`classify.ts` allows every `mcp__plugin_prevue_prevue__*` tool as read-only.** A register tool would therefore be allowed in PENDING, INVALID and APPROVED, and an agent could call it. That is acceptable only because it can never approve and registering a changed design only moves APPROVED to PENDING (fails closed). The prefix rule should be narrowed to an explicit read-only list before a write tool is added. That is a `classify.ts` change and needs a separate decision.
- **No retention limit.** `designs/` grows by one file per distinct design. Add a cap before release.
