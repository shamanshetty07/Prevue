# Prevue (Phase 0 proof of concept)

Prevue is a local-first Claude Code plugin that will let a developer preview and approve an AI-generated UI design before Claude implements it. This repository is **Phase 0**: it validates the architecture and measures how far a plugin can enforce "no implementation before approval". There is no preview UI yet.

## What is in Phase 0

| Piece | Location | Purpose |
| --- | --- | --- |
| Plugin manifest | `.claude-plugin/plugin.json` | Name and metadata only |
| Skill | `skills/ui-preview/SKILL.md` | Describes the intended workflow; honest about what is not built |
| MCP server | `server/src/index.ts`, `.mcp.json` | stdio server exposing one tool, `prevue_ping` |
| Approval gate | `server/src/gate.ts` | Hash-bound approval state and the allow/deny decision |
| Hooks | `hooks/hooks.json`, `server/src/hook.ts` | `PreToolUse` enforces the gate; `UserPromptSubmit` records developer approval |
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

The hooks and MCP entry point run from `server/dist/`, so the server must be built before the plugin is loaded. Packaging the build output for marketplace installs is deferred.

## Try it

```bash
claude --plugin-dir /path/to/Prevue     # run from a project OUTSIDE this repo
```

- `/mcp` should list `plugin:prevue:prevue` as connected; ask Claude to call `prevue_ping`.
- To exercise the gate, register a dummy design in your test project, then try to have Claude write a file:

```bash
node /path/to/Prevue/server/dist/src/cli.js set-design design.json   # gate becomes active
# Claude's Write/Edit/mutating Bash calls are now denied. As the developer, type:
#   prevue approve <first 12 chars of designHash>
node /path/to/Prevue/server/dist/src/cli.js status
```

Run the live experiments (API tokens, throwaway project outside the repo):

```bash
experiments/run.sh                      # safe subset
PREVUE_EXP_BYPASS=1 experiments/run.sh  # adds bypassPermissions + adversarial prompts
```

Results are written to `experiments/results/`.

## Scope

Out of scope for Phase 0: preview rendering, React/Vite, visual editing, persistence beyond one state file, auth, marketplace publication, and agents other than Claude Code.
