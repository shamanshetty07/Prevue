# Approval gate: design, evidence, limits

Status: **hardened design implemented and unit-tested; not yet re-verified in a live Claude Code session.** Live evidence below was gathered against the earlier Phase 0 implementation and is labelled as such.

## 1. Threat model

| Case | Addressed? |
| --- | --- |
| A. Claude accidentally implements before approval | **Yes** (primary goal) |
| B. Claude tries to route around the workflow | **Best effort**: covers tool calls that pass through `PreToolUse`; see section 7 |
| C. The developer disables or edits Prevue (`disableAllHooks`, `--bare`, `--safe-mode`, disabling the plugin, editing files) | **No.** Not a security boundary against the machine's owner |
| D. Another process running as the same user | **No.** State is a plain file; there is no secret and no OS-level separation |

Everything below should be read with this scope. Nothing here claims unapproved changes are impossible.

## 2. State machine

States (per project):

| State | Meaning | Implementation tools |
| --- | --- | --- |
| `PENDING` | No approved revision. A new project starts here with `revision 0` and no design | blocked |
| `APPROVED` | `approvedRevision == revision` and `approvedHash == designHash` | allowed (minus section 6 exceptions) |
| `INVALID` | State missing, unreadable, malformed, inconsistent, a symlink, or bound to another project; or `CLAUDE_PLUGIN_DATA` unset/relative | blocked |

Transitions:

- `SessionStart` hook: create `PENDING` if the file does not exist (exclusive create). Never repairs or overwrites an existing file, valid or not.
- Register design (`cli.js register`, later the Phase 1 MCP tool): unchanged content is a no-op; any change does `revision += 1` and clears the approval, **even if the content equals an earlier design**.
- Developer types `prevue approve <hash-prefix>` (8+ hex chars, mandatory): approves the **current revision** only if the prefix matches its hash. Idempotent.
- Developer types `prevue reset`: moves whatever is on disk aside (never deleted) and starts a fresh `PENDING`. This is the only recovery path from `INVALID`.

A tool call that arrives when the file is missing is `INVALID`, not "gate off". Only `SessionStart` creates state, so a failed or skipped `SessionStart` leaves the gate closed.

## 3. Revision-specific approval

`A approved -> B registered -> A registered` ends in `PENDING` at revision 3. The old approval of A cannot return because approval is stored as `(approvedRevision, approvedHash)` and cleared on every accepted change; `load()` also rejects any file where `approvedRevision != revision`.

## 4. Where state lives and how it is protected

