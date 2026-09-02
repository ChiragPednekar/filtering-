#!/usr/bin/env python3
"""
Refresh exchange rates and re-convert every stored fee to USD.

Fees live in `creators.commercials_amount` as USD, converted from the quoted figure in
`commercials_amount_native`. Rates drift, so re-run this when the numbers matter:

    python refresh_fx.py            # show what would change, touch nothing
    python refresh_fx.py --apply    # fetch rates, update fx_rates, re-convert fees

Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see README.md). The native figures
are never modified, so re-converting is always safe and repeatable.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request

FX_URL = "https://open.er-api.com/v6/latest/USD"
FX_CACHE = "out/fx_rates.json"


def fetch_rates():
    print(f"fetching {FX_URL}")
    with urllib.request.urlopen(FX_URL, timeout=30) as r:
        payload = json.loads(r.read())
    if payload.get("result") != "success":
        raise SystemExit(f"FX fetch failed: {payload}")
    rates = {c: round(1.0 / v, 10) for c, v in payload["rates"].items() if v}
    data = {
        "as_of": payload["time_last_update_utc"],
        "source": payload["provider"],
        "usd_per_unit": rates,
    }
    os.makedirs(os.path.dirname(FX_CACHE), exist_ok=True)
    with open(FX_CACHE, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  {len(rates)} rates as of {data['as_of']}")
    return data


def supabase(path, method="GET", body=None, prefer=None):
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see README.md).")
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    if prefer:
        headers["Prefer"] = prefer
    req = urllib.request.Request(
        url.rstrip("/") + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{method} {path} -> {e.code} {e.read().decode()[:500]}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write the new rates and re-convert")
    args = ap.parse_args()

    data = fetch_rates()
    rates = data["usd_per_unit"]
    as_of = data["as_of"]

    current = supabase("/rest/v1/fx_rates?select=currency,usd_per_unit,as_of") or []
    old = {r["currency"]: float(r["usd_per_unit"]) for r in current}

    used = supabase(
        "/rest/v1/creators?select=commercials_currency_native"
        "&commercials_currency_native=not.is.null"
    ) or []
    in_use = sorted({r["commercials_currency_native"] for r in used})

    print(f"\ncurrencies in use: {', '.join(in_use)}")
    print(f"{'ccy':<6}{'old':>16}{'new':>16}{'change':>10}")
    for c in in_use:
        new = rates.get(c)
        if new is None:
            print(f"{c:<6}{'-':>16}{'NO RATE':>16}")
            continue
        o = old.get(c)
        delta = f"{(new - o) / o * 100:+.2f}%" if o else "new"
        print(f"{c:<6}{(f'{o:.6f}' if o else '-'):>16}{new:>16.6f}{delta:>10}")

    missing = [c for c in in_use if c not in rates]
    if missing:
        print(f"\nWARNING: no rate for {missing}; those fees keep their current USD value.")

    if not args.apply:
        print("\nDry run. Re-run with --apply to write these rates and re-convert fees.")
        return

    rows = [
        {"currency": c, "usd_per_unit": v, "as_of": as_of[:16], "source": data["source"]}
        for c, v in rates.items()
    ]
    # as_of arrives as an RFC-1123 string; Postgres parses it into a date on insert.
    for r in rows:
        r["as_of"] = None
    supabase(
        "/rest/v1/fx_rates?on_conflict=currency",
        method="POST",
        body=[{**r, "as_of": as_of[5:16]} for r in rows],
        prefer="resolution=merge-duplicates,return=minimal",
    )
    print(f"\nupserted {len(rows)} rates")
    print(
        "\nNow re-convert the stored fees by running this SQL "
        "(Supabase SQL editor, or psql):\n\n"
        "  update public.creators c\n"
        "  set commercials_amount = round(c.commercials_amount_native * r.usd_per_unit, 2),\n"
        "      commercials_currency = 'USD',\n"
        "      fx_rate = r.usd_per_unit,\n"
        "      fx_rate_date = r.as_of,\n"
        "      updated_at = now()\n"
        "  from public.fx_rates r\n"
        "  where r.currency = c.commercials_currency_native\n"
        "    and c.commercials_amount_native is not null;\n"
    )


if __name__ == "__main__":
    sys.exit(main())
