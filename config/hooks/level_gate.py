#!/usr/bin/env python3
"""PreToolUse hook: deny tools the active crew bot hasn't unlocked.

Claude Code passes the tool call as JSON on stdin. The active bot is read
from the CREW_BOT environment variable; if it isn't set, this hook does
nothing (so your normal Claude Code sessions are untouched).

Install: see crew/README.md. Lives in config/hooks/ like the other hooks.
"""
import json, os, re, shlex, subprocess, sys, pathlib

HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(os.environ.get("CLAUDE_PROJECT_DIR", HERE.parent.parent))
bot = os.environ.get("CREW_BOT")
if not bot:
    active = ROOT / "crew" / "ACTIVE"   # written by a cloud run; ignored by git
    bot = active.read_text().strip() if active.exists() else ""
if not bot:
    sys.exit(0)

# Minimum level per tool. Anything not listed is allowed at level 1.
GATE = {
    "WebSearch": 3, "WebFetch": 3,
    "Edit": 4, "Write": 4, "MultiEdit": 4, "NotebookEdit": 4,
    "mcp__claude-code-remote__create_trigger": 6,
}
# The Claude Accuracy Ledger artifact; the only store a bot may write to.
LEDGER_ID = "018d4349-e500-4eaf-94ab-1c461e65a395"
# Below this level, Bash runs only the commands on the short list below.
FULL_SHELL = 4

# No bot may change these at any level: its own XP, the gate, or who is active.
PROTECTED = ("crew/xp.json", "crew/xp.py", "crew/ACTIVE",
             "config/hooks/level_gate.py", ".claude/settings.json")

READ_ONLY = {"cat", "ls", "head", "tail", "grep", "wc", "date", "pwd", "echo",
             "cd", "find", "sort", "uniq", "diff", "true"}
GIT_OK = {"status", "log", "diff", "show", "pull", "fetch", "add", "commit",
          "push", "rev-parse", "ls-remote", "branch"}
OPERATORS = {"&&", "||", ";", "|", "\n"}
DELETERS = {"rm", "rmdir", "shred", "unlink"}
# Used when a full-shell command can't be split; a best-effort check, not a parser.
RISKY = re.compile(r"\b(rm|rmdir|shred|unlink)\b|\bgit\b.*\b(clean|reset\s+--hard|push\s.*(-f\b|--force|--delete))")


def deny(reason):
    print(json.dumps({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "deny",
        "permissionDecisionReason": reason
    }}))
    sys.exit(0)


def segments(command):
    """Split a shell command into simple commands. None if it uses anything else."""
    if "`" in command or "$(" in command:
        return None
    lex = shlex.shlex(command, posix=True, punctuation_chars="();<>|&\n")
    lex.whitespace = " \t\r"
    lex.whitespace_split = True
    try:
        tokens = list(lex)
    except ValueError:
        return None
    segs, cur, i = [], [], 0
    while i < len(tokens):
        t = tokens[i]
        nxt = tokens[i + 1] if i + 1 < len(tokens) else ""
        if t in OPERATORS:
            segs.append(cur)
            cur = []
        elif t in (">", ">>") and nxt == "/dev/null" or t == ">&" and nxt in ("1", "2"):
            if cur and cur[-1] == "2":
                cur.pop()
            i += 1
        elif set(t) <= set("();<>|&"):
            return None   # other redirects, subshells, background jobs
        else:
            cur.append(t)
        i += 1
    segs.append(cur)
    return [s for s in segs if s]


def git_sub(seg):
    """The git subcommand and its args, skipping git's own leading options."""
    i = 1
    while i < len(seg) and seg[i].startswith("-"):
        i += 2 if seg[i] in ("-C", "-c") else 1
    return (seg[i], seg[i + 1:]) if i < len(seg) else ("", [])


def xp_ok(args):
    # A bot may read XP and log its own run; ratings, park and decay are Kyle's.
    return (args[:1] == ["show"] or args[:1] == ["level"]
            or args == ["award", bot, "run"])


