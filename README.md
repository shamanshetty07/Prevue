# Prevue (Phase 0 proof of concept)

Prevue is a local-first Claude Code plugin that will let a developer preview and approve an AI-generated UI design before Claude implements it. This repository is **Phase 0**: it validates the architecture and measures how far a plugin can enforce "no implementation before approval". There is no preview UI yet.

## What is in Phase 0

| Piece | Location | Purpose |
| --- | --- | --- |
| Plugin manifest | `.claude-plugin/plugin.json` | Name and metadata only |
| Skill | `skills/ui-preview/SKILL.md` | Describes the intended workflow; honest about what is not built |
| MCP server | `server/src/index.ts`, `.mcp.json` | stdio server exposing one tool, `prevue_ping` |
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

The hooks and MCP entry point run from `server/dist/`, which is git-ignored, so the server must be built before the plugin is loaded (`npm run build` in `server/`; `npm test` also builds). In one isolated diagnostic, a missing compiled hook made Claude Code block a Write (`onFailure: "block"`), so an unbuilt checkout fails closed but can disrupt ordinary work while the plugin is enabled. Packaging the build output for marketplace installs is deferred.

## Gate in one paragraph

Prevue keeps a per-project state under the plugin data directory (`${CLAUDE_PLUGIN_DATA}`). A `SessionStart` hook creates it as **PENDING**. While the state is PENDING or INVALID (missing, malformed, inconsistent), a `PreToolUse` hook allows only tools it knows to be read-only and denies the rest, including unknown tools. Only the developer can approve, by typing `prevue approve <hash>`; approval is bound to the current design **revision**, so changing the design (even back to an earlier one) requires a fresh approval. `prevue reset` is the developer's recovery path for an INVALID state. It is a guard against Claude acting early, not a security boundary against the machine's owner. Details, evidence and limits: [`docs/ENFORCEMENT.md`](docs/ENFORCEMENT.md).

Consequence: with the plugin enabled, implementation is blocked in every project until a design is registered and approved. Disable the plugin for work that is not UI work.

## Try it

```bash
claude --plugin-dir /path/to/Prevue     # run from a project OUTSIDE this repo
```

- `/mcp` should list `plugin:prevue:prevue` as connected; ask Claude to call `prevue_ping`.
- Registering a design is a developer stand-in for the Phase 1 tool. Use the data directory your session reports (`CLAUDE_PLUGIN_DATA`), for example:

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

Out of scope for Phase 0: preview rendering, React/Vite, visual editing, persistence beyond one state file, auth, marketplace publication, and agents other than Claude Code.
