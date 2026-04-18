#!/usr/bin/env python3
"""
Bot Performance Optimizer
Polls the dashboard API, detects stuck/dead bots, auto-restarts them,
and generates a CSV performance report.

Usage:
  python tools/optimize_bots.py
  python tools/optimize_bots.py --host http://localhost:3000 --interval 30 --stale-min 10
"""

import argparse
import csv
import json
import logging
import os
import time
import urllib.error
import urllib.request
from datetime import datetime

LOG_FILE  = os.path.join(os.path.dirname(__file__), "optimizer.log")
CSV_FILE  = os.path.join(os.path.dirname(__file__), "bot_report.csv")

logging.basicConfig(
    filename=LOG_FILE, level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)

def api(host: str, path: str, method: str = "GET", data: bytes = None):
    url = host.rstrip("/") + path
    headers = {"Accept": "application/json"}
    if data:
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=8) as r:
            return json.loads(r.read().decode())
    except Exception as e:
        logging.warning(f"API {method} {path}: {e}")
        return None

def reconnect_bot(host: str, bot_id: int):
    result = api(host, f"/api/bots/{bot_id}/reconnect", "POST", b"{}")
    logging.info(f"Reconnect bot {bot_id}: {result}")
    return result is not None

def format_bar(value: int, max_val: int, width: int = 20) -> str:
    if max_val == 0:
        return "░" * width
    filled = int(value / max_val * width)
    return "█" * filled + "░" * (width - filled)

def write_csv(snapshot: list):
    fieldnames = ["timestamp", "id", "username", "status", "relics", "stage"]
    ts = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    write_header = not os.path.exists(CSV_FILE)
    with open(CSV_FILE, "a", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames)
        if write_header:
            writer.writeheader()
        for b in snapshot:
            writer.writerow({
                "timestamp": ts,
                "id":        b.get("id"),
                "username":  b.get("config", {}).get("username", "?"),
                "status":    b.get("status", "?"),
                "relics":    b.get("relics", {}).get("total", 0),
                "stage":     b.get("stage", "?"),
            })

def main():
    parser = argparse.ArgumentParser(description="Bot Performance Optimizer")
    parser.add_argument("--host",       default="http://localhost:3000")
    parser.add_argument("--interval",   type=int,   default=30,  help="Poll interval (sec)")
    parser.add_argument("--stale-min",  type=float, default=10,  help="Minutes online with 0 relics before restart")
    parser.add_argument("--max-restart",type=int,   default=5,   help="Max restarts per cycle")
    parser.add_argument("--csv",        action="store_true",     help="Append to bot_report.csv each cycle")
    args = parser.parse_args()

    print(f"Optimizer  host={args.host}  interval={args.interval}s  stale>{args.stale_min}min")
    print(f"Log: {LOG_FILE}")
    print("Ctrl+C to exit\n")

    # Track when we first saw each bot online with 0 relics
    stale_since: dict = {}
    restart_count = 0

    while True:
        bots = api(args.host, "/api/bots")
        ts   = datetime.now().strftime("%H:%M:%S")
        print(f"\033[2J\033[H=== Bot Optimizer [{ts}] ===\n")

        if not bots:
            print("  [!] Cannot reach dashboard")
            time.sleep(args.interval)
            continue

        if args.csv:
            write_csv(bots)

        total   = len(bots)
        online  = [b for b in bots if b.get("status") == "online"]
        offline = [b for b in bots if b.get("status") in ("offline", "connecting")]
        banned  = [b for b in bots if b.get("status") == "banned"]
        total_relics = sum(b.get("relics", {}).get("total", 0) for b in bots)
        max_relics   = max((b.get("relics", {}).get("total", 0) for b in bots), default=1)

        print(f"  Total:{total}  Online:\033[32m{len(online)}\033[0m  "
              f"Offline:\033[33m{len(offline)}\033[0m  Banned:\033[31m{len(banned)}\033[0m  "
              f"Relics:{total_relics}\n")

        restarted_this_cycle = 0

        # Stale detection: online but 0 relics for too long
        now = time.time()
        for b in online:
            bid      = b.get("id")
            relics   = b.get("relics", {}).get("total", 0)
            username = b.get("config", {}).get("username", str(bid))

            if relics == 0:
                if bid not in stale_since:
                    stale_since[bid] = now
                stale_sec = now - stale_since[bid]
                stale_bar = format_bar(int(stale_sec), int(args.stale_min * 60))
                mark = ""
                if stale_sec >= args.stale_min * 60 and restarted_this_cycle < args.max_restart:
                    if reconnect_bot(args.host, bid):
                        restarted_this_cycle += 1
                        restart_count += 1
                        mark = f"\033[33m → RESTARTED (stale {stale_sec/60:.1f}min)\033[0m"
                        stale_since.pop(bid, None)
                    else:
                        mark = "\033[31m → restart failed\033[0m"
                print(f"  \033[33m[stale]\033[0m {username:<20} relics=0  [{stale_bar}]{mark}")
            else:
                stale_since.pop(bid, None)

        # Top 5 performers
        top5 = sorted(online, key=lambda b: b.get("relics", {}).get("total", 0), reverse=True)[:5]
        if top5:
            print("\n  Top performers:")
            for b in top5:
                name   = b.get("config", {}).get("username", "?")
                relics = b.get("relics", {}).get("total", 0)
                bar    = format_bar(relics, max_relics)
                print(f"    {name:<20} [{bar}] {relics}")

        # Offline bots summary
        if offline:
            print(f"\n  Offline ({len(offline)}): {', '.join(b.get('config',{}).get('username','?') for b in offline[:10])}" +
                  ("..." if len(offline) > 10 else ""))

        print(f"\n  Total restarts this session: {restart_count}")
        if args.csv:
            print(f"  CSV appended to: {CSV_FILE}")

        logging.info(f"cycle total={total} online={len(online)} offline={len(offline)} "
                     f"relics={total_relics} restarted={restarted_this_cycle}")
        time.sleep(args.interval)

if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nStopped.")
