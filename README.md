# Puffin Crew

Kyle's crew of Claude Code bots: characters (puffins) that earn XP by doing real
work and unlock abilities as they level. First bot: **Ledge**, the accountability
puffin that reads the Claude Accuracy Ledger every weekday at 6:47 ET.

Start here: `crew/README.md` (how it works) and `crew/CLAUDE_HANDOFF.md` (state and history).

| Thing | Path |
|---|---|
| Unlock table and crew rules | `crew/levels.md` |
| XP script (the only thing that changes `crew/xp.json`) | `crew/xp.py` |
| Ledge's persona and memory | `crew/ledge/` |
| Shared Daily Brief paper | `crew/paper.md` |
| Level gate hook and its tests | `config/hooks/level_gate.py`, `config/hooks/test-level-gate.py` |
| Hook settings for cloud runs | `.claude/settings.json` |
| Dashboard data script | `crew/dashboard_data.py` |

Dashboard: https://claude.ai/artifact/A8C1icLCbfnJVZB2oLrP4S

Moved here from `thiccolasscage/my-waffles` on Oct 31, 2026 (last crew state there: commit 37d5167),
so daily bot commits stay out of the config repo every computer syncs.
