# Design note: persisting the canonical specification (Phase 1c, not implemented)

Status: **implemented and tested** (registration, canonical storage, integrity check, exact-name allowlist, design cap). **Not implemented:** pruning, preview, any live Claude Code validation of the registration tool. The original proposal is kept below; where the implementation differs, the section "As implemented" is authoritative.

## What the Phase 1b diagnostic settled (Claude Code 2.1.311, `--plugin-dir`, `claude -p`, one run)

A plugin MCP server process received an absolute `CLAUDE_PLUGIN_DATA`, equal to the value the plugin's SessionStart hook received, and `CLAUDE_PROJECT_DIR` equal to the project directory. Its working directory was the project directory. This was observed for one temporary plugin loaded by `--plugin-dir` in one non-interactive session; a marketplace install and interactive mode were not tested.

## Proposal

**Store the normalized spec content-addressed, next to `state.json`. `state.json` stays schema 2 with one optional field (`canonical: true`); the gate verifies the stored file for states that carry it.**

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
5. Call `registerDesign(dataDir, projectDir, spec, { canonical: true })` under its lock (the option sets the marker for this revision only). It bumps the revision and clears approval only when the hash changed.
6. Return `{registered: true, approved: false, revision, hash, changed}`. Registration never approves.

## As implemented

- **Core:** `server/src/register.ts` (`registerCanonical`), shared by the CLI command `register-design <file|-> [projectDir]` and the MCP tool `prevue_register_design`. `server/src/runtime.ts` resolves the environment with the hook's rules: `CLAUDE_PLUGIN_DATA` must be absolute, and the project must be an absolute `CLAUDE_PROJECT_DIR` (CLI: the argument or the working directory, made absolute). The MCP process's own working directory is never used.
- **Lock:** the whole decision-to-state-write sequence runs under the existing `withLock` mkdir lock (now exported) through `registerLocked`, the unlocked body of `registerDesign`. There is no second lock. `registerDesign` itself is unchanged for its callers.
- **Order:** validate and serialize (`canonicalJson`, the exact text that is hashed) without touching disk; refuse if over 64 KB; take the lock; read the state; check capacity; write `designs/<hash>.json` (exclusive temp file, mode 0600, fsync, then a hard link to the final name, so an existing name is never overwritten; directory 0700); re-verify the file with the gate's verifier; only then write the state with `canonical: true`.
- **Failure model:** any failure before the state write leaves state and approval untouched. If the state write fails the previous state stays valid and an unused design file may remain (an orphan; the gate reads only the file the state names; a retry reuses it). If a freshly written file fails verification it is removed. A stale `*.tmp` can survive a crash and is ignored; nothing prunes it yet.
- **Identical registration:** a no-op (no revision change, approval kept) only if the current state is canonical and its stored design verifies. A canonical state whose design no longer verifies is **not repaired**: it is refused (`stored_design_unverifiable`) and the developer must run `prevue reset`. An unmarked (legacy) state with the same hash is refused (`legacy_registration`) for the same reason: upgrading would be a state transition that the state machine does not define, and `reset` followed by registration always works.
- **Existing file under the hash:** if it verifies it is reused and its bytes are left alone (it may be differently formatted); if it does not verify, registration is refused (`design_file_conflict`) and the file is not overwritten or deleted. A symlink, directory or other non-regular file there, or a symlinked `designs/` directory, is refused (`design_store_untrusted`).
- **Cap:** 50 conforming files (`<64 hex>.json`) per project; a new design at the cap is refused (`design_cap_reached`) before anything is written; reuse of an already stored design needs no slot. The count is taken under the lock. Nothing is deleted.
- **Approve:** the hook now refuses to approve a canonical revision whose stored design does not verify (`REJECTED ... nothing was approved`), so an approval is never recorded that the gate would then refuse to honour.
- **Permission of the MCP tool:** the runtime name is `mcp__plugin_prevue_prevue__prevue_register_design`. It is deliberately not in the read-only allowlist. The gate admits it through its own rule (`isPendingRegistration` in `classify.ts`, called from `gate.ts`): exact name, state PENDING, and an input that is exactly `{spec: string}` (at most 640K characters). It is denied for INVALID or missing state (registration must not recover a broken state; the developer runs `prevue reset`), and in APPROVED state the existing policy lets it run and it moves the gate to PENDING. So Claude can register the first design and revisions but cannot approve, which makes the workflow Claude validates, Claude registers, the developer approves, Claude implements possible. Safety argument: the tool writes one validated, normalized file under the plugin data directory, never the project tree, bounded at 64 KB and 50 files per project, and its only state change is a new PENDING revision. The cost is that an agent can change which design the developer is asked to approve, which approval-by-hash makes safe.
- **Marker upgrade and pruning:** no upgrade of legacy states and no pruning exist.

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

## Approved-design integrity (implemented in the gate)

Policy: **if the state says APPROVED but Prevue cannot verify the exact canonical design associated with that approval, implementation stays blocked.**

How it is enforced:

