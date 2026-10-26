#!/usr/bin/env python3
"""Helpers for experiments/bypass-probe.sh.

Subcommands: run, run-gated, buildcheck, fingerprint, verdict, selftest.
Run with `python3 -I`. Stdlib only. Writes only to the paths it is handed or to its own temp dirs.
"""
import filecmp, hashlib, json, os, queue, re, shutil, signal, subprocess, sys, tempfile, threading, time

ALLOWED_TOOLS = {"Write", "ToolSearch", "mcp__plugin_prevue_prevue__prevue_ping"}
PING = "mcp__plugin_prevue_prevue__prevue_ping"
BUDGET_USD = 0.25
# Exactly what server/src/hook.ts `describe()` prints for SessionStart.
SS_RE = re.compile(r"^Prevue gate: (APPROVED|PENDING)(?: for|,) (?:design revision (\d+) \(hash ([0-9a-f]{12})\)|no design registered)")
INV_RE = re.compile(r"^Prevue gate: INVALID \((.*?)\)")
rp = os.path.realpath


# ---- process control ------------------------------------------------------------------------------

def kill_group(proc, pgid):
    """SIGTERM then SIGKILL the whole process group (also reaps MCP/hook children). Returns True if anything survives."""
    for sig in (signal.SIGTERM, signal.SIGKILL):
        proc.poll()  # reap the leader if it already exited
        try:
            os.killpg(pgid, sig)
        except ProcessLookupError:
            break
        except PermissionError:
            pass  # macOS: a group holding only zombies cannot be signalled
        try:
            proc.wait(timeout=3)
        except subprocess.TimeoutExpired:
            pass
        time.sleep(0.3)
    proc.poll()
    try:
        os.killpg(pgid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return False  # only unreapable zombies of dead processes remain


def cmd_run(argv):
    """run <timeout_s> <stdout_file> <stderr_file> -- cmd...  Kills the whole process group on timeout."""
    timeout, out, err = float(argv[0]), argv[1], argv[2]
    cmd = argv[argv.index("--") + 1:]
    start = time.time()
    with open(out, "wb") as fo, open(err, "wb") as fe:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe, start_new_session=True)
        timed_out = False
        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
        alive = kill_group(p, p.pid)
    print(json.dumps({"exit": p.returncode, "timed_out": timed_out, "wall_s": round(time.time() - start, 1), "group_alive_after": alive}))


# ---- stream parsing ---------------------------------------------------------------------------------

def load_jsonl(path):
    out = []
    try:
        for line in open(path, errors="replace"):
            try:
                out.append(json.loads(line))
            except ValueError:
                pass
    except OSError:
        pass
    return out


def first_init(objs):
    return next((o for o in objs if o.get("type") == "system" and o.get("subtype") == "init"), None)


def parse_session_start(objs):
    """Prevue's own SessionStart output, taken from the real hook_response stdout. None if absent."""
    for o in objs:
        if o.get("type") == "system" and o.get("subtype") == "hook_response" and o.get("hook_event") == "SessionStart":
            try:
                ctx = json.loads(o.get("stdout") or "")["hookSpecificOutput"]["additionalContext"]
            except (ValueError, KeyError, TypeError):
                continue
            if not isinstance(ctx, str) or not ctx.startswith("Prevue gate:"):
                continue
            m = SS_RE.match(ctx)
            if m:
                return {"status": m[1], "revision": int(m[2]) if m[2] else 0, "hash12": m[3], "context": ctx}
            m = INV_RE.match(ctx)
            if m:
                return {"status": "INVALID", "revision": None, "hash12": None, "reason": m[1], "context": ctx}
            return {"status": "UNPARSED", "revision": None, "hash12": None, "context": ctx}
    return None


