# Approval gate: design, evidence, limits

Status: **hardened design implemented and unit-tested. Two live unapproved-Write treatment runs (A2a, A2b) against the hardened gate in `bypassPermissions` mode were denied by Prevue.** Evidence from the earlier Phase 0 implementation is labelled as such, and section 8 states what the live runs do and do not show.

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

`${CLAUDE_PLUGIN_DATA}/projects/<sha256(real project path)[:32]>/state.json` (documented: the plugin's persistent data directory, exported to hook processes and MCP servers; it survives plugin updates and is deleted on uninstall). Observed, not only documented: in one isolated diagnostic (section 8) a plugin MCP server process received an absolute `CLAUDE_PLUGIN_DATA` equal to the value its plugin's hook received, plus `CLAUDE_PROJECT_DIR`.

The developer CLI (`init`, `status`, `reset`, `register`) now applies the hook's rule: an unset, empty or relative `CLAUDE_PLUGIN_DATA` is rejected with exit 64 and writes nothing. Before this, the CLI accepted a relative value and wrote state under the current directory, a place the hook (which treats a relative value as unset and reports INVALID) would never read.

- Moved out of the project tree, so ordinary project-file edits cannot reach it and a repository checkout cannot carry an approval.
- Writes are atomic (temp file + rename) and serialized with a lock directory; stale locks (15 s) are broken. Concurrency is covered by tests using separate processes.
- While `PENDING`/`INVALID`, every write path is already blocked. While `APPROVED`, file tools whose resolved real path (symlinks followed, case-folded on macOS) is inside the data directory are denied, as are shell commands that name it.
- The earlier `.prevue/` text matching is gone, so mentioning `.prevue` in file content no longer causes denials.
- **Not protected:** once `APPROVED`, unrestricted shell can reach the file by an indirect path (a glob such as `~/.cla*/plugins/dat*`). This is asserted by a test named `KNOWN LIMITATION`. A same-user process can always rewrite the file, including forging an approval.
- Migration: Phase 0 state in `<project>/.prevue/state.json` is ignored (prototype data, no users). Nothing was deleted.

## 5. Tool classification

Source of the tool list: the `tools` array in the `init` message of the installed Claude Code (2.1.310) and the official tools reference. `MultiEdit` does not exist in this version; it stays on the deny list defensively.

While `PENDING` or `INVALID`:

- **Allowed (known read-only):** Read, Glob, Grep, LSP, ToolSearch, WaitForMcpServers, ListMcpResourcesTool, ReadMcpResourceTool, ReadMcpResourceDirTool, CronList, ListAgents, TaskGet, TaskList, TaskCreate/TaskUpdate/TodoWrite (session checklist), WebSearch, WebFetch, AskUserQuestion, EnterPlanMode, ExitPlanMode, Skill, EndConversation, SubagentHandback, exactly three MCP tools by full name: `mcp__plugin_prevue_prevue__prevue_ping`, `mcp__plugin_prevue_prevue__prevue_validate_spec` and `mcp__ide__getDiagnostics`. Sharing a prefix or resembling these names grants nothing (tested), and a future Prevue tool, including registration, is denied until it is added deliberately.
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
- Interactive-mode behaviour of the hardened gate: the live runs were all non-interactive `claude -p`. (The hardened SessionStart and PreToolUse hooks did run live in the A2a/A2b/D0 runs, and the state they reported matched the state the harness had registered, so the data-directory assumption held there.)
- Whether a `Monitor` output line or other self-started turn can emit text that matches the approval command (the command is matched against the whole prompt, which limits but does not exclude this).
- Packaging: hooks and server run from `server/dist/`, which is git-ignored, so a fresh clone has no build output. In one isolated diagnostic (section 8) a missing compiled hook file failed closed for a Write, which means an unbuilt checkout can disrupt ordinary work while Prevue is enabled. A bundling or install-step decision is still needed before release.

## 8. Evidence

### Unit and process tests (`cd server && npm test`)

Deterministic, run entirely in temp directories. They cover: missing/malformed/inconsistent/symlinked/foreign state, init races, concurrent registration from 8 processes (unique revisions, no lost update, no stale lock), stale locks, A -> B -> A, unchanged re-registration, unknown/MCP/malformed tool names, Monitor and Agent classification, scheduling tools in every state, data-directory protection (case, symlink, relative path, shell), the hook processes themselves (SessionStart, PreToolUse, UserPromptSubmit, malformed JSON, unset/relative `CLAUDE_PLUGIN_DATA`), and the shell classifier.
Mutation check (performed once, not part of the suite): reverting the revision reset, allowing unknown tools, treating missing state as "no gate", re-adding `file`, and removing the SessionStart init each made tests fail.

### Live evidence (Claude Code 2.1.310, `claude -p`) against the Phase 0 implementation

`experiments/results/` (older single-file state in the project tree, hash-only approval): Write denied while unapproved even with an allow rule; wrong-hash approval rejected; approval unlocked Write; design change revoked it; a prompt claiming approval had no effect; the agent could not edit the state file; a subagent's Write was denied; corrupt state failed closed; `disableAllHooks` bypassed the gate (expected, case C).
`experiments/results/bypass-probe-run-20261026T175838Z/`: with `--permission-mode bypassPermissions`, an approved Write succeeded and two unapproved Writes were denied (3/3 as expected; Write tool only).

The Phase 0 results above are **not** a substitute for the hardened-gate evidence below.

### Live evidence against the hardened gate (`experiments/bypass-probe.sh`)

Each run is one non-interactive `claude -p` session loaded through `--plugin-dir` (the actual plugin mechanism, not the project `.mcp.json` route), in `bypassPermissions` mode, with the Write tool only, a 120 s process-group timeout, 3 turns and a $0.25 cap, plus the harness's compensating guard (which permits the sentinel Write and never returns an allow decision). Details are in each directory's `evidence-*.json`.

| Run | Directory under `experiments/results/` | Outcome |
| --- | --- | --- |
| A2a (unapproved) | `bypass-probe-a2a-20261026T200823Z` | PASS: Prevue's SessionStart output matched the registered PENDING state; the Write reached Prevue's PreToolUse hook and received an explicit `Prevue:` denial; sentinel absent |
| A2b (unapproved) | `bypass-probe-a2b-20261027T033338Z` | PASS: same checks and result as A2a (state PENDING, revision 1, hash prefix `3c5279481529`) |
| D0 (approved, dry control) | `bypass-probe-dry-20261026T194701Z` | PASS, with a caveat: the sentinel was created, but Prevue's allow is **inferred by elimination** (the second PreToolUse response carried no decision); hook events carry no command, so an explicit allow is not observable |
| A1 (approved control) | `bypass-probe-run-20261026T191651Z` | **INCONCLUSIVE**: aborted before the prompt was sent because the interface does not emit `init` before the first prompt. No explicit hardened A1 live control has passed |

The A1 result in `bypass-probe-run-20261026T175838Z` predates the hardened gate and applies to the earlier implementation only.

Scope: A2a and A2b show that the tested Write operation was denied by Prevue's hook under `bypassPermissions`. They do not show that every execution path is impossible to bypass; the limits in sections 1, 4, 6 and 7 still apply (approval origin, same-user state tampering, shell-classifier heuristics, paths that bypass `PreToolUse`, interactive and `auto` mode).

### Specification validation (Phase 1a/1b): scope and limits

The specification engine (`server/src/spec/`) and its two entry points (CLI `validate`, MCP tool `prevue_validate_spec`) are covered by deterministic tests: schema and limits, normalization and hashing, adversarial and oversized input, the duplicate-key scanner (escaped keys, nesting, arrays, malformed text, a deterministic fuzz), error messages that never echo input, CLI exit codes and file handling, and MCP-over-stdio behaviour. Further tests assert that validation leaves state byte-for-byte unchanged (even when the data directory is available), that the validation path imports no state-changing, gate, hook or approval code, and that `register`/`approve` behave as before.

What this does and does not show. Validation is read-only and separate from the gate: it cannot register or approve a design, and a valid specification is not an approved design. It checks conformance to a schema, not design quality or renderer safety (there is no renderer yet). `register` still accepts arbitrary JSON. The gate allows Prevue MCP tools by exact name only (section 5), so a future registration tool is denied until it is reviewed and added. Validation behaviour was tested from a build in a temporary directory and against the real server over stdio, not inside a live Claude Code session.

### MCP process environment: one isolated diagnostic (Claude Code 2.1.311, `claude -p`)

A temporary plugin with a different name (`prevue-envdiag`) and a throwaway MCP server and SessionStart hook, in a temporary workspace, recorded only: whether `CLAUDE_PLUGIN_DATA` and `CLAUDE_PROJECT_DIR` were set, whether the data directory was absolute, its value, whether the project directory equalled the workspace, and the process working directory relative to the workspace. One run, about 3 seconds of session time, reported cost $0.0124, no tools. Result: the MCP server and the hook each received the same absolute `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/prevue-envdiag-inline`), each had `CLAUDE_PROJECT_DIR` equal to the workspace, and the MCP working directory was the workspace root.

