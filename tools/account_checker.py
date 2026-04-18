#!/usr/bin/env python3
"""
Minecraft Account Checker (offline/cracked servers)
Reads bots.txt (user:pass lines), connects via raw TCP, detects Login Success vs Disconnect.
Usage: python account_checker.py bots.txt --host mc.example.com --port 25565 --workers 20
Output: valid_accounts.txt, banned_accounts.txt
"""

import argparse
import socket
import struct
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path


# ── VarInt helpers ──────────────────────────────────────────────────────────

def encode_varint(value: int) -> bytes:
    out = b""
    value &= 0xFFFFFFFF
    while True:
        byte = value & 0x7F
        value >>= 7
        if value:
            out += bytes([byte | 0x80])
        else:
            out += bytes([byte])
            break
    return out


def read_varint(sock: socket.socket) -> int:
    result, shift = 0, 0
    while True:
        b = sock.recv(1)
        if not b:
            raise ConnectionError("Socket closed while reading VarInt")
        byte = b[0]
        result |= (byte & 0x7F) << shift
        if not (byte & 0x80):
            break
        shift += 7
        if shift >= 35:
            raise ValueError("VarInt too big")
    return result


def encode_string(s: str) -> bytes:
    encoded = s.encode("utf-8")
    return encode_varint(len(encoded)) + encoded


def encode_packet(packet_id: int, data: bytes) -> bytes:
    payload = encode_varint(packet_id) + data
    return encode_varint(len(payload)) + payload


# ── Minecraft packets ────────────────────────────────────────────────────────

def build_handshake(host: str, port: int) -> bytes:
    data = (
        encode_varint(47)        # protocol version (1.8)
        + encode_string(host)
        + struct.pack(">H", port)
        + encode_varint(2)       # next state: login
    )
    return encode_packet(0x00, data)


def build_login_start(username: str) -> bytes:
    return encode_packet(0x00, encode_string(username))


# ── Check one account ────────────────────────────────────────────────────────

def check_account(host: str, port: int, username: str, password: str, timeout: float) -> str:
    """Returns 'valid', 'banned', or 'error:<reason>'"""
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        sock.settimeout(timeout)
        sock.connect((host, port))

        sock.sendall(build_handshake(host, port))
        sock.sendall(build_login_start(username))

        # Read response packet
        length = read_varint(sock)
        packet_id = read_varint(sock)
        sock.close()

        if packet_id == 0x02:
            return "valid"
        elif packet_id == 0x00:
            return "banned"
        else:
            return f"error:unknown_packet_{packet_id:#04x}"
    except socket.timeout:
        return "error:timeout"
    except ConnectionRefusedError:
        return "error:refused"
    except Exception as e:
        return f"error:{type(e).__name__}"


# ── Main ─────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Minecraft cracked account checker")
    parser.add_argument("bots_file", help="Path to bots.txt (user:pass per line)")
    parser.add_argument("--host", required=True, help="MC server hostname")
    parser.add_argument("--port", type=int, default=25565)
    parser.add_argument("--workers", type=int, default=20)
    parser.add_argument("--timeout", type=float, default=5.0)
    args = parser.parse_args()

    bots_path = Path(args.bots_file)
    if not bots_path.exists():
        print(f"File not found: {bots_path}")
        sys.exit(1)

    accounts = []
    for line in bots_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(":", 1)
        user = parts[0].strip()
        passwd = parts[1].strip() if len(parts) > 1 else user
        if user:
            accounts.append((user, passwd))

    print(f"Loaded {len(accounts)} accounts from {bots_path.name}")
    print(f"Server: {args.host}:{args.port}  Workers: {args.workers}  Timeout: {args.timeout}s\n")

    valid, banned, errors = [], [], []
    total = len(accounts)
    done = 0
    start = time.time()

    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = {
            pool.submit(check_account, args.host, args.port, u, p, args.timeout): (u, p)
            for u, p in accounts
        }
        for future in as_completed(futures):
            u, p = futures[future]
            result = future.result()
            done += 1
            elapsed = time.time() - start
            rps = done / elapsed if elapsed > 0 else 0

            if result == "valid":
                valid.append(f"{u}:{p}")
                status = "\033[32mVALID\033[0m"
            elif result == "banned":
                banned.append(f"{u}:{p}")
                status = "\033[31mBANNED\033[0m"
            else:
                errors.append(f"{u}:{p}  # {result}")
                status = f"\033[33m{result}\033[0m"

            print(f"[{done:>4}/{total}] {u:<20} {status}  ({rps:.1f} rps)")

    out_dir = bots_path.parent
    (out_dir / "valid_accounts.txt").write_text("\n".join(valid), encoding="utf-8")
    (out_dir / "banned_accounts.txt").write_text("\n".join(banned), encoding="utf-8")
    (out_dir / "error_accounts.txt").write_text("\n".join(errors), encoding="utf-8")

    print(f"\nDone in {time.time()-start:.1f}s")
    print(f"  Valid  : {len(valid)}")
    print(f"  Banned : {len(banned)}")
    print(f"  Errors : {len(errors)}")
    print(f"Output written to {out_dir}/")


if __name__ == "__main__":
    main()