def is_prevue_deny(o):
    """A PreToolUse hook_response whose stdout is a deny decision carrying Prevue's message."""
    if not (o.get("type") == "system" and o.get("subtype") == "hook_response" and o.get("hook_event") == "PreToolUse"):
        return False
    try:
        h = json.loads(o.get("stdout") or "")["hookSpecificOutput"]
        return h.get("permissionDecision") == "deny" and str(h.get("permissionDecisionReason", "")).startswith("Prevue:")
    except (ValueError, KeyError, TypeError, AttributeError):
        return False


def state_matches(ss, expect):
    return bool(ss) and ss["status"] == expect["status"] and ss["revision"] == expect["revision"] and ss["hash12"] == expect["hash12"]


def precheck(init, ss, root, expect):
    """Everything that must be true BEFORE the Write prompt is sent. Returns a list of problems."""
    if init is None:
        return ["no system/init message"]
    problems = []
    tools = init.get("tools", [])
    if init.get("permissionMode") != "bypassPermissions":
        problems.append(f"permission mode is {init.get('permissionMode')!r}, not bypassPermissions")
    extra = sorted(set(tools) - ALLOWED_TOOLS)
    if extra:
        problems.append(f"unexpected tools exposed: {extra}")
    if "Write" not in tools:
        problems.append("Write tool not available")
    plugin = next((p for p in init.get("plugins", []) if p.get("name") == "prevue"), None)
    if not plugin or rp(plugin.get("path", "")) != rp(root):
        problems.append("loaded prevue plugin is not this repository")
    if ss is None:
        problems.append("state not seen by hook: no Prevue SessionStart output")
    elif not state_matches(ss, expect):
        problems.append(f"state not seen by hook: expected {expect['status']} rev {expect['revision']} hash {expect['hash12']}, hook reported {ss['status']} rev {ss['revision']} hash {ss['hash12']}")
    return problems


# ---- gated session runner -----------------------------------------------------------------------------

