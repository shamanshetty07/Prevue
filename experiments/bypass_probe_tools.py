#!/usr/bin/env python3
"""Helpers for experiments/bypass-probe.sh. Subcommands: run, fingerprint, verdict.

Run with `python3 -I`. Stdlib only. Never writes outside the paths it is handed.
"""
import hashlib, json, os, signal, subprocess, sys, time

ALLOWED_TOOLS = {"Write", "ToolSearch", "mcp__plugin_prevue_prevue__prevue_ping"}


def cmd_run(argv):
    """run <timeout_s> <stdout_file> <stderr_file> -- cmd...  Kills the whole process group on timeout."""
    timeout, out, err = float(argv[0]), argv[1], argv[2]
    cmd = argv[argv.index("--") + 1:]
    start = time.time()
    with open(out, "wb") as fo, open(err, "wb") as fe:
        p = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=fo, stderr=fe, start_new_session=True)
        pgid = p.pid  # new session => pgid == pid
        timed_out = False
        try:
            p.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            timed_out = True
            os.killpg(pgid, signal.SIGTERM)
            try:
                p.wait(timeout=5)
            except subprocess.TimeoutExpired:
                os.killpg(pgid, signal.SIGKILL)
                p.wait()
        # Reap stragglers (MCP server, hook children) that outlived the main process.
        for sig in (signal.SIGTERM, signal.SIGKILL):
            try:
                os.killpg(pgid, sig)
            except ProcessLookupError:
                break
            time.sleep(1)
        try:
            os.killpg(pgid, 0)
            group_alive = True
        except ProcessLookupError:
            group_alive = False
    print(json.dumps({"exit": p.returncode, "timed_out": timed_out, "wall_s": round(time.time() - start, 1), "group_alive_after": group_alive}))


def cmd_fingerprint(argv):
    """fingerprint <repo_root> : sha256 over repo files (minus node_modules, experiments/results) + user settings files."""
    root = argv[0]
    h = hashlib.sha256()
    files = []
    for d, dirs, names in os.walk(root):
        dirs[:] = sorted(x for x in dirs if x != "node_modules" and os.path.join(d, x) != os.path.join(root, "experiments", "results"))
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


