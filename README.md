# Prevue (Phase 0 gate + Phase 1 specification validation)

Prevue is a local-first Claude Code plugin that will let a developer preview and approve an AI-generated UI design before Claude implements it. This repository has three parts so far: the **Phase 0** approval gate, which measures how far a plugin can enforce "no implementation before approval"; **Phase 1a/1b**, a UI specification format with a validator (CLI and MCP tool); and **Phase 1c**, registration of a validated specification with canonical storage. **Not implemented:** preview rendering, a visual editor, design comparison, pruning of stored designs. A valid or registered specification is not an approved design.

## What is in the repository

| Piece | Location | Purpose |
| --- | --- | --- |
| Plugin manifest | `.claude-plugin/plugin.json` | Name and metadata only |
| Skill | `skills/ui-preview/SKILL.md` | The workflow and the specification format; honest about what is not built |
| MCP server | `server/src/index.ts`, `.mcp.json` | stdio server exposing `prevue_ping`, the read-only `prevue_validate_spec`, and the state-changing `prevue_register_design` |
| Specification format | `server/src/spec/` | Zod schema (version 1), normalization, limits, duplicate-key check, hashing |
| Registration | `server/src/register.ts`, `server/src/runtime.ts`, `server/src/design-store.ts` | Canonical design storage, registration core, stored-design verification (used by the gate) |
| CLI | `server/src/cli.ts`, `server/src/validate-cli.ts` | `validate <file>` (`-` = stdin), `register-design <file>`; also the developer stand-ins `init`/`status`/`reset`/`register` |
| Approval state | `server/src/state.ts` | PENDING / APPROVED / INVALID state machine, revisions, locking |
| Tool policy | `server/src/classify.ts`, `server/src/gate.ts` | Read-only allowlist, shell classifier, allow/deny decision |
| Hooks | `hooks/hooks.json`, `server/src/hook.ts` | `SessionStart` initializes, `PreToolUse` enforces, `UserPromptSubmit` records developer commands |
| Experiments | `experiments/` | Live Claude Code runs and recorded results |
| Findings | [`docs/ENFORCEMENT.md`](docs/ENFORCEMENT.md) | What was proven, what was not, bypass paths |

## Build and test

Requires Node 20+ and Claude Code 2.1.295+ (for `onFailure: "block"`).

```bash
cd server
npm ci
npm test            # builds, then runs the unit, MCP-over-stdio and config tests
cd ..
claude plugin validate .
```

The hooks, the MCP server and the CLI run from `server/dist/`, which is git-ignored, so a fresh checkout has no compiled code and the server **must be built before the plugin is loaded**: `cd server && npm ci && npm run build` (`npm test` also builds). A `dist/` built before Phase 1b has neither the `validate` command nor the `prevue_validate_spec` tool; rebuild after updating. In one isolated diagnostic, a missing compiled hook made Claude Code block a Write (`onFailure: "block"`), so an unbuilt checkout fails closed but can disrupt ordinary work while the plugin is enabled. Packaging the build output for marketplace installs is deferred.

## Validate a specification (Phase 1b)

```bash
node /path/to/Prevue/server/dist/src/cli.js validate design.json     # or "-" to read stdin
```

Prints one JSON line and exits `0` (valid), `1` (not valid), `2` (the file could not be read: missing, not a regular file, unreadable, over 64 KB, not UTF-8) or `64` (usage). A valid result carries the normalized specification and its SHA-256; an invalid one carries structured issues (`kind`: `parse_error`, `schema_error` or `file_error`; each issue has a JSON-pointer `path`, a `code` and a short `message` that never contains the input). `validate` needs no `CLAUDE_PLUGIN_DATA` and never reads or writes Prevue state. Claude Code calls the same engine through the MCP tool `prevue_validate_spec` (input: the specification as text). Both reject unknown properties, anything that is not a named token (no HTML, CSS, URLs, paths or scripts), and objects that repeat a property name. The format and limits are in `skills/ui-preview/SKILL.md`; an example is `docs/examples/expense-dashboard.json`.

**Validation, registration and approval are separate.** Validation checks conformance to the schema and nothing else: it persists nothing, registers nothing and cannot approve. It does not establish design quality, renderer safety or developer approval.

**Registration** (Phase 1c) validates again, stores the normalized canonical specification at `${CLAUDE_PLUGIN_DATA}/projects/<key>/designs/<sha256>.json`, verifies it, and only then records the hash as a new **PENDING** revision with a `canonical` marker; a changed design clears any earlier approval, an identical one is a no-op. It never approves.

```bash
CLAUDE_PLUGIN_DATA=<absolute dir> node /path/to/Prevue/server/dist/src/cli.js register-design design.json "$PWD"   # or "-" for stdin
```

