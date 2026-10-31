# Crew: bots as characters

Each bot is a folder under `crew/` with a `persona.md` (who it is) and a
`memory.md` (what it has learned). `crew/xp.json` holds XP for all bots and is
changed only by `crew/xp.py`. `crew/levels.md` is the unlock table.

The bot's agent file lives in `config/agents/` and its hook in `config/hooks/`.
This repo (`puffin-crew`) holds only the crew; it moved out of `my-waffles` on Oct 31, 2026.

## Cloud runs (no PC needed)

A scheduled task starts a fresh cloud session with this repo, writes `crew/ACTIVE`
(the bot's name; git ignores it), runs the bot, and the bot commits `crew/xp.json`
and its `memory.md` back to main. The hook in `.claude/settings.json` (hooks only,
no secrets or per-computer paths) enforces levels there.

## Install (home PC, after pulling main)

1. Copy `config/agents/ledge.md` to `.claude/agents/ledge.md` in your user
   folder (wherever your other agents from `config/agents/` go).
2. Add the hook to `.claude/settings.json`, next to the existing hooks. Use the
   full path like the other hook commands do:

```json
"PreToolUse": [
  {
    "hooks": [
      { "type": "command", "command": "python \"FULL-PATH-TO-REPO/config/hooks/level_gate.py\"", "timeout": 10 }
    ]
  }
]
```

3. Start a session with the bot named, so the hook knows who is active.
   PowerShell: `$env:CREW_BOT="ledge"; claude`
   Leave `CREW_BOT` unset for normal sessions and the hook does nothing.

## Daily use (run from the repo root)

- Say "run Ledge" or `@ledge`.
- Rate the run: `python crew/xp.py award ledge good` or `... bad`.
- Scoreboard: `python crew/xp.py show`.
- Decay: schedule `python crew/xp.py decay` daily.
- Pause a bot: `python crew/xp.py park ledge` (no runs, no decay); `unpark` to resume.
- `crew/paper.md` is the shared newspaper: every bot's Daily Brief, newest at the bottom.

## Adding a bot

1. `crew/<name>/persona.md` and `memory.md` (copy Ledge's as a template).
2. `config/agents/<name>.md` pointing at that persona.
3. Add its titles to `TITLES` in `crew/xp.py` if you want its own, else it uses Ledge's.

## Dashboard

Puffin Crew: https://claude.ai/artifact/A8C1icLCbfnJVZB2oLrP4S (private until shared).
Character cards (puffin avatar that dresses up by level, title, XP bar, next
unlock, mood, run counts), XP over time, latest paper bullets, unlock ladder.

It can't read the repo live (no GitHub connector), so it shows four data files
built from the repo. To refresh, from the repo root:

1. `python3 crew/dashboard_data.py <out_dir>` writes `crew.json`, `history.csv`,
   `unlocks.json`, `paper.csv` (CSV for the two that start empty, so they still load). It only reads; moods come from each bot's last
   run and rating.
2. Upload each file to the dashboard as an asset, then update `datasets/<name>`
   with the new `url`, `name` and `updated` (Claude does this with the Artifact
   and ArtifactData tools).

A scheduled task, "Crew dashboard refresh", does this weekdays at 07:17 ET, after
Ledge's run. It is not a crew bot: it only re-uploads the data, never settles,
closes or edits Ledger entries, and never refreshes past lessons.

## Not yet built

- A Daily Paper bot that folds every lane's `paper.md` entry into one digest.