`${CLAUDE_PLUGIN_DATA}/projects/<sha256(real project path)[:32]>/state.json` (documented: the plugin's persistent data directory, exported to hook processes and MCP servers; it survives plugin updates and is deleted on uninstall).

- Moved out of the project tree, so ordinary project-file edits cannot reach it and a repository checkout cannot carry an approval.
- Writes are atomic (temp file + rename) and serialized with a lock directory; stale locks (15 s) are broken. Concurrency is covered by tests using separate processes.
- While `PENDING`/`INVALID`, every write path is already blocked. While `APPROVED`, file tools whose resolved real path (symlinks followed, case-folded on macOS) is inside the data directory are denied, as are shell commands that name it.
- The earlier `.prevue/` text matching is gone, so mentioning `.prevue` in file content no longer causes denials.
- **Not protected:** once `APPROVED`, unrestricted shell can reach the file by an indirect path (a glob such as `~/.cla*/plugins/dat*`). This is asserted by a test named `KNOWN LIMITATION`. A same-user process can always rewrite the file, including forging an approval.
- Migration: Phase 0 state in `<project>/.prevue/state.json` is ignored (prototype data, no users). Nothing was deleted.

## 5. Tool classification

Source of the tool list: the `tools` array in the `init` message of the installed Claude Code (2.1.310) and the official tools reference. `MultiEdit` does not exist in this version; it stays on the deny list defensively.

While `PENDING` or `INVALID`:

- **Allowed (known read-only):** Read, Glob, Grep, LSP, ToolSearch, WaitForMcpServers, ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool, CronList, ListAgents, TaskGet, TaskList, TaskCreate/TaskUpdate/TodoWrite (session checklist), WebSearch, WebFetch, AskUserQuestion, EnterPlanMode, ExitPlanMode, Skill, EndConversation, SubagentHandback, Prevue's own MCP tools (`mcp__plugin_prevue_prevue__*`), `mcp__ide__getDiagnostics`.
- **Allowed by classification:** Bash and Monitor, only when `command` passes the read-only shell classifier (section 6). Agent/Task unless `isolation` is requested.
- **Denied:** Write, Edit, MultiEdit, NotebookEdit; non-read-only Bash/Monitor; PowerShell; Workflow; EnterWorktree/ExitWorktree; TaskStop; PushNotification; DesignSync; Artifact; SendUserFile; every other MCP tool (including `mcp__ide__executeCode` and the claude.ai connectors); **any tool name this code does not know**; a missing or non-string tool name; malformed `tool_input` for classified tools.
- **Always denied, in every state:** CronCreate, ScheduleWakeup, RemoteTrigger, SendMessage. The docs say `UserPromptSubmit` "also fires on turns Claude Code starts on its own" and document no origin field. A scheduled or cross-session prompt reading `prevue approve <hash>` might therefore be taken for the developer. Whether it would is **unverified**; the tools are disabled as a precaution (this also disables `/loop` and agent resume via SendMessage while Prevue is active).

When `APPROVED`, everything else is allowed (the developer approved implementation), except the data-directory protection above and the always-denied tools.

Subagents: their tool calls reach `PreToolUse` (observed for `Write` in `-p` mode), so they are treated like the main agent; `agent_id` is not used for policy.

## 6. Shell classifier

A command is read-only only if it contains none of `; & | < > \` $ \ ( ) { }`, newline, CR or NUL, is at most 2000 characters, and its first word is one of `ls pwd cat head tail wc grep echo which stat`, or `find` without `-exec/-execdir/-ok/-okdir/-delete/-fprint*/-fls`, or `git status|diff|log|show|rev-parse` without any long option that is an abbreviation of `--output`, `--ext-diff` or `--open-files-in-pager` (git accepts unambiguous prefixes such as `--out=`). Everything else is denied.

- `file` was removed: `file -C` writes a compiled magic file. Regression tests cover `file -C`, `--compile`, `-bC` and plain `file`.
- Regression tests cover about 60 unsafe or ambiguous commands, both on the classifier and through the gate.
- **Residual:** this is a text heuristic. It cannot see shell aliases/functions that a user's shell environment may define, repository-configured git behaviour (`core.fsmonitor`, textconv, external diff drivers), or tools that write as a side effect of reading. A malicious repository or user environment (threat cases C/D) can defeat it. After approval, shell is unrestricted by design.

## 7. What is and is not covered

Covered: tool calls that pass through `PreToolUse` in the session, including subagents (observed).

Not covered / unverified:

- Anything that does not pass through `PreToolUse`: harness-run shell injection in skill content (`` !`cmd` ``), plugin-declared monitors, hooks in other plugins, the user's own `!` commands, MCP servers writing on their own behalf outside a tool call.
- Interactive sessions (only non-interactive `claude -p` was exercised).
- `auto` mode (the default in the author's environment) and `--dangerously-skip-permissions` as a separate flag.
- Whether `CLAUDE_PLUGIN_DATA` is set for hooks in a real `--plugin-dir` session. The documentation says so and the directory `~/.claude/plugins/data/prevue-inline` exists after earlier sessions, but **the hardened hook has not run live**.
- Whether a `Monitor` output line or other self-started turn can emit text that matches the approval command (the command is matched against the whole prompt, which limits but does not exclude this).
- Packaging: hooks and server run from `server/dist/`. If it is missing, `onFailure: "block"` is documented to block every tool call in every project. Not tested; needs a bundling decision before release.

## 8. Evidence

### Unit and process tests (`cd server && npm test`)

Deterministic, run entirely in temp directories. They cover: missing/malformed/inconsistent/symlinked/foreign state, init races, concurrent registration from 8 processes (unique revisions, no lost update, no stale lock), stale locks, A -> B -> A, unchanged re-registration, unknown/MCP/malformed tool names, Monitor and Agent classification, scheduling tools in every state, data-directory protection (case, symlink, relative path, shell), the hook processes themselves (SessionStart, PreToolUse, UserPromptSubmit, malformed JSON, unset/relative `CLAUDE_PLUGIN_DATA`), and the shell classifier.
Mutation check (performed once, not part of the suite): reverting the revision reset, allowing unknown tools, treating missing state as "no gate", re-adding `file`, and removing the SessionStart init each made tests fail.

### Live evidence (Claude Code 2.1.310, `claude -p`) against the Phase 0 implementation

`experiments/results/` (older single-file state in the project tree, hash-only approval): Write denied while unapproved even with an allow rule; wrong-hash approval rejected; approval unlocked Write; design change revoked it; a prompt claiming approval had no effect; the agent could not edit the state file; a subagent's Write was denied; corrupt state failed closed; `disableAllHooks` bypassed the gate (expected, case C).
`experiments/results/bypass-probe-run-20261026T175838Z/`: with `--permission-mode bypassPermissions`, an approved Write succeeded and two unapproved Writes were denied (3/3 as expected; Write tool only).

These results are **not** re-established for the hardened code. `experiments/bypass-probe.sh` has been updated for the new state location but has not been run.

## 9. Open items

1. Run the bounded probe against the hardened code (also confirms the data-directory assumption).
2. Decide the packaging approach (committed bundle vs install step) and test the missing-`dist` failure mode.
3. Measure whether the skill is triggered, and whether self-started turns can forge `prevue approve`.
4. Define how the developer configures extra read-only MCP tools.
5. Real separation between agent and approval channel needs an OS boundary (for example Claude Code's sandbox for shell); a plugin alone cannot provide it.
