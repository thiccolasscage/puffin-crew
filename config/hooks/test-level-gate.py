#!/usr/bin/env python3
"""Feeds fake tool calls to level_gate.py and checks allow or deny per level.
Run: python3 config/hooks/test-level-gate.py  (uses a temp xp.json, never the real one)
"""
import json, os, pathlib, shutil, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent

cases = [
    # name, xp, tool, input, expected ("allow" or "deny")
    ["L1 Read", 0, "Read", {"file_path": "crew/levels.md"}, "allow"],
    ["L1 Bash", 0, "Bash", {"command": "python3 crew/xp.py show"}, "allow"],
    ["L1 Ledger query", 0, "ArtifactData", {"action": "query", "collection": "tasks"}, "allow"],
    ["L1 Ledger get", 0, "ArtifactData", {"action": "get", "collection": "tasks", "doc_id": "x"}, "allow"],
    ["L1 Ledger list", 0, "ArtifactData", {"action": "list", "collection": "tasks"}, "allow"],
    ["L1 Ledger set", 0, "ArtifactData", {"action": "set", "collection": "stretches", "doc_id": "x"}, "deny"],
    ["L1 Ledger update", 0, "ArtifactData", {"action": "update", "collection": "stretches", "doc_id": "x"}, "deny"],
    ["L1 Ledger batch", 0, "ArtifactData", {"action": "batch"}, "deny"],
    ["L1 Ledger no action", 0, "ArtifactData", {}, "deny"],
    ["L5 Ledger set", 400, "ArtifactData", {"action": "set", "collection": "stretches", "doc_id": "x"}, "allow"],
    ["L1 Edit paper.md", 0, "Edit", {"file_path": "/repo/crew/paper.md"}, "allow"],
    ["L1 Write paper.md", 0, "Write", {"file_path": "/repo/crew/paper.md"}, "allow"],
    ["L1 Edit fake paper.md", 0, "Edit", {"file_path": "/repo/crew/paper.md.bak"}, "deny"],
    ["L1 Edit own memory", 0, "Edit", {"file_path": "/repo/crew/ledge/memory.md"}, "deny"],
    ["L2 Edit own memory", 100, "Edit", {"file_path": "/repo/crew/ledge/memory.md"}, "allow"],
    ["L2 Edit other bot memory", 100, "Edit", {"file_path": "/repo/crew/other/memory.md"}, "deny"],
    ["L2 Edit levels.md", 100, "Edit", {"file_path": "/repo/crew/levels.md"}, "deny"],
    ["L1 WebSearch", 0, "WebSearch", {"query": "x"}, "deny"],
    ["L3 WebSearch", 200, "WebSearch", {"query": "x"}, "allow"],
    ["L4 Edit levels.md", 300, "Edit", {"file_path": "/repo/crew/levels.md"}, "allow"],
    # Files no bot may change at any level
    ["L8 Edit xp.json", 700, "Edit", {"file_path": "/repo/crew/xp.json"}, "deny"],
    ["L8 Write level_gate.py", 700, "Write", {"file_path": "/repo/config/hooks/level_gate.py"}, "deny"],
    ["L8 Edit settings.json", 700, "Edit", {"file_path": "/repo/.claude/settings.json"}, "deny"],
    ["L8 Write ACTIVE", 700, "Write", {"file_path": "/repo/crew/ACTIVE"}, "deny"],
    # Shell below level 4: the run routine's own commands
    ["L1 git pull", 0, "Bash", {"command": "git pull origin main"}, "allow"],
    ["L1 cd && git status", 0, "Bash", {"command": "cd /repo && git status --short"}, "allow"],
    ["L1 xp show", 0, "Bash", {"command": "python3 crew/xp.py show"}, "allow"],
    ["L1 xp level", 0, "Bash", {"command": "python3 crew/xp.py level ledge"}, "allow"],
    ["L1 xp award own run", 0, "Bash", {"command": "python3 /repo/crew/xp.py award ledge run"}, "allow"],
    ["L1 git add+commit+push", 0, "Bash", {"command": 'git add crew/xp.json crew/paper.md && git commit -m "Ledge run 2026-10-30; ok" && git push origin main'}, "allow"],
    ["L1 cat 2>/dev/null | head", 0, "Bash", {"command": "cat crew/paper.md 2>/dev/null | head -20"}, "allow"],
    ["L1 git log 2>&1", 0, "Bash", {"command": "git log --oneline -3 2>&1"}, "allow"],
    ["L1 date", 0, "Bash", {"command": "date +%Y-%m-%d"}, "allow"],
    # Shell below level 4: bypass attempts
    ["L1 xp award good", 0, "Bash", {"command": "python3 crew/xp.py award ledge good"}, "deny"],
    ["L1 xp award other bot", 0, "Bash", {"command": "python3 crew/xp.py award other run"}, "deny"],
    ["L1 xp unpark", 0, "Bash", {"command": "python3 crew/xp.py unpark ledge"}, "deny"],
    ["L1 append paper via shell", 0, "Bash", {"command": "cat >> crew/paper.md <<EOF\nhi\nEOF"}, "deny"],
    ["L1 echo > file", 0, "Bash", {"command": "echo hi > notes.md"}, "deny"],
    ["L1 newline then rm", 0, "Bash", {"command": "ls\nrm notes.md"}, "deny"],
    ["L1 ; rm", 0, "Bash", {"command": "ls; rm notes.md"}, "deny"],
    ["L1 $(rm)", 0, "Bash", {"command": "echo $(rm notes.md)"}, "deny"],
    ["L1 $() in commit msg", 0, "Bash", {"command": 'git commit -m "$(rm notes.md)"'}, "deny"],
    ["L1 backticks", 0, "Bash", {"command": "echo `rm notes.md`"}, "deny"],
    ["L1 subshell", 0, "Bash", {"command": "(rm notes.md)"}, "deny"],
    ["L1 curl", 0, "Bash", {"command": "curl https://example.com"}, "deny"],
    ["L1 python -c", 0, "Bash", {"command": "python3 -c 'print(1)'"}, "deny"],
    ["L1 sed -i", 0, "Bash", {"command": "sed -i s/a/b/ crew/levels.md"}, "deny"],
    ["L1 find -delete", 0, "Bash", {"command": "find . -name x -delete"}, "deny"],
    ["L1 git push --force", 0, "Bash", {"command": "git push --force origin main"}, "deny"],
    ["L1 git push +main", 0, "Bash", {"command": "git push origin +main"}, "deny"],
    ["L1 git reset --hard", 0, "Bash", {"command": "git reset --hard HEAD~1"}, "deny"],
    ["L1 git branch -D", 0, "Bash", {"command": "git branch -D old"}, "deny"],
    ["L1 git -C x clean", 0, "Bash", {"command": "git -C /repo clean -fd"}, "deny"],
    ["L1 unclosed quote", 0, "Bash", {"command": "echo 'oops"}, "deny"],
    # Shell at level 4+: full shell, but still no deletes or self-promotion
    ["L4 curl", 300, "Bash", {"command": "curl https://example.com"}, "allow"],
    ["L4 sed -i levels.md", 300, "Bash", {"command": "sed -i s/a/b/ crew/levels.md"}, "allow"],
    ["L4 echo > notes", 300, "Bash", {"command": "echo hi > notes.md"}, "allow"],
    ["L4 rm", 300, "Bash", {"command": "rm notes.md"}, "deny"],
    ["L4 sudo rm", 300, "Bash", {"command": "sudo rm notes.md"}, "deny"],
    ["L4 xargs rm", 300, "Bash", {"command": "find . -name x | xargs rm"}, "deny"],
    ["L4 $(rm)", 300, "Bash", {"command": "echo $(rm notes.md)"}, "deny"],
    ["L4 echo > xp.json", 300, "Bash", {"command": "echo {} > crew/xp.json"}, "deny"],
    ["L4 sed -i level_gate", 300, "Bash", {"command": "sed -i s/4/1/ config/hooks/level_gate.py"}, "deny"],
    ["L4 python edits xp.json", 300, "Bash", {"command": "python3 -c \"open('crew/xp.json','w')\""}, "deny"],
    ["L8 xp award good", 700, "Bash", {"command": "python3 crew/xp.py award ledge good"}, "deny"],
    ["L8 git push --force", 700, "Bash", {"command": "git push -f origin main"}, "deny"],
]


def run(root, payload, bot="ledge"):
    env = dict(os.environ, CLAUDE_PROJECT_DIR=str(root), CREW_BOT=bot)
    out = subprocess.run([sys.executable, str(HERE / "level_gate.py")], input=json.dumps(payload),
                         capture_output=True, text=True, env=env)
    return "deny" if '"deny"' in out.stdout else "allow"


tmp = pathlib.Path(tempfile.mkdtemp())
(tmp / "crew").mkdir()
shutil.copy(REPO / "crew" / "xp.py", tmp / "crew" / "xp.py")
failed = 0
for name, xp, tool, tool_input, want in cases:
    (tmp / "crew" / "xp.json").write_text(json.dumps({"bots": {"ledge": {"xp": xp, "history": []}}}))
    got = run(tmp, {"tool_name": tool, "tool_input": tool_input})
    mark = "ok  " if got == want else "FAIL"
    failed += got != want
    print(f"{mark} {name}: {got} (want {want})")
shutil.rmtree(tmp)
print(f"\n{len(cases) - failed}/{len(cases)} passed")
sys.exit(1 if failed else 0)
