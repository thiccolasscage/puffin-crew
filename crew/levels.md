# Crew levels and unlocks

XP is computed only by `crew/xp.py`. Never hand-edit `xp.json`.

## XP sources

| Event | XP | Who awards it |
|---|---|---|
| Run completed (`run`) | +10 | the bot, at end of a run |
| Kyle rated the run good (`good`) | +25 | Kyle, via `xp.py award` |
| Bot caught a mistake before Kyle did (`catch`) | +15 | Kyle confirms, via `xp.py award` |
| Kyle rated the run bad (`bad`) | -10 | Kyle |
| Idle 3+ days (`idle`) | -5 per check | `xp.py decay`, run by a scheduled task. Parked bots (`xp.py park <bot>`) are skipped |

## Level thresholds

Level = 1 + floor(XP / 100). Level never drops below 1.

| Level | XP | Unlocks |
|---|---|---|
| 1 | 0 | Read files, read the Ledger, talk, append its Daily Brief to `crew/paper.md` |
| 2 | 100 | Write to its own `memory.md` |
| 3 | 200 | Web search |
| 4 | 300 | Edit files outside its own folder (staged, never delete) |
| 5 | 400 | Write to the Ledger (log stretches) |
| 6 | 500 | Create one scheduled follow-up for itself |
| 8 | 700 | Act on routine items without asking first. Routine = reversible and inside the bot's lane. Anything that sends, merges, deletes or decides for Kyle still waits for his yes at every level |

Cosmetic unlocks ride along: title changes at 2, 4, 6, 8 (see persona.md).

## Standing crew rules

- **Deliver-first.** Any bot that relays another bot's report to Kyle delivers it unchanged, then adds its own notes after or beside it. Never rewrite a lane bot's words before Kyle sees them.
- One owner per lane. A bot acts only inside its lane (see "Does not" in its persona).
- Parked bots stay quiet until Kyle says go. No relaunching themselves.
- Anything that sends, merges, deletes or decides for Kyle waits for his yes, at every level.

## Enforcement

`config/hooks/level_gate.py` runs as a PreToolUse hook. It reads `xp.json`,
looks up the active bot's level, and denies any tool above that level.
Without the hook, levels are decoration.

The shell is gated too. Below level 4, Bash runs only git (no force-push,
hard reset, clean or branch delete), `crew/xp.py show`, `level` and
`award <self> run`, and read-only commands (cat, ls, grep and the like) with
no redirects, subshells or backticks. From level 4 the shell is open, except:
- deleting (rm and the like) and force-pushing are denied at every level;
- no bot may change `xp.json`, `xp.py`, `crew/ACTIVE`, the gate or
  `.claude/settings.json`, by any tool, at any level;
- a bot may never award itself `good` or `catch`, or park or unpark.

The level 4+ shell check is best effort: it reads the command, it can't
sandbox it. Test cases: `python3 config/hooks/test-level-gate.py`.
