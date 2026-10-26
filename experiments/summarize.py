#!/usr/bin/env python3
"""Summarize a `claude -p --output-format stream-json --verbose` log: init info, tool calls, tool results, hook events."""
import json, sys

for line in open(sys.argv[1]):
    try:
        o = json.loads(line)
    except ValueError:
        continue
    t = o.get("type")
    if t == "system" and o.get("subtype") == "init":
        print("INIT plugins:", o.get("plugins"))
        print("INIT mcp_servers:", o.get("mcp_servers"))
        print("INIT prevue tools:", [x for x in o.get("tools", []) if "prevue" in x.lower()])
        print("INIT permissionMode:", o.get("permissionMode"))
    elif t == "system" and "hook" in str(o.get("subtype")):
        if o.get("subtype") == "hook_response":
            print("HOOK", o.get("hook_event"), "outcome=", o.get("outcome"), "exit=", o.get("exit_code"), "stdout=", (o.get("stdout") or "")[:200], "stderr=", (o.get("stderr") or "")[:200])
    elif t == "assistant":
        for c in o["message"]["content"]:
            if c["type"] == "tool_use":
                print("TOOL_USE", c["name"], json.dumps(c["input"])[:200], "(subagent)" if o.get("parent_tool_use_id") else "")
            elif c["type"] == "text":
                print("TEXT", c["text"][:300].replace("\n", " "))
    elif t == "user":
        content = o["message"]["content"]
        for c in content if isinstance(content, list) else []:
            if isinstance(c, dict) and c.get("type") == "tool_result":
                print("RESULT", "ERR" if c.get("is_error") else "ok", str(c["content"])[:300].replace("\n", " "), "(subagent)" if o.get("parent_tool_use_id") else "")
    elif t == "result":
        print("DONE", o.get("subtype"), "turns=", o.get("num_turns"), "denials=", json.dumps(o.get("permission_denials"))[:300])
