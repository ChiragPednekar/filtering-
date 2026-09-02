/**
 * Verifies the browser-side upload pipeline against the real source workbook:
 * the same cleaning the Python ETL does must happen here too.
 *
 * Run:  npm run test:upload
 */
import { readFileSync } from 'node:fs'
import { autoMapHeaders, mapRows, parseFile, type ParsedSheet } from '../services/uploadService'
import { parseMoney, parseAudience, parseCategories, parseEmail, normalizeUrl } from '../lib/parsing'

let failures = 0

function check(label: string, actual: unknown, expected: unknown) {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  const ok = a === e
  if (!ok) failures++
  console.log(`${ok ? '  ok  ' : '  FAIL'} ${label.padEnd(46)} ${a}${ok ? '' : `  expected ${e}`}`)
}

async function main() {
  console.log('\n--- money parsing (cases from the spec + real sheet values) ---')
  const moneyCases: [string, number | null, string | null][] = [
    ['INR 24000', 24000, 'INR'],
    ['$100', 100, 'USD'],
    ['€450', 450, 'EUR'],
    ['1500 Euros', 1500, 'EUR'],
    ['INR 65K', 65000, 'INR'],
    ['$2,100', 2100, 'USD'],
    ['INR 4L+GST', 400000, 'INR'],
    ['1Lakhs INR', 100000, 'INR'],
    ['4000EUR', 4000, 'EUR'],
    ['£3.5k+ VAT', 3500, 'GBP'],
    ['$3000 AUD + GST + 15% Agency', 3000, 'AUD'],
    ['£400 GBP to £500 GBP', 400, 'GBP'],
    ['$399/ $649/ $1,149', 399, 'USD'],
    ['80 pounds, 350 pounds', 80, 'GBP'],
    ['1400.0', 1400, 'USD'],
    ['180€ EURO', 180, 'EUR'],
    ['1 Dedicated video', null, null],
  ]
  for (const [input, amount, currency] of moneyCases) {
    const r = parseMoney(input)
    check(input, [r.amount, r.currency], [amount, currency])
  }

  console.log('\n--- audience / category / email / url ---')
  check('207K', parseAudience('207K').value, 207000)
  check('1.2M', parseAudience('1.2M').value, 1200000)
  check('40.3L', parseAudience('40.3L').value, 4030000)
  check('categories split', parseCategories('Ai, Tech / Automation & Design'),
    ['Ai', 'Tech', 'Automation', 'Design'])
  check('multi email keeps first', parseEmail('a@x.com / b@y.com').email, 'a@x.com')
  check('DM -> null email', parseEmail('DM').email, null)
  check('phone -> null email', parseEmail('+44 7700 900123').email, null)
  check('url normalised', normalizeUrl('https://www.instagram.com/iharnoor?').url,
    'https://instagram.com/iharnoor')
  check('bare host normalised', normalizeUrl('www.youtube.com/@x').url, 'https://youtube.com/@x')
  check('name is not a url', normalizeUrl('freeman ai - YouTube').url, null)

  console.log('\n--- full pipeline against the real workbook ---')
  // Exercise the real parseFile path so number-format currency detection is covered.
  const bytes = readFileSync('../data/workbook.xlsx')
  const file = new File([new Uint8Array(bytes)], 'workbook.xlsx')
  const parsed = await parseFile(file)
  const name = 'Sheet8'
  const sheet = parsed.sheets.find((s) => s.name === name) as ParsedSheet
  if (!sheet) throw new Error(`sheet ${name} not found`)
  console.log(`  headers: ${JSON.stringify(sheet.headers)}`)

  const mapping = autoMapHeaders(sheet.headers)
  console.log(`  auto-map: ${JSON.stringify(
    Object.fromEntries(Object.entries(mapping).filter(([, v]) => v)
      .map(([i, v]) => [sheet.headers[Number(i)], v])),
  )}`)

  const result = await mapRows(sheet, mapping, name)
  console.log(`  rows in sheet        ${sheet.rows.length}`)
  console.log(`  mapped               ${result.rows.length}`)
  console.log(`  dropped header/blank ${result.droppedRows}`)
  console.log(`  skipped (no url)     ${result.skippedNoUrl}`)
  console.log(`  exact duplicates     ${result.exactDuplicates}`)

  check('every row has a channel_link', result.rows.every((r) => r.channel_link.startsWith('https://')), true)
  check('every row has source_sheet', result.rows.every((r) => r.source_sheet === name), true)
  check('variant_no >= 1', result.rows.every((r) => r.variant_no >= 1), true)
  check('natural key is unique', new Set(
    result.rows.map((r) => `${r.channel_link}|${r.source_sheet}|${r.variant_no}`),
  ).size, result.rows.length)
  check('platform inferred everywhere', result.rows.every((r) => r.platform !== null), true)
  check('fees parsed where present', result.rows.filter(
    (r) => r.commercials && r.commercials_amount === null).length, 0)

  // Sheet8 row 2 holds the number 100 formatted as "£"#,##0. The stored text must
  // stay verbatim while the currency comes from the format.
  const curtix = result.rows.find((r) => r.channel_link.includes('curtixstudio'))
  check('raw fee text kept verbatim', curtix?.commercials, '100')
  check('currency read from cell format', curtix?.commercials_currency, 'GBP')
  check('amount from cell format', curtix?.commercials_amount, 100)

  const fromFormat = result.rows.filter(
    (r) => (r.raw_data as Record<string, unknown>).fee_currency_from_cell_format,
  ).length
  console.log(`  currencies taken from cell format: ${fromFormat}`)

  const sample = result.rows[0]
  console.log(`\n  sample row: ${JSON.stringify({
    channel_link: sample.channel_link,
    category: sample.category,
    platform: sample.platform,
    followers: sample.followers,
    commercials: sample.commercials,
    commercials_amount: sample.commercials_amount,
    commercials_currency: sample.commercials_currency,
  }, null, 2)}`)

  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}\n`)
  process.exit(failures === 0 ? 0 : 1)

}

void main()
