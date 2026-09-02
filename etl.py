#!/usr/bin/env python3
"""
Google Sheets -> unified `creators` table ETL.

Reads every tab of the source workbook (except the excluded one), maps each tab's
messy columns onto one canonical schema, parses fees into amount+currency, splits
categories into arrays, and upserts into Supabase on (channel_link, source_sheet,
variant_no).

Usage:
    python etl.py                 # fetch sheet, clean, write out/creators.json
    python etl.py --upsert        # ...and push to Supabase
    python etl.py --local FILE    # use an already-downloaded .xlsx instead of fetching
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict

import openpyxl

# --------------------------------------------------------------------------
# Source configuration
# --------------------------------------------------------------------------

SHEET_ID = os.environ.get(
    "SHEET_ID", "1wcqZydjxkeCS5qg16kd6c-5tVQc9jc62pgWKTsuhhog"
)
EXPORT_URL = f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/export?format=xlsx"

# Tabs to skip entirely.
EXCLUDED_TABS = {"Higgs CreatorsGen AI Creators"}

# Column position -> canonical field, per tab. Positions are 0-indexed and are the
# authority here: several tabs restate their header mid-sheet under different names
# ("Email ID" for "Mail", "Followers" for "Subscribers") without changing the order.
LAYOUTS = {
    "default_8col": {  # Channel Link, Mail, Category, Country, Subs, Platform, Deliv, Comm
        "channel_link": 0, "mail": 1, "category": 2, "country": 3,
        "audience": 4, "platform": 5, "deliverables": 6, "commercials": 7,
    },
    "default_9col": {  # ...with Language inserted at position 3
        "channel_link": 0, "mail": 1, "category": 2, "language": 3, "country": 4,
        "audience": 5, "platform": 6, "deliverables": 7, "commercials": 8,
    },
    "swapped_comm_deliv": {  # Sheet8: Commercials and Deliverables are swapped
        "channel_link": 0, "mail": 1, "category": 2, "language": 3, "country": 4,
        "audience": 5, "platform": 6, "commercials": 7, "deliverables": 8,
    },
    "no_email": {  # Sheet7: no email column at all
        "channel_link": 0, "category": 1, "language": 2, "country": 3,
        "audience": 4, "platform": 5, "deliverables": 6, "commercials": 7,
    },
    "sheet3": {  # Profile link, Email ID, Category, Language, Country, Followers,
                 # Platform, Deliverables, Rate  -- "Rate" is this tab's word for the fee
        "channel_link": 0, "mail": 1, "category": 2, "language": 3, "country": 4,
        "audience": 5, "platform": 6, "deliverables": 7, "commercials": 8,
    },
}

TAB_LAYOUTS = {
    "Sheet2": "default_8col",   # but see SHEET2_BLOCK_B below
    "Sheet3": "sheet3",
    "Sheet6": "default_9col",
    "Sheet7": "no_email",
    "Sheet8": "swapped_comm_deliv",
    "Sheet9": "default_9col",
}

# Sheet2 is really two stacked tables. Rows in this 1-indexed range carry an extra
# Language column, shifting Country/Subscribers/Platform one place right. Reading the
# whole tab with one mapping loads country into subscribers for every row in here.
SHEET2_BLOCK_B = (275, 475)

# Rows to drop outright.
REPEAT_HEADER_FIRST_CELLS = {"channel link", "profile link"}
MARKER_ROW_PREFIXES = ("profiles sent",)

# --------------------------------------------------------------------------
# Parsers
# --------------------------------------------------------------------------

CURRENCY_SYMBOLS = {"$": "USD", "€": "EUR", "£": "GBP", "₹": "INR"}
CURRENCY_WORDS = {
    "INR": "INR", "RS": "INR", "RUPEE": "INR", "RUPEES": "INR",
    "USD": "USD", "DOLLAR": "USD", "DOLLARS": "USD",
    "EUR": "EUR", "EURO": "EUR", "EUROS": "EUR",
    "GBP": "GBP", "POUND": "GBP", "POUNDS": "GBP",
    "AED": "AED", "CAD": "CAD", "AUD": "AUD", "SGD": "SGD",
    "BHD": "BHD",
    "SAR": "SAR",
    "QAR": "QAR",
    "KWD": "KWD",
    "OMR": "OMR",
    "CHF": "CHF",
    "SEK": "SEK",
    "NOK": "NOK",
    "DKK": "DKK",
    "PLN": "PLN",
    "ZAR": "ZAR",
    "NZD": "NZD",
    "JPY": "JPY",
    "BRL": "BRL",
    "MXN": "MXN",
    "PHP": "PHP",
    "IDR": "IDR",
    "MYR": "MYR",
    "THB": "THB",
    "TRY": "TRY",
    "PKR": "PKR",
    "BDT": "BDT",
    "LKR": "LKR",
    "NGN": "NGN",
    "KES": "KES",
}
# Fee columns on several tabs are headed "Commercials ( $ )", so a bare number means USD.
DEFAULT_CURRENCY = "USD"

MULTIPLIERS = {
    "k": 1_000, "m": 1_000_000,
    "l": 100_000, "lac": 100_000, "lacs": 100_000,
    "lakh": 100_000, "lakhs": 100_000,
    "cr": 10_000_000, "crore": 10_000_000, "crores": 10_000_000,
}

_CUR_WORD_RE = "|".join(sorted(CURRENCY_WORDS, key=len, reverse=True))
_MULT_RE = "|".join(sorted(MULTIPLIERS, key=len, reverse=True))

MONEY_RE = re.compile(
    rf"(?P<pre>[$€£₹])?\s*"
    rf"(?:(?<![A-Za-z])(?P<precode>{_CUR_WORD_RE})(?![A-Za-z])\s*)?"
    rf"(?P<pre2>[$€£₹])?\s*"
    rf"(?P<num>\d[\d,]*(?:\.\d+)?)\s*"
    rf"(?:(?P<mult>{_MULT_RE})\b)?\s*"
    rf"(?:(?P<post>[$€£₹])|(?<![A-Za-z])(?P<postcode>{_CUR_WORD_RE})(?![A-Za-z]))?",
    re.IGNORECASE,
)

# Numbers that are never a fee: percentages, and counts attached to deliverable nouns.
PERCENT_RE = re.compile(r"\d+(?:\.\d+)?\s*%")
NON_FEE_COUNT_RE = re.compile(
    r"\b\d+\s*(?:x|month|months|day|days|week|weeks|year|years|"
    r"video|videos|reel|reels|post|posts|story|stories|short|shorts)\b",
    re.IGNORECASE,
)

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
PHONEISH_RE = re.compile(r"^[+\d][\d\s\-().]{6,}$")


def parse_money(raw: str, currency_hint: str | None = None):
    """Parse a fee string into (amount, currency, all_parsed, notes).

    `currency_hint` comes from the cell's number format, which is where the sheets
    record the currency for plain numeric cells (3500 shown as "\u00a33,500").

    Handles: '$100', 'INR 24,000', '€450', '1500 Euros', 'INR 65K', '$2,100',
    'INR 4L+GST', '1Lakhs INR', '£400 GBP to £500 GBP', '$300/ $600',
    '$250, $230 (per video)', '$3000 AUD + GST + 15% Agency', '1400.0'.

    Multi-value strings keep every parsed value in `all_parsed`; `amount` is the
    lowest, which is the entry-level rate for the cheapest deliverable.
    """
    notes = {}
    if not raw or not raw.strip():
        return None, None, [], notes

    text = raw.strip()
    scrubbed = PERCENT_RE.sub(" ", text)
    scrubbed = NON_FEE_COUNT_RE.sub(" ", scrubbed)

    # A currency named anywhere in the cell applies to bare numbers within it.
    ambient = None
    for sym, code in CURRENCY_SYMBOLS.items():
        if sym in text:
            ambient = code
            break
    word_hit = re.search(rf"(?<![A-Za-z])({_CUR_WORD_RE})(?![A-Za-z])", text, re.IGNORECASE)
    if word_hit:
        # An explicit code outranks a bare symbol: '$3000 AUD' is AUD, not USD.
        ambient = CURRENCY_WORDS[word_hit.group(1).upper()]
    if ambient is None and currency_hint:
        # Nothing in the text says what currency this is, but the cell format does.
        ambient = currency_hint
        notes["fee_currency_from_cell_format"] = currency_hint

    parsed = []
    for m in MONEY_RE.finditer(scrubbed):
        num = m.group("num")
        if not num:
            continue
        try:
            value = float(num.replace(",", ""))
        except ValueError:
            continue

        mult = (m.group("mult") or "").lower()
        if mult:
            value *= MULTIPLIERS[mult]

        code = None
        for grp in ("pre", "pre2", "post"):
            if m.group(grp):
                code = CURRENCY_SYMBOLS[m.group(grp)]
                break
        for grp in ("precode", "postcode"):
            if m.group(grp):
                code = CURRENCY_WORDS[m.group(grp).upper()]
                break

        explicit = code is not None
        if code is None:
            code = ambient or DEFAULT_CURRENCY

        # A bare number with no currency anywhere and an implausibly small value is
        # almost always a stray count, not a fee.
        if not explicit and ambient is None and value < 20:
            continue

        parsed.append({"amount": value, "currency": code, "explicit": explicit})

    if not parsed:
        if re.search(r"\d", text):
            notes["fee_unparsed"] = text
        else:
            notes["fee_non_numeric"] = text
        return None, None, [], notes

    best = min(parsed, key=lambda p: p["amount"])
    if len(parsed) > 1:
        notes["fee_all_values"] = [
            {"amount": p["amount"], "currency": p["currency"]} for p in parsed
        ]
    if not best["explicit"]:
        notes["fee_currency_inferred"] = best["currency"]
    for kw, label in (("gst", "GST"), ("vat", "VAT"),
                      ("paypal", "PayPal fee"), ("agency", "agency fee")):
        if re.search(kw, text, re.IGNORECASE):
            notes.setdefault("fee_excludes", []).append(label)

    return best["amount"], best["currency"], parsed, notes


def parse_audience(raw: str):
    """'207K' -> 207000, '1.2M' -> 1200000, '40.3L' -> 4030000, '567.0' -> 567."""
    if not raw:
        return None, {}
    text = raw.strip().replace(",", "")
    m = re.fullmatch(rf"(\d+(?:\.\d+)?)\s*({_MULT_RE})?", text, re.IGNORECASE)
    if not m:
        return None, {"audience_unparsed": raw}
    value = float(m.group(1))
    if m.group(2):
        value *= MULTIPLIERS[m.group(2).lower()]
    return int(round(value)), {}


def parse_categories(raw: str):
    """Split on , / | and & into a deduplicated, title-cased array."""
    if not raw:
        return []
    parts = re.split(r"[,/|]|\s+&\s+", raw)
    out, seen = [], set()
    for p in parts:
        c = re.sub(r"\s+", " ", p).strip(" .-")
        if not c:
            continue
        key = c.lower()
        if key not in seen:
            seen.add(key)
            out.append(c)
    return out


def parse_email(raw: str):
    """Return (email, notes). Non-email values (phone numbers, 'DM', handles) yield
    a null email and are preserved in raw_data."""
    notes = {}
    if not raw or not raw.strip():
        return None, notes
    text = raw.strip()
    found = EMAIL_RE.findall(text)
    if not found:
        notes["email_raw_non_email"] = text
        if PHONEISH_RE.match(text) or re.search(r"wa\.me|whatsapp", text, re.IGNORECASE):
            notes["email_raw_kind"] = "phone_or_whatsapp"
        else:
            notes["email_raw_kind"] = "placeholder"
        return None, notes
    if len(found) > 1:
        notes["email_all"] = found
    return found[0].lower(), notes


PLATFORM_PATTERNS = [
    ("YouTube", r"youtube\.com|youtu\.be"),
    ("Instagram", r"instagram\.com"),
    ("TikTok", r"tiktok\.com"),
    ("X", r"(?:twitter|x)\.com"),
    ("LinkedIn", r"linkedin\.com"),
    ("Twitch", r"twitch\.tv"),
    ("Facebook", r"facebook\.com|fb\.com"),
]
PLATFORM_CANON = {
    "youtube": "YouTube", "yt": "YouTube",
    "instagram": "Instagram", "ig": "Instagram",
    "tiktok": "TikTok", "tt": "TikTok",
    "x": "X", "twitter": "X", "linkedin": "LinkedIn",
    "twitch": "Twitch", "facebook": "Facebook",
}


def resolve_platform(explicit: str, url: str):
    """Prefer the URL: a handful of rows carry a subscriber count in the platform cell."""
    for name, pat in PLATFORM_PATTERNS:
        if re.search(pat, url or "", re.IGNORECASE):
            return name, {}
    key = re.sub(r"[^a-z]", "", (explicit or "").lower())
    if key in PLATFORM_CANON:
        return PLATFORM_CANON[key], {}
    if explicit and explicit.strip():
        return explicit.strip(), {"platform_unrecognised": explicit.strip()}
    return None, {}


def creator_name_from_url(url: str):
    """Display name from the profile handle -- the sheets carry no name column."""
    if not url:
        return None
    path = re.sub(r"^https?://[^/]+/?", "", url)
    handle = path.split("/", 1)[0].lstrip("@").strip(" .")
    return handle or None


def normalize_url(raw: str):
    """Canonical form used as the join/upsert key. Returns (canonical, notes)."""
    notes = {}
    if not raw or not raw.strip():
        return None, notes
    text = raw.strip()
    if not re.search(r"https?://|\w+\.\w", text):
        # e.g. 'freeman ai - YouTube' -- a channel name, not a link.
        notes["channel_link_not_a_url"] = text
        return None, notes
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"^https?://", "", text, flags=re.IGNORECASE)
    text = re.sub(r"^www\.", "", text, flags=re.IGNORECASE)
    # Drop query strings and fragments: a profile's identity is its path. YouTube
    # share links carry '?si=<token>', which would otherwise split one creator in two.
    text = re.split(r"[?#]", text, 1)[0]
    text = text.rstrip("/ ")
    if "/" in text:
        host, path = text.split("/", 1)
        text = host.lower() + "/" + path
    else:
        text = text.lower()
    return "https://" + text, notes


# --------------------------------------------------------------------------
# FX
# --------------------------------------------------------------------------

FX_PATH = "out/fx_rates.json"
FX_URL = "https://open.er-api.com/v6/latest/USD"


def load_fx(refresh: bool = False):
    """USD-per-unit rates. Cached in out/fx_rates.json; --refresh-fx re-fetches.

    Fees are stored in USD so one filter means one thing, with the quoted figure kept
    in commercials_amount_native.
    """
    if not refresh and os.path.exists(FX_PATH):
        with open(FX_PATH) as f:
            data = json.load(f)
        print(f"  fx: cached rates as of {data['as_of']}")
        return data

    print(f"  fx: fetching {FX_URL}")
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
    os.makedirs(os.path.dirname(FX_PATH), exist_ok=True)
    with open(FX_PATH, "w") as f:
        json.dump(data, f, indent=2)
    print(f"  fx: {len(rates)} rates as of {data['as_of']}")
    return data


def to_usd(amount, currency, fx):
    """(usd_amount, rate) or (None, None) when the currency is unknown."""
    if amount is None or not currency:
        return None, None
    rate = fx["usd_per_unit"].get(currency.upper())
    if rate is None:
        return None, None
    return round(amount * rate, 2), rate


# --------------------------------------------------------------------------
# Extract
# --------------------------------------------------------------------------

def fetch_workbook(dest="data/workbook.xlsx"):
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    print(f"  fetching {EXPORT_URL}")
    with urllib.request.urlopen(EXPORT_URL) as r:
        data = r.read()
    if not data.startswith(b"PK"):
        raise SystemExit(
            "Downloaded file is not an .xlsx. The sheet is probably not shared "
            "as 'anyone with the link can view'."
        )
    with open(dest, "wb") as f:
        f.write(data)
    print(f"  saved {len(data):,} bytes -> {dest}")
    return dest


def layout_for(tab: str, row_no: int) -> dict:
    if tab == "Sheet2" and SHEET2_BLOCK_B[0] <= row_no <= SHEET2_BLOCK_B[1]:
        return LAYOUTS["default_9col"]
    return LAYOUTS[TAB_LAYOUTS[tab]]


# Currency can live in the cell's number format rather than its text: a cell holding
# the number 3500 formatted as '"£"#,##0' displays as £3,500 and means GBP. Reading
# only the value throws that away and silently turns pounds into dollars.
NUMBER_FORMAT_CURRENCY = (
    ("\u00a3", "GBP"), ("\u20ac", "EUR"), ("\u20b9", "INR"),
    ("$", "USD"), ("AED", "AED"), ("INR", "INR"),
)


def currency_from_format(number_format: str):
    for token, code in NUMBER_FORMAT_CURRENCY:
        if token in (number_format or ""):
            return code
    return None


def cell_text(cell) -> str:
    """Cell value as plain text.

    Whole numbers render without a trailing '.0' -- openpyxl hands back 350.0 where
    the cell holds 350, and the Edge Function's JS reader produces '350'. Matching
    them keeps the two pipelines byte-identical, so a sync never rewrites a row just
    because a different reader loaded it.
    """
    value = cell.value
    if value is None:
        return ""
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    return str(value).strip()


def cell_format_currency(cell):
    """Currency implied by a numeric cell's display format, if any."""
    value = cell.value
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return currency_from_format(getattr(cell, "number_format", "") or "")
    return None