So for a `--plugin-dir` plugin, in a non-interactive session, an MCP server can reach the same state directory and project as the hook. Not established: marketplace installs (the data directory name may differ from `<name>-inline`), interactive sessions, other Claude Code versions, and a project opened from a subdirectory (the workspace was the root). The evidence record is outside the repository; it is not in `experiments/results/`.

### Approved-design integrity check (implemented, tested, dormant in production)

Policy: an APPROVED state whose stored canonical design cannot be verified does not allow implementation. Mechanism: an optional `canonical: true` marker in the schema-2 state (set only by a registration that also stored the design; cleared by any later change), and, for marked APPROVED states, a check on every PreToolUse call that the design file is a regular file reached without following symlinks, within 64 KB, strict UTF-8, passes the full specification validation, and hashes (normalized) to both its file name and the state's `designHash`. Any failure makes the gate behave as INVALID: read-only tools pass, everything else is denied, and `prevue reset` is the recovery. Revision and approval disagreement is rejected by `load()`. Details: `docs/PHASE1C-DESIGN.md`.

Tested (`server/test/gate-integrity.test.ts`, 21 tests, including the real hook process): valid match; missing file or directory; corrupt, empty, non-UTF-8, non-spec and Phase 0 style content; schema- and semantics-invalid designs; a duplicate key; hash mismatch (and whitespace/key-order differences accepted); revision and hash disagreement in the state; symlinked file, symlinked directory, directory and FIFO in place of the file; oversized file; unreadable file; missing, malformed and marker-corrupted state; PENDING unchanged; A -> B -> A without reviving approval; no marker carry-over; re-verification on every call; recovery through reset; no content or path in failure reasons; no writes during verification. Mutation checks confirmed the tests fail when the gate skips verification, when the hash comparison or the file-type check is removed, and when validation errors are ignored.

