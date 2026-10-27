# Prevue (Phase 0 gate + Phase 1 specification validation)

Prevue is a local-first Claude Code plugin that will let a developer preview and approve an AI-generated UI design before Claude implements it. This repository has two parts so far: the **Phase 0** approval gate, which measures how far a plugin can enforce "no implementation before approval", and **Phase 1a/1b**, a UI specification format with a validator (CLI and MCP tool). **Not implemented:** registering a specification through the plugin, preview rendering, a visual editor, design comparison. A valid specification is not an approved design.

## What is in the repository

| Piece | Location | Purpose |
| --- | --- | --- |
| Plugin manifest | `.claude-plugin/plugin.json` | Name and metadata only |
| Skill | `skills/ui-preview/SKILL.md` | The workflow and the specification format; honest about what is not built |
| MCP server | `server/src/index.ts`, `.mcp.json` | stdio server exposing `prevue_ping` and the read-only `prevue_validate_spec` |
| Specification format | `server/src/spec/` | Zod schema (version 1), normalization, limits, duplicate-key check, hashing |
| Validate CLI | `server/src/validate-cli.ts`, `server/src/cli.ts` | `validate <file>` (`-` = stdin); also the developer stand-ins `init`/`status`/`reset`/`register` |
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

**Validation, registration and approval are separate.** Validation checks conformance to the schema and nothing else: it persists nothing, registers nothing and cannot approve. It does not establish design quality, renderer safety or developer approval. Registration (recording a design so the gate can be approved against it) exists only as the `register` developer stand-in, which still takes arbitrary JSON and does not validate it. Approval happens only when the developer types `prevue approve <hash>`. The design for storing a validated specification is a proposal, not an implementation: [`docs/PHASE1C-DESIGN.md`](docs/PHASE1C-DESIGN.md).

Current limitations: one screen kind (`dashboard`); `prevue_validate_spec` is permitted while the gate is PENDING because it is on the gate's exact-name read-only list (`prevue_ping`, `prevue_validate_spec`); any other Prevue tool is denied until added there; the CLI cannot be run by Claude while the gate is PENDING (shell commands are not on the read-only list), so Claude validates through the MCP tool.

## Gate in one paragraph

Prevue keeps a per-project state under the plugin data directory (`${CLAUDE_PLUGIN_DATA}`). A `SessionStart` hook creates it as **PENDING**. While the state is PENDING or INVALID (missing, malformed, inconsistent), a `PreToolUse` hook allows only tools it knows to be read-only and denies the rest, including unknown tools. Only the developer can approve, by typing `prevue approve <hash>`; approval is bound to the current design **revision**, so changing the design (even back to an earlier one) requires a fresh approval. `prevue reset` is the developer's recovery path for an INVALID state. It is a guard against Claude acting early, not a security boundary against the machine's owner. Details, evidence and limits: [`docs/ENFORCEMENT.md`](docs/ENFORCEMENT.md).

The gate can also refuse an APPROVED state whose stored canonical design cannot be verified (missing, corrupt, invalid, hash mismatch, symlinked). That check is implemented and tested, but it applies only to states carrying a `canonical` marker, which nothing in production sets until the Phase 1c registration tool exists; today's states are unaffected. Details and the proposed registration design: [`docs/PHASE1C-DESIGN.md`](docs/PHASE1C-DESIGN.md).

Consequence: with the plugin enabled, implementation is blocked in every project until a design is registered and approved. Disable the plugin for work that is not UI work.

## Try it

```bash
claude --plugin-dir /path/to/Prevue     # run from a project OUTSIDE this repo
```

- `/mcp` should list `plugin:prevue:prevue` as connected; ask Claude to call `prevue_ping`.
- Registering a design is a developer stand-in for a later tool (`prevue_register_design` does not exist yet). The CLI requires `CLAUDE_PLUGIN_DATA` to be an **absolute** path, like the hook; an unset, empty or relative value is rejected (exit 64) and nothing is written. Use the data directory your session reports, for example:

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

Not built yet: registration through the plugin, preview rendering, React/Vite, visual editing, persistence beyond one state file, auth, marketplace publication, and agents other than Claude Code.
