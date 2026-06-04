#!/usr/bin/env python3
"""
Fetch the full HYPE option chain from Derive's public API and write a static
snapshot to data/chain.json.

Why this exists: Derive's API (api.lyra.finance) does NOT send an
Access-Control-Allow-Origin header, so a browser on a public origin (GitHub
Pages) cannot fetch it directly — the request is blocked by CORS. This script
runs server-side (in GitHub Actions, or locally), where CORS does not apply,
and emits a same-origin JSON file the dashboard can read freely.

Stdlib only (urllib) — no pip installs. Stores raw get_tickers responses so the
decoding logic stays in the (tested) JS client.
"""

import json
import re
import sys
import time
import urllib.request
import urllib.error
from pathlib import Path

BASE_URL = "https://api.lyra.finance"
CURRENCY = "HYPE"
OUT_PATH = Path(__file__).resolve().parent.parent / "data" / "chain.json"

NAME_RE = re.compile(r"^([A-Z0-9]+)-(\d{8})-([\d.]+)-([CP])$")


def post(path, body, retries=3):
    """POST JSON to the Derive public API and return the `result` field."""
    data = json.dumps(body).encode("utf-8")
    last_err = None
    for attempt in range(retries):
        req = urllib.request.Request(
            f"{BASE_URL}{path}",
            data=data,
            headers={
                "Content-Type": "application/json",
                "Accept": "application/json",
                # The API's WAF 403s the default Python-urllib UA; send a normal one.
                "User-Agent": "hype-options-dashboard/1.0 (+https://github.com/jothamteo/hype-options-dashboard)",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                env = json.loads(resp.read().decode("utf-8"))
            if env.get("error"):
                raise RuntimeError(f"API error: {env['error']}")
            return env["result"]
        except (urllib.error.URLError, TimeoutError, RuntimeError) as e:
            last_err = e
            time.sleep(1.5 * (attempt + 1))
    raise RuntimeError(f"POST {path} failed after {retries} tries: {last_err}")


def expiry_dates():
    """Distinct YYYYMMDD expiry dates for the tracked currency, sorted."""
    result = post(
        "/public/get_instruments",
        {"currency": CURRENCY, "instrument_type": "option", "expired": False},
    )
    insts = result if isinstance(result, list) else result.get("instruments", [])
    dates = set()
    for inst in insts:
        m = NAME_RE.match(inst.get("instrument_name", ""))
        if m:
            dates.add(int(m.group(2)))
    return sorted(dates)


def main():
    dates = expiry_dates()
    if not dates:
        print("ERROR: no live expiries returned", file=sys.stderr)
        sys.exit(1)

    chains = {}
    n_tickers = 0
    for d in dates:
        result = post(
            "/public/get_tickers",
            {"currency": CURRENCY, "instrument_type": "option", "expiry_date": d},
        )
        tickers = (result or {}).get("tickers", {})
        chains[str(d)] = {"tickers": tickers}
        n_tickers += len(tickers)
        time.sleep(0.25)  # be polite to the public endpoint

    snapshot = {
        "schema": 1,
        "currency": CURRENCY,
        "fetchedAt": int(time.time() * 1000),
        "expiries": dates,
        "chains": chains,
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(snapshot, separators=(",", ":")))
    print(f"wrote {OUT_PATH} — {len(dates)} expiries, {n_tickers} tickers, "
          f"{OUT_PATH.stat().st_size} bytes")


if __name__ == "__main__":
    main()
