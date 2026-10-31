# Crew: summary handoff for Claude Code

As of Thu Oct 29, 2026, 10:50 ET. Full log in `crew/HANDOFF-LOG.md`. Repo main is at cb6d170 or later (my-waffles; see the Oct 31 note below).

**Oct 31:** the crew moved from `my-waffles` to its own repo, `puffin-crew` (same folder layout). Ledge's first run was Oct 30 (10 XP, commit 37d5167 in my-waffles); the gate loaded in the cloud. Ledge now runs on Sonnet 5.5.

**Since then (Oct 29, Claude Code):** PR #10 merged: Ledge can read the Ledger and append to `paper.md` at level 1 (the gate blocked both). PR #11: the shell is gated by level, with tests in `config/hooks/test-level-gate.py`. Dashboard built (candidate 1 below): see "Dashboard" in `crew/README.md`. Lane note for the Ledger sweep spec (PR #7): no crew bot and not the dashboard settle claims, close tasks or refresh past lessons; those stay with the sweep.

## What this is

Kyle's "crew": Claude Code bots as characters (puffins, modeled on Grok's companion app) that earn XP by doing real work and unlock abilities as they level. First bot is **Ledge**, an accountability puffin that reads the Claude Accuracy Ledger and reports what's open.

## Where things live

| Thing | Path |
|---|---|
| Unlock table and standing crew rules | `crew/levels.md` |
| Ledge's persona (lane, does, does not, voice, run routine, hard rules) | `crew/ledge/persona.md` |
| Ledge's learned notes (writable at L2+) | `crew/ledge/memory.md` |
| XP script (only thing that may change `crew/xp.json`) | `crew/xp.py` |
| Shared newspaper, every bot's Daily Brief | `crew/paper.md` |
| Level-gate hook (PreToolUse) | `config/hooks/level_gate.py` |
| Hooks-only project settings (cloud runs) | `.claude/settings.json` |
| Subagent definition | `config/agents/ledge.md` and `.claude/agents/ledge.md` |
| Active bot marker for cloud runs (git-ignored) | `crew/ACTIVE` |

## How a run works

1. `git pull`, write `ledge` to `crew/ACTIVE` (the hook reads `CREW_BOT` env var first, then this file; neither set means the hook does nothing).
2. `python3 crew/xp.py show`; if parked, stop.
3. Read persona, levels, paper.md, memory.md. `python3 crew/xp.py level ledge`.
4. Read the Ledger (artifact 018d4349-e500-4eaf-94ab-1c461e65a395) with the accuracy-ledger skill's "What's open" rules.
5. Report a Daily Brief: one next action, 2 critical bullets, 2 positive bullets. "Nothing new" if nothing changed.
6. Append the four bullets to `crew/paper.md` under `# YYYY-MM-DD` / `## ledge`.
7. `python3 crew/xp.py award ledge run`; commit `xp.json`, `paper.md`, `memory.md` to main; log the run to the Ledger (loggedBy idle-sweep, project Claude setup).

Scheduled task "Ledge daily run" (id `trig_01CCXQH4qxZKnZbx9wx6RJzR`) does this weekdays 06:47 ET in the cloud, auto approval, push notification.

## XP and levels (from levels.md)

run +10, good +25, catch +15, bad -10, idle -5 per decay check after 3 days (parked bots skipped). Level = 1 + floor(XP/100).
L1 read/talk and log its own run to the Ledger (moved from L5 on Oct 31); L2 own memory.md; L3 web; L4 edit outside own folder; L5 open; L6 one scheduled follow-up; L8 routine actions without asking (routine = reversible and inside the lane).
Kyle rates runs: `python3 crew/xp.py award ledge good|bad`. Pause: `park ledge` / `unpark ledge`.

## Standing crew rules

- Deliver-first: a bot relaying another bot's report to Kyle delivers it unchanged, notes after or beside.
- One owner per lane; a bot acts only inside its "Does" list.
- Parked bots stay quiet until Kyle says go.
- Anything that sends, merges, deletes or decides for Kyle waits for his yes, at every level.
- Counts come from a script. Never delete; stage. If the Ledger can't be opened, say so and stop.

## Verified vs not

Verified by test in this build: XP math and level-ups; hook denies and allows correctly via env var and via `crew/ACTIVE`; hook does nothing when neither is set; `kyle-gates.js` and `level_gate.py` run on the same call without conflict (terminal test); park skips decay; deny JSON shape and committable project settings per the Claude Code hooks docs.
Not yet verified: that a cloud scheduled session actually loads `.claude/settings.json` hooks and `.claude/agents/ledge.md` (Ledger entry e07; first run Oct 30 settles it); that the two hooks stack inside a live Claude Code session on Kyle's PC.

## Waiting on Kyle

1. Ledger entry e06: is a hooks-only `.claude/settings.json` in the repo OK, given the README rule "never commit settings.json"? If no, remove the file and the cloud hook enforcement goes with it.
2. Rate Ledge's first run after Oct 30.

## Next build candidates (not started)

1. Dashboard page reading `xp.json`: character cards, level bars, titles, moods.
2. Bot #2, an overseer puffin: folds `paper.md` into one digest and relays it to Kyle deliver-first. Grok's version of this is "Grok Bot oversees the fleet"; a Varys-style intel bot came after that in Grok's design.
3. A phone-friendly way to rate runs (today it's a terminal command or asking Claude in chat).
4. Update the README settings.json rule text once Kyle answers e06.

## Source material

Kyle's Grok bot handoff: https://grok-bot-ecosystem-coordination-handoff-4wm2.pages.grok.bot/ (two PDF versions read Oct 29, 07:37 and 09:10). It covers Watch Picker (its-popcorn-time) coordination among Grok bots; that project is separate from the crew and Ledge does not inherit it.