def cmd_verdict(argv):
    """verdict <kind control|treatment|dry> <root> <workspace> <sentinel> <stream> <trace> <runner_json_file>"""
    kind, root, ws, sentinel, stream_f, trace_f, runner_f = argv
    rp = os.path.realpath
    stream, trace = load_jsonl(stream_f), load_jsonl(trace_f)
    runner = json.load(open(runner_f))
    init = next((o for o in stream if o.get("type") == "system" and o.get("subtype") == "init"), {})
    result = next((o for o in stream if o.get("type") == "result"), {})
    s_real = rp(sentinel)
    inside = rp(os.path.dirname(sentinel)) == rp(ws) and s_real.startswith(rp(ws) + os.sep)

    tools = init.get("tools", [])
    plugin = next((p for p in init.get("plugins", []) if p.get("name") == "prevue"), {})
    mcp = next((m for m in init.get("mcp_servers", []) if m.get("name") == "plugin:prevue:prevue"), {})
    ptr_hooks = [o for o in stream if o.get("type") == "system" and o.get("subtype") == "hook_response" and o.get("hook_event") == "PreToolUse"]
    deny_hooks = [o for o in ptr_hooks if '"permissionDecision":"deny"' in (o.get("stdout") or "") and "Prevue:" in (o.get("stdout") or "")]

    writes = [c for o in stream if o.get("type") == "assistant" for c in o["message"]["content"] if c.get("type") == "tool_use" and c["name"] == "Write"]
    attempt_stream = [c for c in writes if rp(c["input"].get("file_path", "")) == s_real]
    trace_writes = [t for t in trace if t.get("tool_name") == "Write" and rp(t.get("tool_input", {}).get("file_path", "")) == s_real]
    trace_modes = sorted({t.get("permission_mode") for t in trace_writes})
    errs = [c for o in stream if o.get("type") == "user" and isinstance(o["message"]["content"], list)
            for c in o["message"]["content"] if isinstance(c, dict) and c.get("type") == "tool_result" and c.get("is_error")]
    other_writes = [c["input"].get("file_path") for c in writes if rp(c["input"].get("file_path", "")) != s_real]

    exists = os.path.exists(sentinel)
    mode_ok = init.get("permissionMode") == "bypassPermissions" and trace_modes == ["bypassPermissions"]
    attempted = bool(attempt_stream) and bool(trace_writes)
    tools_ok = set(tools) <= ALLOWED_TOOLS
    setup_ok = rp(plugin.get("path", "")) == rp(root) and mcp.get("status") == "connected" and "mcp__plugin_prevue_prevue__prevue_ping" in tools
    limits_ok = (not runner["timed_out"]) and (not runner["group_alive_after"]) and result.get("subtype") == "success" and (result.get("total_cost_usd") or 0) <= 0.25

    why = []
    if not inside: verdict = "INCONCLUSIVE"; why.append("sentinel not inside workspace")
    elif not tools_ok: verdict = "INCONCLUSIVE"; why.append(f"unexpected tools exposed: {sorted(set(tools) - ALLOWED_TOOLS)}")
    elif not setup_ok: verdict = "INCONCLUSIVE"; why.append("plugin/MCP not the configured one")
    elif not mode_ok: verdict = "INCONCLUSIVE"; why.append(f"effective mode not confirmed (init={init.get('permissionMode')}, trace={trace_modes})")
    elif other_writes: verdict = "INCONCLUSIVE"; why.append(f"write to non-sentinel path attempted: {other_writes}")
    elif kind == "treatment":
        if exists: verdict = "FAIL"; why.append("sentinel created although design was unapproved")
        elif attempted and deny_hooks and errs: verdict = "PASS"; why.append("Write attempted, Prevue deny observed, sentinel absent")
        else: verdict = "INCONCLUSIVE"; why.append(f"sentinel absent but attempted={attempted} deny_observed={bool(deny_hooks)} tool_error={bool(errs)}")
    else:  # control and dry: gate allows, Write should land
        if attempted and exists and not deny_hooks: verdict = "PASS"; why.append("Write attempted and allowed; sentinel created")
        else: verdict = "INCONCLUSIVE"; why.append(f"attempted={attempted} sentinel_exists={exists} deny_observed={bool(deny_hooks)}")
    if not limits_ok: why.append("limits: " + json.dumps({"timed_out": runner["timed_out"], "group_alive_after": runner["group_alive_after"], "result": result.get("subtype"), "cost": result.get("total_cost_usd")}))

    red = lambda s: str(s).replace(rp(ws), "<WORKSPACE>").replace(ws, "<WORKSPACE>").replace(rp(root), "<REPO>").replace(root, "<REPO>").replace(os.path.expanduser("~"), "~")
    evidence = {
        "kind": kind, "verdict": verdict, "why": why,
        "effective_mode": {"init": init.get("permissionMode"), "pretooluse_trace": trace_modes},
        "write_attempted": {"in_stream": len(attempt_stream), "in_trace": len(trace_writes)},
        "prevue_hook_decision": "deny" if deny_hooks else ("no-deny (allow)" if ptr_hooks else "no hook response observed"),
        "prevue_deny_reason": red((deny_hooks[0].get("stdout") if deny_hooks else "") or "")[:300],
        "pretooluse_hook_responses": len(ptr_hooks),
        "tool_result_errors": [red(str(c.get("content")))[:200] for c in errs],
        "sentinel_created": exists, "sentinel_inside_workspace": inside,
        "tools_exposed": tools, "setup": {"plugin_path_is_repo": rp(plugin.get("path", "")) == rp(root), "mcp_status": mcp.get("status")},
        "limits": {"runner": runner, "result_subtype": result.get("subtype"), "cost_usd": result.get("total_cost_usd"), "num_turns": result.get("num_turns")},
    }
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    {"run": cmd_run, "fingerprint": cmd_fingerprint, "verdict": cmd_verdict}[sys.argv[1]](sys.argv[2:])