Not covered: **no state created by any production code path carries the marker yet**, so today's real states are unaffected and this protection is not yet in use; states registered the old way (including the experiment harness's) are not checked; the `O_NOFOLLOW` open is defence in depth against a swap between the `lstat` and the open and has no deterministic test; a same-user process that can write the data directory can remove the marker or rewrite the state, which is outside the threat model. The check was not exercised in a live Claude Code session.

Cost (local, no Claude, Node 26.3.1, macOS, example spec of 1.7 KB): `evaluate()` in process, 3000 iterations after 200 warm-up, median 0.080 ms for an unmarked approved state and 0.150 ms for a marked one (p95 0.09 and 0.17 ms). Hook as a fresh process (what Claude Code runs), 100 runs each after 10 warm-up: median 59.0 ms unmarked and 86.3 ms marked (p95 61.5 and 88.8 ms), i.e. about 27 ms more per guarded tool call, almost all of it loading the schema library. The library is loaded lazily, so unmarked and PENDING states pay nothing: against the pre-change build, 150 interleaved runs gave medians of 59.1 and 59.2 ms. Limits of the measurement: one machine, a small spec, warm file cache, wall-clock including process start, no concurrent load.

### Missing compiled hook: one isolated diagnostic (Claude Code 2.1.311, `claude -p`)

A temporary copy of the plugin (unchanged `hooks/hooks.json`, no `server/`, a different plugin name so its data directory was separate) was loaded in `bypassPermissions` mode and asked to Write one sentinel. The configured PreToolUse command `node ${CLAUDE_PLUGIN_ROOT}/server/dist/src/hook.js` exited with code 1 (`MODULE_NOT_FOUND`). Claude Code reported `failed; blocking because onFailure is "block"`, returned an error for the Write, and the sentinel was not created. The SessionStart and UserPromptSubmit hooks, which have no `onFailure`, also exited 1 and the session continued.

So, for this tested PreToolUse failure, a missing or unbuilt `server/dist` fails **closed**, but it can disrupt ordinary work in any project where Prevue is enabled. For an unbuilt checkout, run `npm run build` from the plugin repository (the `server` directory). This is a single diagnostic on one Claude Code version for one failure mode (missing file); it is not evidence about other hook failures (for example a timeout or a crash inside the hook) or other versions. A read-only tool call was not attempted in it. The diagnostic's output was not added to `experiments/results/`.

## 9. Open items

0. Phase 1c: persist the validated specification and register through a tool, as proposed in `docs/PHASE1C-DESIGN.md`. The gate-side integrity check and the exact-name allowlist are in place; registration, design-file writing, retention/pruning and the preview are not. The integrity check only applies to states carrying the `canonical` marker, which nothing in production sets yet.
1. Obtain an explicit hardened approved-Write control (A1 is INCONCLUSIVE; D0's allow is inferred), and exercise interactive and `auto` mode.
2. Decide the packaging approach (committed bundle vs install step). The missing-`dist` case fails closed for a Write (section 8) but blocks work until the build is run.
3. Measure whether the skill is triggered, and whether self-started turns can forge `prevue approve`.
4. Define how the developer configures extra read-only MCP tools.
5. Real separation between agent and approval channel needs an OS boundary (for example Claude Code's sandbox for shell); a plugin alone cannot provide it.
