# Source Sheet Headers — as found

Workbook: `1wcqZydjxkeCS5qg16kd6c-5tVQc9jc62pgWKTsuhhog`
Tabs: 7 total. **`Higgs CreatorsGen AI Creators` excluded per instruction.**
Included: Sheet2, Sheet3, Sheet6, Sheet7, Sheet8, Sheet9 — **1,363 data rows**.

## Headers per tab (position → name)

| # | Sheet2 (block A) | Sheet2 (block B, r275-475) | Sheet3 | Sheet6 | Sheet7 | Sheet8 | Sheet9 |
|---|---|---|---|---|---|---|---|
| 0 | Channel Link | Channel Link | **Profile link** | Channel Link | Channel Link | Channel Link | Channel Link |
| 1 | Mail | Mail | **Email ID** | Mail | *(none)* Category | Mail | Mail |
| 2 | Category | Category | Category | Category | Language | Category | Category |
| 3 | **Country** | **Language** | Language | Language | Country | Language | Language |
| 4 | **Subscribers** | **Country** | Country | Country | Subscribers | Country | Country |
| 5 | **Platform** | **Subscribers** | **Followers** | Subscribers | Platform | Subscribers | Subscribers |
| 6 | Deliverables | Platform | Platform | Platform | Deliverables | Platform | Platform |
| 7 | Commercials | Deliverables | Deliverables | Deliverables | Commercials ( $ ) | **Commercials** | Deliverables |
| 8 | — | **Commercials (empty)** | **Rate** | Commercials | — | **Deliverables** | Commercials |

Notes:
- **Sheet7 has no email column at all.**
- **Sheet8 swaps** Commercials (7) and Deliverables (8) relative to Sheet6/Sheet9.
- **Sheet3 uses `Profile link` / `Email ID` / `Followers` / `Rate`** — the only tab with `Rate`.

## Structural problems found (not visible from row 1)

1. **Sheet2 contains two different layouts.** Rows 2–274 have 8 columns (no Language).
   Rows **275–475** (201 rows) insert a **Language** column at position 3, shifting
   Country/Subscribers/Platform right by one. Reading Sheet2 with a single header
   mapping silently loads *country into subscribers* and *subscribers into platform*
   for 181 of those rows. **This block also has zero fee data** (Commercials empty for
   all 201 rows).
2. **Mid-sheet repeat headers.** Sheet6 r488, Sheet8 r59, Sheet9 r95, Sheet2 r189
   restate the header (renamed `Email ID` / `Followers` / `Commercials ( $ )`, plus a
   `Remarks` column in Sheet8). Column *order* is unchanged, so these are droppable rows.
3. **Sheet2 has 44 `Profiles Sent Till Here` marker rows** in column A — droppable.

## Value profile

- **Emails** — 1,204 clean, 1 empty, 6 multi-address (`a@x.com / b@y.com`),
  19 non-email placeholders: `DM` (x15), `WAP`, `sky`, `http://wa.me/+4917610868967`.
  No bare phone numbers found; the intended rule still applies to these placeholders.
- **Subscribers** — `123k` (1135), `1.2M` (16), plain number (8), `40.3L` (lakh, 1).
  Remaining 181 "other" values are the Sheet2 shift artifact above, not real data.
- **Platform** — Instagram 883, YouTube 267 (3 casings), TikTok 10, 2 blank.
  The ~30 values that look like `188k` are the same Sheet2 shift artifact.
- **Category** — 421 distinct raw values, comma/slash separated.
- **Commercials** — 1,362 non-empty. Formats seen:
  `$3000` · `3000.0` · `$1,890 USD.` · `INR 24,000` · `INR 35k` · `£175` · `€4,000`
  · `850 euro` · `750 EURO` · `180€ EURO` · `£1500 GBP` · `$3000 AUD` · `1Lakhs INR`
  · `INR 1.2L` · `INR 4L+GST` · `£3.5k+ VAT` · `$270 + PayPal fee`
  · `$3000 AUD + GST + 15% Agency` · `£400 GBP to £500 GBP` (range)
  · **355 multi-value**: `$300/ $600`, `$250, $230 (per video), $200 (per video)`,
    `$399/ $649/ $1,149`, `€4,000 | €2,000/video`
