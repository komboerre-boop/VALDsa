#!/usr/bin/env python3
"""
Bot Manager Live Terminal Monitor
Polls /api/bots every 5s, shows live stats, auto-triggers reconnect when too many bots drop.
Usage: python stats_monitor.py [--host http://localhost:3000] [--threshold 40]
"""

import argparse
import json
import logging
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

try:
    import curses
    HAS_CURSES = True
except ImportError:
    HAS_CURSES = False

LOG_FILE = os.path.join(os.path.dirname(__file__), "stats_monitor.log")

logging.basicConfig(
    filename=LOG_FILE,
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)


def fetch_bots(host: str) -> list:
    url = f"{host}/api/bots"
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        return json.loads(r.read().decode())


def post_reconnect_all(host: str):
    url = f"{host}/api/bots/reconnect/all"
    req = urllib.request.Request(url, data=b"{}", method="POST",
                                  headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=5):
            pass
        logging.info("Auto-reconnect triggered (POST /api/bots/reconnect/all)")
    except Exception as e:
        logging.warning(f"Reconnect POST failed: {e}")


def summarize(bots: list) -> dict:
    total = len(bots)
    online = sum(1 for b in bots if b.get("status") == "online")
    offline = sum(1 for b in bots if b.get("status") in ("offline", "connecting"))
    banned = sum(1 for b in bots if b.get("status") == "banned")
    relics = sum(b.get("relics", 0) for b in bots)

    relic_top = sorted(
        [(b.get("username", "?"), b.get("relics", 0)) for b in bots],
        key=lambda x: x[1], reverse=True
    )[:5]

    return {
        "total": total, "online": online, "offline": offline,
        "banned": banned, "relics": relics, "top": relic_top,
    }


def plain_loop(host: str, interval: int, threshold: int):
    last_reconnect = 0
    while True:
        ts = datetime.now().strftime("%H:%M:%S")
        try:
            bots = fetch_bots(host)
            s = summarize(bots)
            pct_offline = (s["offline"] / s["total"] * 100) if s["total"] else 0

            print(f"\033[2J\033[H", end="")  # clear screen
            print(f"=== Bot Manager Monitor  [{ts}] ===")
            print(f"  Total : {s['total']}")
            print(f"  Online: \033[32m{s['online']}\033[0m")
            print(f"  Offline:\033[33m{s['offline']}\033[0m  ({pct_offline:.0f}%)")
            print(f"  Banned: \033[31m{s['banned']}\033[0m")
            print(f"  Relics: {s['relics']}")
            print()
            print("  Top relic earners:")
            for i, (name, rel) in enumerate(s["top"], 1):
                print(f"    {i}. {name}: {rel}")

            if pct_offline >= threshold and s["total"] > 0:
                now = time.time()
                if now - last_reconnect > 60:
                    print(f"\n  \033[33m[!] >{threshold}% offline — auto-reconnect triggered\033[0m")
                    post_reconnect_all(host)
                    last_reconnect = now
                    logging.info(f"Auto-reconnect: {s['offline']}/{s['total']} offline")

            logging.info(f"total={s['total']} online={s['online']} offline={s['offline']} banned={s['banned']} relics={s['relics']}")
        except Exception as e:
            print(f"\033[2J\033[H[{ts}] Error fetching bots: {e}")
            logging.warning(f"Fetch error: {e}")

        time.sleep(interval)


def main():
    parser = argparse.ArgumentParser(description="Bot Manager Terminal Monitor")
    parser.add_argument("--host", default="http://localhost:3000", help="Bot manager base URL")
    parser.add_argument("--interval", type=int, default=5, help="Poll interval seconds")
    parser.add_argument("--threshold", type=int, default=40, help="Offline %% to trigger reconnect")
    args = parser.parse_args()

    print(f"Monitoring {args.host} every {args.interval}s (reconnect if >{args.threshold}% offline)")
    print(f"Log: {LOG_FILE}")
    print("Ctrl+C to exit\n")
    try:
        plain_loop(args.host, args.interval, args.threshold)
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()