Prints one JSON line (`registered`, `outcome` created/updated/unchanged, `revision`, `hash`, `status`, or `kind`/`code`/`message`/`issues`). Exit codes: `0` registered or unchanged, `1` invalid specification, `2` input file problem, `3` refused or failed (invalid state, full store, conflicting file, ...), `64` usage or an unset, empty or relative `CLAUDE_PLUGIN_DATA`. The MCP tool `prevue_register_design` takes `{spec: "<json text>"}`, uses the same core, and reads `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR` (both must be absolute; the server's working directory is not used). The older `register` command is unchanged: it still takes arbitrary JSON, validates nothing and sets no marker.

**Approval** happens only when the developer types `prevue approve <hash>`, and it is refused for a canonical revision whose stored design cannot be verified. With the marker present, the gate re-verifies the stored design on every guarded call and blocks implementation if it is missing, corrupt, invalid, a different design, or a symlink. Each project keeps at most 50 stored designs; a new design beyond that is refused and nothing is deleted. Recovery is `prevue reset` (developer only). Details: [`docs/PHASE1C-DESIGN.md`](docs/PHASE1C-DESIGN.md), [`docs/ENFORCEMENT.md`](docs/ENFORCEMENT.md).

Current limitations: one screen kind (`dashboard`); `prevue_validate_spec` is permitted while the gate is PENDING because it is on the gate's exact-name read-only list (`prevue_ping`, `prevue_validate_spec`); `prevue_register_design` changes state and is **not** on it, so the gate denies it until a design is approved, which means **Claude cannot make the first registration: the developer runs `register-design`**; any other Prevue tool is denied until added deliberately; registration and the gate were tested through unit, process and MCP-over-stdio tests, not inside a live Claude Code session; interactive mode and marketplace installs are untested; the CLI cannot be run by Claude while the gate is PENDING (shell commands are not on the read-only list), so Claude validates through the MCP tool.

## Gate in one paragraph

Prevue keeps a per-project state under the plugin data directory (`${CLAUDE_PLUGIN_DATA}`). A `SessionStart` hook creates it as **PENDING**. While the state is PENDING or INVALID (missing, malformed, inconsistent), a `PreToolUse` hook allows only tools it knows to be read-only and denies the rest, including unknown tools. Only the developer can approve, by typing `prevue approve <hash>`; approval is bound to the current design **revision**, so changing the design (even back to an earlier one) requires a fresh approval. `prevue reset` is the developer's recovery path for an INVALID state. It is a guard against Claude acting early, not a security boundary against the machine's owner. Details, evidence and limits: [`docs/ENFORCEMENT.md`](docs/ENFORCEMENT.md).

The gate also refuses an APPROVED state whose stored canonical design cannot be verified (missing, corrupt, invalid, hash mismatch, symlinked). That applies to states created by `register-design` or `prevue_register_design` (they carry a `canonical` marker); states registered with the older `register` stand-in are not checked. Details: [`docs/PHASE1C-DESIGN.md`](docs/PHASE1C-DESIGN.md).

Consequence: with the plugin enabled, implementation is blocked in every project until a design is registered and approved. Disable the plugin for work that is not UI work.

## Try it

```bash
claude --plugin-dir /path/to/Prevue     # run from a project OUTSIDE this repo
```

- `/mcp` should list `plugin:prevue:prevue` as connected; ask Claude to call `prevue_ping`.
- `register-design` (above) is the supported way to register; the older `register` is a developer stand-in kept for the experiment harness. The CLI requires `CLAUDE_PLUGIN_DATA` to be an **absolute** path, like the hook; an unset, empty or relative value is rejected (exit 64) and nothing is written. Use the data directory your session reports, for example:

```bash
export CLAUDE_PLUGIN_DATA=~/.claude/plugins/data/prevue-inline   # layout per the docs; confirm on your install
node /path/to/Prevue/server/dist/src/cli.js register design.json "$PWD"
node /path/to/Prevue/server/dist/src/cli.js status "$PWD"
# then, in the Claude Code prompt, as the developer:
#   prevue approve <first 12 chars of the design hash>
```

Experiments (each run costs API tokens and uses throwaway directories):

- `experiments/bypass-probe.sh` is the bounded `bypassPermissions` probe (Write tool only, hard limits). Against the hardened gate, two unapproved-Write runs (A2a, A2b) were denied by Prevue in `bypassPermissions` mode; the approved control is only partly established (D0's allow is inferred, A1 was inconclusive). See [`docs/ENFORCEMENT.md`](docs/ENFORCEMENT.md) section 8 for scope and limits.
- `experiments/run.sh` is the original Phase 0 runner and targets the old state layout; do not use it.

## Scope

Not built yet: preview rendering, pruning of stored designs, React/Vite, visual editing, persistence beyond one state file and the stored canonical designs, auth, marketplace publication, and agents other than Claude Code.
