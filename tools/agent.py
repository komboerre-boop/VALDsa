"""
tools/agent.py -- Python Bot Optimizer Agent

Polls the dashboard for bot health, auto-restarts stale bots,
and reports its own status back as a live widget.

Usage:
  python tools/agent.py --host http://localhost:3000 [--interval 30] [--stale-min 10]

  --host        Dashboard base URL  (default: http://localhost:3000)
  --interval    Poll interval in seconds (default: 30)
  --stale-min   Minutes online with 0 relics before bot is considered stale (default: 10)
"""

import argparse
import time
import sys
import json
from urllib.request import urlopen, Request
from urllib.error import URLError

# ── helpers ──────────────────────────────────────────────────────────────────

def api(host, path, method="GET", body=None):
    url = host.rstrip("/") + path
    data = json.dumps(body).encode() if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    req = Request(url, data=data, headers=headers, method=method)
    try:
        with urlopen(req, timeout=8) as r:
            return json.loads(r.read().decode())
    except Exception:
        return None

def post_agent_status(host, payload):
    api(host, "/api/agent-status", "POST", payload)

def ts():
    return time.strftime("%H:%M:%S")

# ── main loop ─────────────────────────────────────────────────────────────────

def run(host, interval, stale_min):
    stale_ms = stale_min * 60 * 1000
    restarted_total = 0

    print(f"[Agent] Monitoring {host}  interval={interval}s  stale={stale_min}min")

    while True:
        bots = api(host, "/api/bots")
        if bots is None:
            print(f"[{ts()}] WARN: cannot reach dashboard, retrying...")
            post_agent_status(host, {
                "active": False, "totalBots": 0, "onlineBots": 0,
                "restarted": restarted_total, "stale": 0,
                "lastAction": "no connection",
            })
            time.sleep(interval)
            continue

        total   = len(bots)
        online  = [b for b in bots if b.get("status") == "online"]
        offline = [b for b in bots if b.get("status") not in ("online", "banned")]
        banned  = [b for b in bots if b.get("status") == "banned"]

        # Detect stale: online, uptime > stale_ms, relics == 0 or None
        stale = [
            b for b in online
            if (b.get("uptime") or 0) > stale_ms
            and not (b.get("riliky") or 0)
        ]

        restarted_now = 0

        for b in stale:
            bid = b["id"]
            result = api(host, f"/api/bots/{bid}/reconnect", "POST")
            if result and result.get("ok"):
                restarted_now += 1
                restarted_total += 1
                print(f"[{ts()}] Restarted stale bot {b.get('username','?')} (id={bid})")

        # Reconnect all offline (not banned) bots
        if offline:
            result = api(host, "/api/bots/reconnect/all", "POST")
            if result:
                print(f"[{ts()}] Triggered reconnect-all ({len(offline)} offline)")

        last_action = ""
        if restarted_now:
            last_action = f"restarted {restarted_now} stale"
        elif offline:
            last_action = f"reconnect-all ({len(offline)} offline)"
        else:
            last_action = f"OK — {len(online)}/{total} online"

        post_agent_status(host, {
            "active":     True,
            "totalBots":  total,
            "onlineBots": len(online),
            "restarted":  restarted_total,
            "stale":      len(stale),
            "lastAction": last_action,
        })

        status_line = (
            f"[{ts()}] total={total}  online={len(online)}"
            f"  offline={len(offline)}  banned={len(banned)}"
            f"  stale={len(stale)}  restarted={restarted_total}"
        )
        print(status_line)

        time.sleep(interval)


def main():
    p = argparse.ArgumentParser(description="Bot Optimizer Agent")
    p.add_argument("--host",       default="http://localhost:3000")
    p.add_argument("--interval",   type=int, default=30)
    p.add_argument("--stale-min",  type=int, default=10, dest="stale_min")
    args = p.parse_args()

    try:
        run(args.host, args.interval, args.stale_min)
    except KeyboardInterrupt:
        print("\n[Agent] Stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