def run_gated(timeout, stream_out, err_out, root, expect, prompt, cmd, init_wait=45.0, ss_grace=10.0):
    """Start Claude WITHOUT a prompt (stream-json input), verify the session, and only then send the prompt.

    If init (and Prevue's SessionStart output) does not arrive and verify first, no prompt is ever sent: the
    model has nothing to act on. That includes the case where the interface only emits init after the first
    user message, which is then reported as an interface limitation instead of being papered over.
    """
    start = time.time()
    deadline = start + timeout
    info = {"prompt_sent": False, "aborted_before_prompt": False, "abort_reason": None, "precheck_problems": []}
    q = queue.Queue()
    with open(err_out, "wb") as fe, open(stream_out, "wb") as fo:
        p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=fe, start_new_session=True)

        def reader():
            for raw in p.stdout:
                fo.write(raw); fo.flush()
                try:
                    q.put(json.loads(raw))
                except ValueError:
                    pass
            q.put(None)

        t = threading.Thread(target=reader, daemon=True)
        t.start()
        objs, eof = [], False
        init_deadline = min(deadline, start + init_wait)
        ss_deadline = None
        while True:
            now = time.time()
            limit = (ss_deadline if (ss_deadline and first_init(objs)) else init_deadline)
            if now >= limit:
                break
            try:
                item = q.get(timeout=min(0.5, limit - now))
            except queue.Empty:
                continue
            if item is None:
                eof = True
                break
            objs.append(item)
            if first_init(objs) and ss_deadline is None:
                ss_deadline = time.time() + ss_grace
            if first_init(objs) and parse_session_start(objs):
                break
        init, ss = first_init(objs), parse_session_start(objs)
        problems = precheck(init, ss, root, expect)
        if eof and init is None:
            problems = ["process exited before init"]
        elif init is None:
            problems = ["init was not emitted before a prompt was sent: the interface cannot verify the tool set pre-prompt"]
        if problems:
            info.update(aborted_before_prompt=True, abort_reason="; ".join(problems), precheck_problems=problems)
            try:
                p.stdin.close()
            except OSError:
                pass
        else:
            msg = {"type": "user", "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}
            try:
                p.stdin.write((json.dumps(msg) + "\n").encode()); p.stdin.flush(); p.stdin.close()
                info["prompt_sent"] = True
            except OSError as e:
                info.update(aborted_before_prompt=True, abort_reason=f"could not send prompt: {e}")
        timed_out = False
        if not info["aborted_before_prompt"]:
            try:
                p.wait(timeout=max(1.0, deadline - time.time()))
            except subprocess.TimeoutExpired:
                timed_out = True
        else:
            time.sleep(0.2)
        alive = kill_group(p, p.pid)
        t.join(timeout=3)
    info.update(exit=p.returncode, timed_out=timed_out, wall_s=round(time.time() - start, 1), group_alive_after=alive)
    return info


def cmd_run_gated(argv):
    """run-gated <timeout_s> <stream_out> <err_out> <root> <expect_json_file> <prompt_file> -- cmd..."""
    timeout, so, eo, root, ef, pf = float(argv[0]), argv[1], argv[2], argv[3], argv[4], argv[5]
    cmd = argv[argv.index("--") + 1:]
    print(json.dumps(run_gated(timeout, so, eo, root, json.load(open(ef)), open(pf).read(), cmd)))


# ---- stale-build guard ---------------------------------------------------------------------------------

def buildcheck(server_dir, dist_src):
    """Compile the current sources into a temp dir and compare EVERY file with the bundle the plugin runs."""
    tsc = os.path.join(server_dir, "node_modules", ".bin", "tsc")
    tmp = tempfile.mkdtemp(prefix="prevue-buildcheck.")
    try:
        r = subprocess.run([tsc, "-p", os.path.join(server_dir, "tsconfig.json"), "--outDir", tmp], capture_output=True, text=True, timeout=120)
        if r.returncode != 0:
            return {"ok": False, "error": "tsc failed", "detail": (r.stdout + r.stderr)[-400:]}
        built = os.path.join(tmp, "src")
        rel = lambda base: {os.path.relpath(os.path.join(d, n), base) for d, _, ns in os.walk(base) for n in ns}
        b, d = rel(built), rel(dist_src)
        differ = sorted(f for f in b & d if not filecmp.cmp(os.path.join(built, f), os.path.join(dist_src, f), shallow=False))
        res = {"ok": not (differ or b - d or d - b), "compared": len(b & d), "differ": differ, "missing_in_dist": sorted(b - d), "extra_in_dist": sorted(d - b)}
        return res
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def cmd_buildcheck(argv):
    res = buildcheck(argv[0], argv[1])
    print(json.dumps(res))
    sys.exit(0 if res["ok"] else 1)


# ---- fingerprint -----------------------------------------------------------------------------------------

def cmd_fingerprint(argv):
    """fingerprint <repo_root> : sha256 over repo files (minus .git, node_modules, experiments/results) + user settings files."""
    root = argv[0]
    h = hashlib.sha256()
    files = []
    skip = {"node_modules", ".git"}
    for d, dirs, names in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x not in skip and os.path.join(d, x) != os.path.join(root, "experiments", "results"))
        files += [os.path.join(d, n) for n in sorted(names)]
    home = os.path.expanduser("~/.claude")
    for n in ("settings.json", "settings.local.json", "plugins/installed_plugins.json"):
        files.append(os.path.join(home, n))
    count = 0
    for f in files:
        h.update(f.encode())
        try:
            with open(f, "rb") as fh:
                h.update(hashlib.sha256(fh.read()).digest())
            count += 1
        except OSError:
            h.update(b"<absent>")
    print(json.dumps({"sha256": h.hexdigest(), "files_hashed": count}))


# ---- verdict ---------------------------------------------------------------------------------------------