def read_rows(path):
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    records = []
    for ws in wb.worksheets:
        if ws.title in EXCLUDED_TABS:
            print(f"  skip   {ws.title!r} (excluded)")
            continue
        if ws.title not in TAB_LAYOUTS:
            print(f"  WARN   {ws.title!r} has no layout mapping -- skipped")
            continue
        kept = dropped = 0
        for row_no, raw in enumerate(ws.iter_rows(), start=1):
            if row_no == 1:
                continue
            cells = [cell_text(c) for c in raw]
            fmt_currency = [cell_format_currency(c) for c in raw]
            if not any(cells):
                continue
            first = cells[0].lower()
            if first in REPEAT_HEADER_FIRST_CELLS or first.startswith(MARKER_ROW_PREFIXES):
                dropped += 1
                continue
            records.append((ws.title, row_no, cells, layout_for(ws.title, row_no), fmt_currency))
            kept += 1
        print(f"  read   {ws.title!r}: {kept} rows kept, {dropped} header/marker rows dropped")
    return records


# --------------------------------------------------------------------------
# Transform
# --------------------------------------------------------------------------

def transform(records, fx):
    rows = []
    for tab, row_no, cells, layout, fmt_currency in records:
        get = lambda f: (cells[layout[f]] if f in layout and layout[f] < len(cells) else "")

        def format_currency_for(field):
            i = layout.get(field)
            return fmt_currency[i] if i is not None and i < len(fmt_currency) else None

        raw_link = get("channel_link")
        channel_link, link_notes = normalize_url(raw_link)

        platform, plat_notes = resolve_platform(get("platform"), raw_link)
        audience, aud_notes = parse_audience(get("audience"))
        email, mail_notes = parse_email(get("mail"))
        fee_raw = get("commercials")
        fee_hint = format_currency_for("commercials")
        amount, currency, all_fees, fee_notes = parse_money(fee_raw, currency_hint=fee_hint)

        # YouTube reports subscribers; Instagram/TikTok report followers.
        subscribers = followers = None
        if audience is not None:
            if platform == "YouTube":
                subscribers = audience
            elif platform in ("Instagram", "TikTok", "X", "LinkedIn", "Facebook", "Twitch"):
                followers = audience
            else:
                subscribers = audience

        raw_data = {
            "source_tab": tab,
            "source_row": row_no,
            "original": {k: v for k, v in zip(
                sorted(layout, key=layout.get),
                [cells[layout[f]] if layout[f] < len(cells) else ""
                 for f in sorted(layout, key=layout.get)],
            ) if v},
        }
        for notes in (link_notes, plat_notes, aud_notes, mail_notes, fee_notes):
            raw_data.update(notes)
        if all_fees:
            raw_data["fee_parsed"] = [
                {"amount": p["amount"], "currency": p["currency"]} for p in all_fees
            ]

        usd_amount, rate = to_usd(amount, currency, fx)
        if amount is not None and usd_amount is None:
            raw_data["fx_unconvertible_currency"] = currency

        rows.append({
            "channel_link": channel_link,
            "creator_name": creator_name_from_url(channel_link),
            # The as-written URL, kept only where it differs from the canonical form.
            "profile_link": raw_link if raw_link and raw_link != channel_link else None,
            "mail": email,
            "email_id": email,
            "category": parse_categories(get("category")),
            "country": get("country") or None,
            "language": get("language") or None,
            "platform": platform,
            "subscribers": subscribers,
            "followers": followers,
            "deliverables": get("deliverables") or None,
            "commercials": get("commercials") or None,
            # Stored in USD so a single filter means one thing across the table.
            "commercials_amount": usd_amount if usd_amount is not None else amount,
            "commercials_currency": "USD" if usd_amount is not None else currency,
            "commercials_amount_native": amount,
            "commercials_currency_native": currency,
            "fx_rate": rate,
            "fx_rate_date": fx["as_of"][:16] if rate else None,
            "source_sheet": tab,
            "raw_data": raw_data,
        })
    return rows


