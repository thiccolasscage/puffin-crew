#!/usr/bin/env python3
"""Build the Puffin Crew dashboard's data files from the repo. Reads only; never changes xp.json.

Usage:
  python3 crew/dashboard_data.py <out_dir> [YYYY-MM-DD]   date defaults to today; used for moods

Writes four files to <out_dir>:
  crew.json     one row per bot: level, title, XP, next unlock, run counts, mood
  history.csv   every XP event with each bot's running total
  unlocks.json  the level table from levels.md
  paper.csv     every bullet in paper.md, newest date first
The two that start empty are CSV, so a file with no rows still names its columns.
"""
import csv, datetime, importlib.util, json, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("xp", HERE / "xp.py")
xp = importlib.util.module_from_spec(spec)
spec.loader.exec_module(xp)


def unlocks():
    rows = []
    for line in (HERE / "levels.md").read_text().splitlines():
        m = re.match(r"\|\s*(\d+)\s*\|\s*(\d+)\s*\|\s*(.+?)\s*\|\s*$", line)
        if m:
            rows.append({"level": int(m[1]), "xp": int(m[2]), "unlock": m[3].replace("`", "")})
    return rows


def persona(bot):
    p = HERE / bot / "persona.md"
    text = p.read_text() if p.exists() else ""
    field = lambda name: (re.search(rf"\*\*{name}:\*\*\s*([^.\n]+)", text) or [None, ""])[1].strip()
    name = (re.search(r"^# (.+)$", text, re.M) or [None, bot.title()])[1].strip()
    return {"name": name, "species": field("Species"), "lane": field("Lane")}


# How full the mood meter on each card is, 0 to 100.
MOOD_SCORE = {"Proud": 100, "Busy": 85, "Eager": 80, "Ready": 65, "Napping": 50, "Sheepish": 40, "Restless": 30}


def mood(b, today):
    """A mood from the bot's own record. First match wins."""
    last = b.get("last_run")
    idle = (today - datetime.date.fromisoformat(last)).days if last else None
    events = [h["event"] for h in b.get("history", [])]
    rating = next((e for e in reversed(events) if e in ("good", "bad", "catch")), None)
    if b.get("parked"):
        return "Napping", "Parked until Kyle says go"
    if last is None:
        return "Eager", "Waiting for its first run"
    if idle >= 3:
        return "Restless", f"No run for {idle} days; idle XP decay applies"
    if rating == "bad" and events[-1] == "bad":
        return "Sheepish", "Last rating was bad"
    if rating in ("good", "catch") and events[-1] in ("good", "catch"):
        return "Proud", f"Last rating was {rating}"
    if idle <= 1:
        return "Busy", "Ran in the last day"
    return "Ready", f"Last ran {idle} days ago"


def build(today):
    data = xp.load()["bots"]
    names = sorted(set(data) | {p.parent.name for p in HERE.glob("*/persona.md")})
    table = unlocks()
    crew, history = [], []
    for bot in names:
        b = data.get(bot, {"xp": 0, "history": []})
        lvl = xp.level(b["xp"])
        nxt = next((u for u in table if u["level"] > lvl), None)
        events = [h["event"] for h in b.get("history", [])]
        m, why = mood(b, today)
        crew.append({
            "bot": bot, **persona(bot),
            "level": lvl, "title": xp.title(lvl), "xp": b["xp"],
            "xp_into_level": b["xp"] - (lvl - 1) * 100,
            "next_level": nxt["level"] if nxt else None,
            "next_level_xp": nxt["xp"] if nxt else None,
            "xp_to_next": nxt["xp"] - b["xp"] if nxt else None,
            "next_unlock": nxt["unlock"] if nxt else "Everything unlocked",
            "state": "parked" if b.get("parked") else "active",
            "last_run": b.get("last_run"),
            "runs": events.count("run"), "good": events.count("good"),
            "catches": events.count("catch"), "bad": events.count("bad"),
            "mood": m, "mood_score": MOOD_SCORE[m], "mood_reason": why,
        })
        total = 0
        for h in b.get("history", []):
            total = max(0, total + h["xp"])
            history.append({"bot": bot, "date": h["date"], "event": h["event"],
                            "xp": h["xp"], "total": total})
    paper, date, who = [], None, None
    for line in (HERE / "paper.md").read_text().splitlines():
        if re.match(r"^# \d{4}-\d{2}-\d{2}\s*$", line):
            date, who = line[2:].strip(), None
        elif line.startswith("## ") and date:
            who = line[3:].strip()
        elif line.startswith("- ") and date and who:
            paper.append({"date": date, "bot": who, "text": line[2:].strip()})
    paper.sort(key=lambda r: r["date"], reverse=True)
    return {"crew": crew, "history": history, "unlocks": table, "paper": paper}


if __name__ == "__main__":
    if len(sys.argv) not in (2, 3):
        sys.exit(__doc__)
    out = pathlib.Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    today = datetime.date.fromisoformat(sys.argv[2]) if len(sys.argv) == 3 else datetime.date.today()
    columns = {"history": ["bot", "date", "event", "xp", "total"], "paper": ["date", "bot", "text"]}
    for name, rows in build(today).items():
        if name in columns:
            with open(out / f"{name}.csv", "w", newline="") as f:
                w = csv.DictWriter(f, fieldnames=columns[name])
                w.writeheader()
                w.writerows(rows)
            print(f"{name}.csv: {len(rows)} rows")
        else:
            (out / f"{name}.json").write_text(json.dumps(rows, indent=1) + "\n")
            print(f"{name}.json: {len(rows)} rows")