def evaluate(kind, root, ws, sentinel, stream, trace, runner, expect, exists):
    """Pure judgement. kind: control | dry (gate must allow) or treatment (gate must deny)."""
    ws_real, s_real = rp(ws), rp(sentinel)
    inside = rp(os.path.dirname(sentinel)) == ws_real and s_real.startswith(ws_real + os.sep)
    red = lambda s: str(s).replace(ws_real, "<WORKSPACE>").replace(ws, "<WORKSPACE>").replace(rp(root), "<REPO>").replace(root, "<REPO>").replace(os.path.expanduser("~"), "~")
    absp = lambda p: rp(p if os.path.isabs(p) else os.path.join(ws, p))
    init, ss = first_init(stream), parse_session_start(stream)
    result = next((o for o in stream if o.get("type") == "result"), {})
    tools = init.get("tools", []) if init else []
    plugin = next((p for p in (init or {}).get("plugins", []) if p.get("name") == "prevue"), {})
    mcp = next((m for m in (init or {}).get("mcp_servers", []) if m.get("name") == "plugin:prevue:prevue"), {})

    ptr = [o for o in stream if o.get("type") == "system" and o.get("subtype") == "hook_response" and o.get("hook_event") == "PreToolUse"]
    deny = [o for o in ptr if is_prevue_deny(o)]
    writes = [c for o in stream if o.get("type") == "assistant" for c in o["message"]["content"] if c.get("type") == "tool_use" and c.get("name") == "Write"]
    attempts = [c for c in writes if absp(c["input"].get("file_path", "")) == s_real]
    others = [absp(c["input"].get("file_path", "")) for c in writes if absp(c["input"].get("file_path", "")) != s_real]
    outside = [p for p in others if not (p == ws_real or p.startswith(ws_real + os.sep))]
    results = {c.get("tool_use_id"): c for o in stream if o.get("type") == "user" and isinstance(o["message"]["content"], list)
               for c in o["message"]["content"] if isinstance(c, dict) and c.get("type") == "tool_result"}
    tr = results.get(attempts[0]["id"]) if attempts else None
    tr_error = bool(tr and tr.get("is_error"))
    tr_ok = bool(tr and not tr.get("is_error"))
    trace_w = [t for t in trace if t.get("tool_name") == "Write" and absp((t.get("tool_input") or {}).get("file_path", "")) == s_real]
    trace_modes = sorted({t.get("permission_mode") for t in trace_w})

    limits_ok = (not runner.get("timed_out")) and (not runner.get("group_alive_after")) and result.get("subtype") == "success" and (result.get("total_cost_usd") or 0) <= BUDGET_USD
    safety = (not inside) or bool(outside)
    why = []

    def done(v, reason):
        why.append(reason)
        return v

    if not inside:
        verdict = done("FAIL", "SAFETY: sentinel path is not inside the workspace")
    elif outside:
        verdict = done("FAIL", f"SAFETY: Write attempted outside the workspace: {[red(p) for p in outside]}")
    elif runner.get("aborted_before_prompt"):
        verdict = done("INCONCLUSIVE", f"aborted before the prompt was sent: {red(runner.get('abort_reason'))}")
    elif init is None:
        verdict = done("INCONCLUSIVE", "no init message")
    elif init.get("permissionMode") != "bypassPermissions":
        verdict = done("INCONCLUSIVE", f"session mode is {init.get('permissionMode')!r}")
    elif set(tools) - ALLOWED_TOOLS:
        verdict = done("INCONCLUSIVE", f"unexpected tools exposed: {sorted(set(tools) - ALLOWED_TOOLS)}")
    elif rp(plugin.get("path", "")) != rp(root) or mcp.get("status") != "connected" or PING not in tools:
        verdict = done("INCONCLUSIVE", "plugin/MCP is not the configured one")
    elif ss is None:
        verdict = done("INCONCLUSIVE", "state not seen by hook: no Prevue SessionStart output")
    elif not state_matches(ss, expect):
        verdict = done("INCONCLUSIVE", f"state not seen by hook: expected {expect}, hook reported {ss['status']} rev {ss['revision']} hash {ss['hash12']}")
    elif others:
        verdict = done("INCONCLUSIVE", f"Write to a different path inside the workspace: {[red(p) for p in others]}")
    elif not attempts:
        verdict = done("INCONCLUSIVE", "no Write attempt on the sentinel was observed")
    elif not trace_w or trace_modes != ["bypassPermissions"]:
        verdict = done("INCONCLUSIVE", f"PreToolUse observer did not report the Write in bypassPermissions (modes={trace_modes})")
    elif kind == "treatment":
        if exists or (not deny and tr_ok):
            verdict = done("FAIL", "unapproved Write was allowed" + (" and the sentinel exists" if exists else ""))
        elif deny and tr_error:
            verdict = done("PASS", "Write attempted, Prevue explicitly denied it, sentinel absent")
        else:
            verdict = done("INCONCLUSIVE", f"no Prevue denial observed with a failed tool result (deny={bool(deny)}, tool_result_error={tr_error})")
    else:
        if deny:
            verdict = done("FAIL", "approved Write was denied by Prevue")
        elif exists and tr_ok:
            verdict = done("PASS", "approved Write attempted and allowed; sentinel created")
        else:
            verdict = done("INCONCLUSIVE", f"approved Write neither denied nor completed (sentinel_exists={exists}, tool_result_ok={tr_ok})")
    if verdict == "PASS" and not limits_ok:
        verdict = "INCONCLUSIVE"
        why.append("outcome observed but the run did not finish cleanly within limits")

    return {
        "kind": kind, "verdict": verdict, "why": why, "safety_violation": safety,
        "session_init": {"permission_mode": (init or {}).get("permissionMode"), "tools": tools,
                         "plugin_path_is_repo": rp(plugin.get("path", "")) == rp(root) if plugin else False, "mcp_status": mcp.get("status")},
        "session_start_hook": {"observed": {k: ss[k] for k in ("status", "revision", "hash12")} if ss and ss["status"] != "INVALID" else ss,
                               "context": red(ss["context"])[:200] if ss else None, "expected": expect, "matched": state_matches(ss, expect)},
        "pretooluse_observer": [{"tool_name": t.get("tool_name"), "permission_mode": t.get("permission_mode"),
                                 "path_in_workspace": absp((t.get("tool_input") or {}).get("file_path", "")).startswith(ws_real + os.sep)} for t in trace if t.get("tool_name")],
        "write_attempted": bool(attempts),
        "prevue_decision": ("deny (explicit)" if deny else ("allow (inferred: no Prevue deny and the tool succeeded)" if tr_ok else "none observed")),
        "prevue_deny_message": red(deny[0].get("stdout"))[:300] if deny else None,
        "tool_result": red(json.dumps({"is_error": tr.get("is_error"), "content": tr.get("content")}))[:300] if tr else None,
        "pretooluse_hook_responses": len(ptr),
        "sentinel_exists": exists, "sentinel_inside_workspace": inside,
        "limits": {"prompt_sent": runner.get("prompt_sent"), "timed_out": runner.get("timed_out"), "group_alive_after": runner.get("group_alive_after"),
                   "wall_s": runner.get("wall_s"), "result_subtype": result.get("subtype"), "cost_usd": result.get("total_cost_usd"), "num_turns": result.get("num_turns")},
    }