# Fields that define a row's identity. Provenance (profile_link, raw_data) and
# FX-derived values are excluded, so a rate refresh never renumbers variants.
# The Edge Function uses the same list, in this order.
FINGERPRINT_FIELDS = (
    "channel_link", "source_sheet", "mail", "category", "country", "language",
    "platform", "subscribers", "followers", "deliverables", "commercials",
    "commercials_amount_native", "commercials_currency_native",
)


def dedupe(rows):
    """Collapse byte-identical repeats, then number the genuine variants.

    Some creators appear more than once inside one tab with different packages
    (e.g. an integration price row and a dedicated-video price row). Those are real
    and must survive, so they get distinct variant_no values. variant_no is assigned
    by content hash, not row order, so re-running after the sheet is reordered maps
    each record back to the same row.
    """
    groups = defaultdict(list)
    skipped = []
    for r in rows:
        if not r["channel_link"]:
            skipped.append(r)
            continue
        groups[(r["channel_link"], r["source_sheet"])].append(r)

    def fingerprint(r):
        """Identity of a row's *content*, computed identically in Python and in the
        Edge Function's TypeScript.

        JSON serialisation differs between the two languages, so hashing a JSON dump
        gives different digests and therefore different variant_no ordering -- the two
        pipelines would then rewrite each other's rows on every sync. This builds an
        explicit canonical string instead: fixed field order, fixed separator, numbers
        rendered without trailing zeros. See FINGERPRINT_FIELDS in sheet.ts.
        """
        parts = []
        for f in FINGERPRINT_FIELDS:
            v = r.get(f)
            if v is None:
                parts.append("")
            elif isinstance(v, list):
                parts.append(",".join(str(x) for x in v))
            elif isinstance(v, float):
                parts.append(str(int(v)) if v.is_integer() else repr(round(v, 4)))
            else:
                parts.append(str(v))
        return hashlib.sha1("\x1f".join(parts).encode()).hexdigest()

    out, exact_dupes = [], 0
    for (link, tab), members in groups.items():
        by_fp = {}
        for m in members:
            fp = fingerprint(m)
            if fp in by_fp:
                exact_dupes += 1
                by_fp[fp]["raw_data"].setdefault("duplicate_source_rows", []).append(
                    m["raw_data"]["source_row"]
                )
            else:
                by_fp[fp] = m
        for i, (fp, m) in enumerate(sorted(by_fp.items()), start=1):
            m["variant_no"] = i
            m["row_fingerprint"] = fp[:16]
            if len(by_fp) > 1:
                m["raw_data"]["variant_of"] = len(by_fp)
            out.append(m)
    return out, exact_dupes, skipped


