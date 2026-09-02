/**
 * Runs the Edge Function's sheet reader against the real workbook and diffs the
 * result against the Python ETL's output. The two pipelines must agree, otherwise a
 * sync would silently rewrite rows the ETL produced.
 *
 *   deno run --allow-read --allow-net local_test.ts
 */
import { readWorkbook } from '../sync-sheet/sheet.ts'

const fxRaw = JSON.parse(await Deno.readTextFile('../../../out/fx_rates.json'))
const fx = { usdPerUnit: fxRaw.usd_per_unit as Record<string, number>, asOf: '2026-09-02' }

const bytes = await Deno.readFile('../../../data/workbook_fresh.xlsx')
const { rows, tabs, stats } = await readWorkbook(bytes.buffer as ArrayBuffer, fx)

console.log('tabs synced :', tabs.join(', '))
console.log('stats       :', stats)
console.log('rows        :', rows.length)

const etl = JSON.parse(await Deno.readTextFile('../../../out/creators_usd.json')) as Record<
  string,
  unknown
>[]

const key = (r: Record<string, unknown>) =>
  `${r.channel_link}|${r.source_sheet}|${r.variant_no}`
const E = new Map(etl.map((r) => [key(r), r]))
const F = new Map(rows.map((r) => [key(r as unknown as Record<string, unknown>), r]))

const missing = [...E.keys()].filter((k) => !F.has(k))
const extra = [...F.keys()].filter((k) => !E.has(k))
console.log(`\nin ETL but not in function : ${missing.length}`)
missing.slice(0, 8).forEach((k) => console.log('   -', k))
console.log(`in function but not in ETL : ${extra.length}`)
extra.slice(0, 8).forEach((k) => console.log('   +', k))

const FIELDS = [
  'mail', 'country', 'language', 'platform', 'subscribers', 'followers',
  'deliverables', 'commercials', 'commercials_amount', 'commercials_currency',
  'commercials_amount_native', 'commercials_currency_native',
]

let mismatches = 0
const shown: string[] = []
for (const [k, e] of E) {
  const f = F.get(k) as unknown as Record<string, unknown> | undefined
  if (!f) continue
  for (const field of FIELDS) {
    const a = e[field] ?? null
    const b = f[field] ?? null
    const same =
      typeof a === 'number' && typeof b === 'number'
        ? Math.abs(a - b) < 0.011
        : String(a) === String(b)
    if (!same) {
      mismatches++
      if (shown.length < 10) shown.push(`   ${k} :: ${field}  ETL=${a}  fn=${b}`)
    }
  }
  const ca = ((e.category as string[]) ?? []).slice().sort().join('|')
  const cb = ((f.category as string[]) ?? []).slice().sort().join('|')
  if (ca !== cb) {
    mismatches++
    if (shown.length < 10) shown.push(`   ${k} :: category  ETL=${ca}  fn=${cb}`)
  }
}
console.log(`\nfield mismatches           : ${mismatches}`)
shown.forEach((s) => console.log(s))

const ok = missing.length === 0 && extra.length === 0 && mismatches === 0
console.log(
  `\n${ok ? 'MATCH — the Edge Function reproduces the ETL exactly.' : 'DIVERGENCE (above)'}`,
)
if (!ok) Deno.exit(1)