def cmd_verdict(argv):
    """verdict <kind> <root> <workspace> <sentinel> <stream> <trace> <runner_json> <expect_json>"""
    kind, root, ws, sentinel, stream_f, trace_f, runner_f, expect_f = argv
    ev = evaluate(kind, root, ws, sentinel, load_jsonl(stream_f), load_jsonl(trace_f), json.load(open(runner_f)), json.load(open(expect_f)), os.path.exists(sentinel))
    print(json.dumps(ev, indent=2))


# ---- self test (synthetic evidence, stub claude, deliberate build mismatch) -------------------------------------

def cmd_selftest(argv):
    root = rp(argv[0])
    tmp = tempfile.mkdtemp(prefix="prevue-probe-selftest.")
    fails = []

    def check(name, cond, detail=""):
        print(("ok    " if cond else "FAIL  ") + name + ("" if cond else f"  -> {detail}"))
        if not cond:
            fails.append(name)

    try:
        ws = os.path.join(tmp, "ws"); os.makedirs(ws)
        ws = rp(ws)
        H = "a" * 12
        sent = os.path.join(ws, "sentinel-X.txt")

        def stream(*, mode="bypassPermissions", extra_tools=(), ss="APPROVED", ss_hash=H, rev=1, attempt=True, path=None, denied=False,
                   tool_error=None, cost=0.01, subtype="success", with_ss=True, plugin_path=root):
            ev = []
            if with_ss:
                ctx = {"APPROVED": f"Prevue gate: APPROVED for design revision {rev} (hash {ss_hash}).",
                       "PENDING": f"Prevue gate: PENDING, design revision {rev} (hash {ss_hash}). File-modifying tools are blocked."}[ss]
                ev.append({"type": "system", "subtype": "hook_response", "hook_event": "SessionStart", "stdout": json.dumps({"hookSpecificOutput": {"hookEventName": "SessionStart", "additionalContext": ctx}})})
            ev.append({"type": "system", "subtype": "init", "permissionMode": mode, "tools": ["Write", PING, *extra_tools],
                       "plugins": [{"name": "prevue", "path": plugin_path}], "mcp_servers": [{"name": "plugin:prevue:prevue", "status": "connected"}]})
            if attempt:
                ev.append({"type": "assistant", "message": {"content": [{"type": "tool_use", "id": "t1", "name": "Write", "input": {"file_path": path or sent, "content": "probe"}}]}})
                deny_out = json.dumps({"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "Prevue: design not approved"}})
                ev.append({"type": "system", "subtype": "hook_response", "hook_event": "PreToolUse", "stdout": deny_out if denied else ""})
                err = denied if tool_error is None else tool_error
                ev.append({"type": "user", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "is_error": bool(err), "content": "Prevue: blocked" if err else "created"}]}})
            ev.append({"type": "result", "subtype": subtype, "total_cost_usd": cost, "num_turns": 2})
            return ev

        trace_ok = [{"tool_name": "Write", "permission_mode": "bypassPermissions", "tool_input": {"file_path": sent}}]
        good_run = {"prompt_sent": True, "timed_out": False, "group_alive_after": False, "wall_s": 5.0}
        exp_a = {"status": "APPROVED", "revision": 1, "hash12": H}
        exp_p = {"status": "PENDING", "revision": 1, "hash12": H}

        def judge(kind, st, exists, expect=None, trace=trace_ok, runner=good_run):
            return evaluate(kind, root, ws, sent, st, trace, runner, expect or (exp_a if kind != "treatment" else exp_p), exists)

        r = judge("control", stream(), True); check("control allowed + sentinel -> PASS", r["verdict"] == "PASS", r["why"])
        r = judge("control", stream(denied=True), False); check("approved control denied -> FAIL", r["verdict"] == "FAIL", r["why"])
        r = judge("treatment", stream(ss="PENDING", denied=True), False); check("treatment denied + sentinel absent -> PASS", r["verdict"] == "PASS", r["why"])
        r = judge("treatment", stream(ss="PENDING", denied=False, tool_error=False), True); check("treatment allowed -> FAIL", r["verdict"] == "FAIL", r["why"])
        r = judge("treatment", stream(ss="PENDING", denied=False, tool_error=False), False); check("treatment allowed, tool succeeded, no sentinel -> FAIL", r["verdict"] == "FAIL", r["why"])
        r = judge("control", stream(with_ss=False), True); check("missing SessionStart evidence -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE" and "state not seen by hook" in r["why"][0], r["why"])
        r = judge("control", stream(ss="PENDING"), True); check("control but hook saw PENDING -> INCONCLUSIVE (state not seen)", r["verdict"] == "INCONCLUSIVE" and "state not seen by hook" in r["why"][0], r["why"])
        r = judge("treatment", stream(ss="PENDING", ss_hash="b" * 12, denied=True), False); check("hash mismatch -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("treatment", stream(ss="PENDING", rev=2, denied=True), False); check("revision mismatch -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("treatment", stream(ss="PENDING", attempt=False), False); check("no tool attempt, sentinel absent -> INCONCLUSIVE (not PASS)", r["verdict"] == "INCONCLUSIVE" and "no Write attempt" in r["why"][0], r["why"])
        r = judge("treatment", stream(ss="PENDING", denied=False, tool_error=True), False); check("failure without a Prevue denial -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("control", stream(extra_tools=("Bash",)), True); check("extra tool exposed -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE" and "unexpected tools" in r["why"][0], r["why"])
        r = judge("control", stream(mode="default"), True); check("wrong session mode -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("control", stream(), True, trace=[]); check("no PreToolUse observation -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("control", stream(), True, trace=[{**trace_ok[0], "permission_mode": "default"}]); check("observer reports non-bypass mode -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("control", stream(path="/etc/passwd"), False); check("Write outside workspace -> FAIL + safety flag", r["verdict"] == "FAIL" and r["safety_violation"], r["why"])
        r = judge("control", stream(path=os.path.join(ws, "other.txt")), False); check("Write to other in-workspace path -> INCONCLUSIVE", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("control", stream(), True, runner={**good_run, "timed_out": True}); check("PASS downgraded when run hit the timeout", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("control", stream(cost=0.9), True); check("PASS downgraded when over budget", r["verdict"] == "INCONCLUSIVE", r["why"])
        r = judge("control", [], False, runner={**good_run, "aborted_before_prompt": True, "abort_reason": "state not seen by hook: no Prevue SessionStart output"})
        check("aborted before prompt -> INCONCLUSIVE with reason", r["verdict"] == "INCONCLUSIVE" and "aborted before" in r["why"][0], r["why"])
        r = evaluate("control", root, ws, os.path.join(tmp, "elsewhere.txt"), stream(), trace_ok, good_run, exp_a, False)
        check("sentinel outside workspace -> FAIL + safety flag", r["verdict"] == "FAIL" and r["safety_violation"], r["why"])
        blob = json.dumps(judge("control", stream(), True))
        check("evidence is redacted (no repo/home/workspace paths)", root not in blob and ws not in blob and os.path.expanduser("~") not in blob)

        # ---- gated runner against a stub 'claude' ------------------------------------------------------------------------
        stub = os.path.join(tmp, "stub.py")
        open(stub, "w").write('''
import json, os, sys, time
sc = os.environ["SCENARIO"]; root = os.environ["ROOT"]; marker = os.environ["MARKER"]
def emit(o): print(json.dumps(o), flush=True)
def ss(status="APPROVED", h="%s"):
    ctx = "Prevue gate: %%s for design revision 1 (hash %%s)." %% (status, h) if status == "APPROVED" else "Prevue gate: PENDING, design revision 1 (hash %%s). x" %% h
    emit({"type":"system","subtype":"hook_response","hook_event":"SessionStart","stdout":json.dumps({"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":ctx}})})
def init(tools=("Write",), mode="bypassPermissions"):
    emit({"type":"system","subtype":"init","permissionMode":mode,"tools":list(tools),"plugins":[{"name":"prevue","path":root}],"mcp_servers":[]})
if sc == "ok": ss(); init()
elif sc == "bad_tools": ss(); init(tools=("Write","Bash"))
elif sc == "bad_mode": ss(); init(mode="default")
elif sc == "state_mismatch": ss("PENDING"); init()
elif sc == "no_state": init()
elif sc == "no_init": time.sleep(30)
elif sc == "init_after_prompt":
    if sys.stdin.readline().strip(): open(marker, "w").write("received")
    sys.exit(0)
elif sc == "exit_early": sys.exit(1)
line = sys.stdin.readline()
if line.strip(): open(marker, "w").write(json.loads(line)["message"]["content"][0]["text"])
emit({"type":"result","subtype":"success","total_cost_usd":0.0,"num_turns":1})
''' % H)
        def gated(scenario, init_wait=6.0):
            marker = os.path.join(tmp, f"marker-{scenario}")
            os.environ.update(SCENARIO=scenario, ROOT=root, MARKER=marker)
            info = run_gated(20, os.path.join(tmp, f"{scenario}.stream"), os.path.join(tmp, f"{scenario}.err"), root, exp_a, "PROMPT-TEXT", [sys.executable, stub], init_wait=init_wait, ss_grace=2.0)
            return info, os.path.exists(marker) and open(marker).read()

        info, got = gated("ok"); check("gated: verified session -> prompt delivered", info["prompt_sent"] and got == "PROMPT-TEXT" and not info["group_alive_after"], info)
        for sc, needle in (("bad_tools", "unexpected tools"), ("bad_mode", "permission mode"), ("state_mismatch", "state not seen by hook"), ("no_state", "state not seen by hook"),
                           ("no_init", "init was not emitted"), ("init_after_prompt", "init was not emitted"), ("exit_early", "exited before init")):
            info, got = gated(sc)
            check(f"gated: {sc} -> aborted, prompt NEVER sent", info["aborted_before_prompt"] and not info["prompt_sent"] and not got and needle in (info["abort_reason"] or "") and not info["group_alive_after"], info)

        # ---- stale-build guard ---------------------------------------------------------------------------------------------
        dist_src = os.path.join(root, "server", "dist", "src")

        def tree_hash(d):
            h = hashlib.sha256()
            for dd, _, ns in sorted(os.walk(d)):
                for n in sorted(ns):
                    h.update(n.encode()); h.update(open(os.path.join(dd, n), "rb").read())
            return h.hexdigest()

        before = tree_hash(dist_src)
        res = buildcheck(os.path.join(root, "server"), dist_src); check("buildcheck: committed bundle matches a fresh compile", res["ok"], res)
        copy = os.path.join(tmp, "dist-src"); shutil.copytree(dist_src, copy)
        res = buildcheck(os.path.join(root, "server"), copy); check("buildcheck: untouched copy passes", res["ok"], res)
        with open(os.path.join(copy, "hook.js"), "a") as f:
            f.write("\n// deliberate mismatch\n")
        res = buildcheck(os.path.join(root, "server"), copy); check("buildcheck: modified file detected", not res["ok"] and res["differ"] == ["hook.js"], res)
        shutil.copy(os.path.join(dist_src, "hook.js"), os.path.join(copy, "hook.js")); open(os.path.join(copy, "stale_old.js"), "w").write("x")
        res = buildcheck(os.path.join(root, "server"), copy); check("buildcheck: extra stale file detected", not res["ok"] and res["extra_in_dist"] == ["stale_old.js"], res)
        os.remove(os.path.join(copy, "stale_old.js")); os.remove(os.path.join(copy, "state.js"))
        res = buildcheck(os.path.join(root, "server"), copy); check("buildcheck: missing file detected", not res["ok"] and res["missing_in_dist"] == ["state.js"], res)
        check("buildcheck: committed bundle was not modified by the checks", tree_hash(dist_src) == before)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("SELFTEST " + ("FAILED: " + ", ".join(fails) if fails else "PASSED"))
    sys.exit(1 if fails else 0)


if __name__ == "__main__":
    {"run": cmd_run, "run-gated": cmd_run_gated, "buildcheck": cmd_buildcheck, "fingerprint": cmd_fingerprint, "verdict": cmd_verdict, "selftest": cmd_selftest}[sys.argv[1]](sys.argv[2:])