# --------------------------------------------------------------------------
# Load
# --------------------------------------------------------------------------

def upsert(rows, batch=250):
    url = os.environ.get("SUPABASE_URL")
    key = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
    if not url or not key:
        raise SystemExit(
            "Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (see README.md).\n"
            "The service role key bypasses RLS -- keep it out of git and out of any client."
        )
    endpoint = url.rstrip("/") + "/rest/v1/creators?on_conflict=channel_link,source_sheet,variant_no"
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    sent = 0
    for i in range(0, len(rows), batch):
        chunk = rows[i:i + batch]
        req = urllib.request.Request(
            endpoint, data=json.dumps(chunk, default=str).encode(),
            headers=headers, method="POST",
        )
        try:
            with urllib.request.urlopen(req) as resp:
                resp.read()
        except urllib.error.HTTPError as e:
            sys.exit(f"Upsert failed on batch {i // batch + 1}: "
                     f"{e.code} {e.read().decode()[:600]}")
        sent += len(chunk)
        print(f"  upserted {sent}/{len(rows)}")
    return sent


def report(rows, exact_dupes, skipped):
    n = len(rows)
    have = lambda f: sum(1 for r in rows if r[f] not in (None, [], ""))
    print("\n" + "=" * 62)
    print(f"  rows loaded            {n}")
    print(f"  byte-identical dropped {exact_dupes}")
    print(f"  no usable URL (held)   {len(skipped)}")
    print("-" * 62)
    for f in ("mail", "category", "country", "language", "platform",
              "subscribers", "followers", "deliverables", "commercials",
              "commercials_amount", "commercials_currency"):
        print(f"  {f:22} {have(f):5}  ({have(f) * 100 // n if n else 0}%)")
    print("-" * 62)
    cur = defaultdict(int)
    for r in rows:
        if r["commercials_currency"]:
            cur[r["commercials_currency"]] += 1
    print("  currencies:", dict(sorted(cur.items(), key=lambda x: -x[1])))
    plat = defaultdict(int)
    for r in rows:
        plat[r["platform"] or "(none)"] += 1
    print("  platforms: ", dict(sorted(plat.items(), key=lambda x: -x[1])))
    native = defaultdict(int)
    for r in rows:
        if r["commercials_currency_native"]:
            native[r["commercials_currency_native"]] += 1
    print("  quoted in:", dict(sorted(native.items(), key=lambda x: -x[1])))
    bad_fx = [r for r in rows if r["raw_data"].get("fx_unconvertible_currency")]
    print(f"  fees with no FX rate available: {len(bad_fx)}")
    unparsed = [r for r in rows if r["raw_data"].get("fee_unparsed")]
    nonmail = [r for r in rows if r["raw_data"].get("email_raw_non_email")]
    print(f"  fees present but unparsed: {len(unparsed)}")
    print(f"  non-email values held in raw_data: {len(nonmail)}")
    print("=" * 62)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--upsert", action="store_true", help="push to Supabase")
    ap.add_argument("--local", metavar="FILE", help="use a local .xlsx, skip fetching")
    ap.add_argument("--out", default="out/creators.json")
    ap.add_argument("--refresh-fx", action="store_true",
                    help="re-fetch exchange rates instead of using the cached file")
    args = ap.parse_args()

    print("1. extract")
    path = args.local or fetch_workbook()
    records = read_rows(path)

    print("\n2. transform")
    fx = load_fx(refresh=args.refresh_fx)
    rows = transform(records, fx)
    rows, exact_dupes, skipped = dedupe(rows)
    print(f"  {len(rows)} records after dedupe")

    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(rows, f, indent=2, default=str)
    print(f"  wrote {args.out}")
    if skipped:
        held = args.out.replace(".json", "_no_url.json")
        with open(held, "w") as f:
            json.dump(skipped, f, indent=2, default=str)
        print(f"  wrote {held}  ({len(skipped)} rows with no usable URL)")

    report(rows, exact_dupes, skipped)

    if args.upsert:
        print("\n3. load")
        upsert(rows)
        print("  done")
    else:
        print("\n(dry run -- pass --upsert to write to Supabase)")


if __name__ == "__main__":
    main()
