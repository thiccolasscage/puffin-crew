#!/usr/bin/env python3
"""Crew XP ledger. The only thing allowed to change crew/xp.json.

Usage:
  python crew/xp.py award <bot> <event>     event: run | good | catch | bad
  python crew/xp.py decay                   -5 to any bot idle 3+ days (parked bots skipped)
  python crew/xp.py park <bot>              pause the bot: no runs, no decay
  python crew/xp.py unpark <bot>            resume the bot
  python crew/xp.py show                    print every bot's XP and level
  python crew/xp.py level <bot>             print just the level (used by hooks)
"""
import json, sys, datetime, pathlib

HERE = pathlib.Path(__file__).resolve().parent
LEDGER = HERE / "xp.json"
XP = {"run": 10, "good": 25, "catch": 15, "bad": -10, "idle": -5}
TITLES = {1: "Fledgling", 2: "Ledge Keeper", 4: "Burrow Warden",
          6: "Colony Sentinel", 8: "Old Bird"}


def load():
    return json.loads(LEDGER.read_text()) if LEDGER.exists() else {"bots": {}}


def save(data):
    LEDGER.write_text(json.dumps(data, indent=2) + "\n")


def level(xp):
    return max(1, 1 + xp // 100)


def title(lvl):
    return TITLES[max(k for k in TITLES if k <= lvl)]


def award(bot, event):
    if event not in XP:
        sys.exit(f"unknown event '{event}', use one of {list(XP)}")
    data = load()
    b = data["bots"].setdefault(bot, {"xp": 0, "history": []})
    before = level(b["xp"])
    b["xp"] = max(0, b["xp"] + XP[event])
    b["last_run"] = datetime.date.today().isoformat() if event == "run" else b.get("last_run")
    b["history"].append({"date": datetime.date.today().isoformat(),
                         "event": event, "xp": XP[event]})
    after = level(b["xp"])
    save(data)
    print(f"{bot}: {event} {XP[event]:+d} -> {b['xp']} XP, level {after} ({title(after)})")
    if after > before:
        print(f"LEVEL UP: {bot} is now level {after}, {title(after)}")


def decay():
    data = load()
    today = datetime.date.today()
    for name, b in data["bots"].items():
        last = b.get("last_run")
        if not last or b.get("parked"):
            continue
        idle = (today - datetime.date.fromisoformat(last)).days
        if idle >= 3:
            b["xp"] = max(0, b["xp"] + XP["idle"])
            b["history"].append({"date": today.isoformat(), "event": "idle", "xp": XP["idle"]})
            print(f"{name}: idle {idle} days, -5 -> {b['xp']} XP")
    save(data)


def park(bot, parked):
    data = load()
    b = data["bots"].setdefault(bot, {"xp": 0, "history": []})
    b["parked"] = parked
    save(data)
    print(f"{bot}: {'parked' if parked else 'active'}")


def show():
    for name, b in load()["bots"].items():
        lvl = level(b["xp"])
        state = "parked" if b.get("parked") else "active"
        print(f"{name:10} {b['xp']:4} XP  L{lvl} {title(lvl):16} {state:7} last run {b.get('last_run')}")


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a:
        sys.exit(__doc__)
    if a[0] == "award" and len(a) == 3:
        award(a[1], a[2])
    elif a[0] == "decay":
        decay()
    elif a[0] == "show":
        show()
    elif a[0] in ("park", "unpark") and len(a) == 2:
        park(a[1], a[0] == "park")
    elif a[0] == "level" and len(a) == 2:
        print(level(load()["bots"].get(a[1], {"xp": 0})["xp"]))
    else:
        sys.exit(__doc__)