- `state.json` may carry `canonical: true`, set by `registerDesign(..., { canonical: true })` and dropped by any later change (the marker describes one revision). `load()` rejects any other value, and a marker on a state without a design, as INVALID. Without the option, `registerDesign` behaves exactly as before.
- On every PreToolUse call for an APPROVED state with the marker, the gate calls `verifyStoredDesign` (`server/src/design-store.ts`) and, on failure, treats the state as INVALID: only known read-only tools pass, exactly as for any INVALID state, and the developer recovers with `prevue reset`. There is no cache: each hook is a fresh process, and a cache could hide a file changed after the check.
- The check, in order: `designs/` and `designs/<designHash>.json` must be a real directory and a regular file by `lstat` (no symlinks, FIFOs, devices); the file is opened with `O_NOFOLLOW`, `fstat`ed again, rejected over 64 KB, decoded as strict UTF-8, run through the full `parseSpecText` (schema, limits, duplicate keys), and the hash of the normalized result must equal the file name and `state.designHash`.
- Failures return a code only (`design_missing`, `design_untrusted`, `design_unreadable`, `design_too_large`, `design_invalid`, `design_hash_mismatch`; `design_unverifiable` if no verifier was supplied). Content, paths and parser messages are never returned.
- The revision is not stored in the design file. A revision/approval disagreement is caught by `load()` (`approvedRevision` must equal `revision`, `approvedHash` must equal `designHash`), so the file, the hash and the approval always refer to the same revision.
- The verifier is injected into the gate by the hook and loaded lazily, because it pulls in the schema library (about 27 ms per hook process; see ENFORCEMENT.md). A canonical approval with no verifier is blocked.

What it does not do: states registered without the marker (the `register` stand-in and every state that exists today) keep the old behaviour, so they are approved without a stored design. A same-user process that can write the data directory can delete the marker or forge a state; that is outside the threat model (ENFORCEMENT.md section 1). `approve` still approves a canonical revision whose file is broken; the gate then blocks and the hook says so. A registration of the same hash as an existing unmarked state is a no-op and does not add the marker; Phase 1c must decide whether to upgrade such a state (a reset and re-registration always works).

## Tool classification requirement (implemented)

`classify.ts` no longer allows `mcp__plugin_prevue_prevue__*` by prefix. The read-only MCP tools are the exact names `mcp__plugin_prevue_prevue__prevue_ping`, `mcp__plugin_prevue_prevue__prevue_validate_spec` and `mcp__ide__getDiagnostics`. A new Prevue tool is denied until it is added to that set deliberately; `prevue_register_design` must not be added to it without a separate review (it changes state, though it can never approve). Lookalike names (suffixes, case, whitespace, other plugin or server prefixes) are tested to be denied.

## Retention policy for `designs/` (proposal, nothing is pruned today)

Nothing is deleted automatically, and no pruning code exists. When it is added:

- **Never delete:** the file for `state.designHash` (the current revision, and by the state invariants also `approvedHash`); any file named by a quarantined state (`state.json.invalid-*`) so a developer can inspect or recover it; any file written within the last 24 hours (a registration may be between its two steps); anything that is not a regular `<64 hex>.json` file (report it, do not touch it).
- **Initial cap:** 50 distinct designs per project (at most 64 KB each, so about 3 MB). At the cap, registration **refuses with a clear message** instead of deleting; the developer runs an explicit prune. Trade-off: a smaller cap saves disk but loses the ability to re-open older revisions; a larger one only costs disk. Since an old design is never needed to keep an approval valid (only the current one is), a missing old file affects convenience, not enforcement.
- **How:** a developer-run command only, never an agent tool. It re-reads `state.json` under the same lock as `registerDesign` and `approve`, computes the protected set from that fresh read, deletes oldest-first by file time down to the cap, and does nothing if the state is not loadable.
- **Failure:** a failed deletion is reported with its code and leaves everything else as it was. Pruning never writes to `state.json`, so it cannot change an approval, and a failure cannot weaken the gate because the gate only ever needs the current file.
- Invariants to test when implemented: the current and quarantined-state designs survive any prune; pruning while a registration is in flight cannot remove its file; an unloadable state prunes nothing.

## Invariants checked against the proposal

1. Validation never registers: unchanged, it imports no state code (tested).
2. Registration never approves: it only calls `registerDesign`, which clears approval.
3. Invalid input never changes state: validate first, write after.
4. Preview, stored spec and approved hash match: by the reader rule, since all three are tied to `designHash`.
5. A change invalidates approval: existing `registerDesign` behaviour (tested).
6. Identical registration is a no-op for state: existing.
7. A, B, A creates a new revision and does not revive approval: existing.
8. Fail-closed gate: for marked states the gate now also verifies the stored design (see above); unmarked and unloadable states behave as before. Tested in `gate-integrity.test.ts`.

## State-machine assumptions and remaining risks

- **Unmarked states are not covered by the integrity check.** The old `register` path and `registerDesign` called without the option create them. Phase 1c registration must always pass the marker.
- **`registerDesign` accepts anything.** It hashes `unknown`. The registration tool must validate first, and the `register` CLI (used by the experiment harness with non-spec JSON) keeps registering designs with no stored spec.
- **Two files cannot change atomically.** The design is written before the state change, so a crash leaves only a harmless orphan. If the design file were removed after approval, the gate blocks (it does not stay approved).
- **A registration tool is agent-callable.** It can never approve, and registering a changed design only moves APPROVED to PENDING (fails closed), but it lets an agent change what the developer is asked to review. Approval being bound to the hash the developer saw is what makes that safe.
- **Stored size.** Normalization adds defaults, so a stored spec can be larger than the raw input; registration must reject a normalized spec over 64 KB, or the verifier would reject it later.
- **Hook cost.** Verifying a canonical approval adds about 27 ms to each guarded tool call (a fresh process loads the schema library); unmarked states add nothing.