def shell_problem(seg, lvl):
    """Why this simple command is denied, or None if it may run."""
    cmd = seg[0].rsplit("/", 1)[-1]
    args = seg[1:]
    if cmd in ("python", "python3") and args and args[0].replace(os.sep, "/").endswith("crew/xp.py"):
        return None if xp_ok(args[1:]) else "xp.py only allows show, level and award <self> run"
    if cmd == "git":
        sub, rest = git_sub(seg)
        if (sub in ("clean", "filter-branch")
                or sub == "reset" and "--hard" in rest
                or sub == "branch" and any(a in ("-d", "-D", "--delete") for a in rest)
                or sub == "push" and any(a.startswith(("-f", "--force", "--delete", ":")) or "+" in a[:1] for a in rest)):
            return "deleting or force-pushing waits for Kyle at every level"
        if sub in GIT_OK and not (sub == "branch" and rest and rest != ["--show-current"]):
            return None
    elif cmd in READ_ONLY:
        if cmd == "find" and any(a in ("-exec", "-execdir", "-delete", "-ok", "-fprint") for a in args):
            return "find may not run or delete things"
        return None
    if any(w.rsplit("/", 1)[-1] in DELETERS for w in seg):   # rm, sudo rm, xargs rm
        return "deleting waits for Kyle at every level"
    if any(p in a.replace(os.sep, "/") for a in args for p in PROTECTED):
        return "no bot may change XP, the level gate or the active bot"
    if lvl < FULL_SHELL:
        return (f"below level {FULL_SHELL} the shell runs only git, crew/xp.py and read-only "
                f"commands with no redirects; use Read and Edit for files")
    return None


payload = json.load(sys.stdin)
tool = payload.get("tool_name", "")
tool_input = payload.get("tool_input", {})
path = str(tool_input.get("file_path") or tool_input.get("notebook_path") or "").replace(os.sep, "/")

xp_py = ROOT / "crew" / "xp.py"
lvl = int(subprocess.check_output([sys.executable, str(xp_py), "level", bot]).strip())

if tool in ("Edit", "Write", "MultiEdit", "NotebookEdit") and path.endswith(PROTECTED):
    deny(f"{bot} may not change {path}: XP, the level gate and the active bot are Kyle's.")

if tool == "Bash":
    command = str(tool_input.get("command", ""))
    segs = segments(command)
    if segs is None:
        if lvl < FULL_SHELL:
            deny(f"{bot} is level {lvl}; subshells, backticks and file redirects unlock at level {FULL_SHELL}; use Read and Edit for files.")
        if RISKY.search(command) or any(p in command.replace(os.sep, "/") for p in PROTECTED):
            deny(f"{bot} is level {lvl}; this command deletes, force-pushes or touches XP or the level gate.")
        sys.exit(0)
    for seg in segs:
        problem = shell_problem(seg, lvl)
        if problem:
            deny(f"{bot} is level {lvl}; `{' '.join(seg)[:60]}` denied: {problem}.")
    sys.exit(0)

need = GATE.get(tool, 1)
# Ledger (levels.md): reading anything, and creating the bot's own idle-sweep stretch,
# are level 1. Every other artifact-store write is Kyle's, at every level.
if tool == "ArtifactData":
    action = tool_input.get("action")
    if action not in ("get", "list", "query", "profiles"):
        doc = tool_input.get("data")
        if doc is None and tool_input.get("file_path"):
            try:
                doc = json.loads(pathlib.Path(tool_input["file_path"]).read_text())
            except (OSError, ValueError):
                doc = None
        # A set without if_version can only create a document, never replace one.
        own_stretch = (action == "set" and "if_version" not in tool_input
                       and LEDGER_ID in str(tool_input.get("url", ""))
                       and tool_input.get("collection") == "stretches"
                       and isinstance(doc, dict) and doc.get("loggedBy") == "idle-sweep")
        if not own_stretch:
            deny(f"{bot} may only read the Ledger and log its own run as a new idle-sweep stretch; "
                 "editing entries, tasks, fixes, marks, batch and delete are Kyle's at every level.")
# The run routine appends to the shared paper at every level.
if tool in ("Edit", "Write") and path.endswith("crew/paper.md"):
    need = 1
# Level 2 may write its own memory.md even though Edit/Write gate at 4.
if tool in ("Edit", "Write") and path.endswith(f"crew/{bot}/memory.md"):
    need = 2

if lvl < need:
    deny(f"{bot} is level {lvl}; {tool} unlocks at level {need}.")
sys.exit(0)
