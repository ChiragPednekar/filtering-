/**
 * Downloading the current filtered list, as CSV or as a printable PDF.
 *
 * Both take the rows the filters actually matched — not just the visible page — so
 * what you download is what the result count says.
 */
import type { Creator } from '../types'

/** Columns in the export, in order. Keep the labels human, not database names. */
const COLUMNS: { header: string; get: (r: Creator) => string }[] = [
  { header: 'Creator', get: (r) => r.creator_name ?? '' },
  { header: 'Profile link', get: (r) => r.channel_link },
  { header: 'Platform', get: (r) => r.platform ?? '' },
  { header: 'Followers', get: (r) => fmtNum(r.followers) },
  { header: 'Subscribers', get: (r) => fmtNum(r.subscribers) },
  { header: 'Country', get: (r) => r.country ?? '' },
  { header: 'Language', get: (r) => r.language ?? '' },
  { header: 'Category', get: (r) => (r.category ?? []).join(', ') },
  { header: 'Fee (USD)', get: (r) => (r.commercials_amount === null ? '' : String(r.commercials_amount)) },
  { header: 'Quoted amount', get: (r) => (r.commercials_amount_native === null ? '' : String(r.commercials_amount_native)) },
  { header: 'Quoted currency', get: (r) => r.commercials_currency_native ?? '' },
  { header: 'Fee (as written)', get: (r) => r.commercials ?? '' },
  { header: 'Deliverables', get: (r) => r.deliverables ?? '' },
  { header: 'Email', get: (r) => r.mail ?? '' },
  { header: 'Source sheet', get: (r) => r.source_sheet },
]

const fmtNum = (n: number | null) => (n === null ? '' : String(n))

/** RFC-4180 quoting: doubles embedded quotes and wraps anything risky. */
function csvCell(value: string): string {
  if (value === '') return ''
  // A leading =, +, - or @ makes Excel treat the cell as a formula. Prefix with a
  // quote so a creator called "=drop" is text, not an expression.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe
}

export function toCsv(rows: Creator[]): string {
  const head = COLUMNS.map((c) => csvCell(c.header)).join(',')
  const body = rows.map((r) => COLUMNS.map((c) => csvCell(c.get(r))).join(','))
  // BOM so Excel opens UTF-8 (₹, £, €) correctly instead of mojibake.
  return '﻿' + [head, ...body].join('\r\n')
}

export function downloadBlob(content: BlobPart, filename: string, mime: string) {
  const url = URL.createObjectURL(new Blob([content], { type: mime }))
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  // Revoke on the next tick; revoking synchronously can cancel the download.
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function timestamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  )

/**
 * A printable page opened in a new window, so the browser's own "Save as PDF" does
 * the rendering. That avoids shipping a PDF library for something the platform
 * already does well, and the result stays selectable and searchable.
 */
export function openPrintablePdf(rows: Creator[], filterSummary: string[]) {
  const cols = ['Creator', 'Profile link', 'Followers', 'Country', 'Fee (USD)', 'Quoted', 'Category']
  const body = rows
    .map((r) => {
      const audience = r.followers ?? r.subscribers
      const quoted =
        r.commercials_currency_native && r.commercials_currency_native !== 'USD'
          ? `${r.commercials_amount_native ?? ''} ${r.commercials_currency_native}`
          : ''
      return `<tr>
        <td>${escapeHtml(r.creator_name ?? '')}</td>
        <td class="link">${escapeHtml(r.channel_link.replace(/^https?:\/\//, ''))}</td>
        <td class="num">${audience === null ? '' : audience.toLocaleString()}</td>
        <td>${escapeHtml(r.country ?? '')}</td>
        <td class="num">${r.commercials_amount === null ? '' : '$' + Number(r.commercials_amount).toLocaleString()}</td>
        <td class="num small">${escapeHtml(quoted)}</td>
        <td class="small">${escapeHtml((r.category ?? []).slice(0, 3).join(', '))}</td>
      </tr>`
    })
    .join('')

  const html = `<!doctype html><html><head><meta charset="utf-8">
<title>Creators export</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  body { font: 11px -apple-system, system-ui, sans-serif; color: #0f172a; margin: 0; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  .meta { color: #64748b; font-size: 11px; margin-bottom: 10px; }
  .meta strong { color: #0f172a; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: .04em;
       color: #475569; border-bottom: 1.5px solid #cbd5e1; padding: 5px 6px; }
  td { padding: 4px 6px; border-bottom: 1px solid #e2e8f0; vertical-align: top; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .link { color: #1d4ed8; word-break: break-all; }
  .small { color: #475569; font-size: 10px; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
</style></head><body>
<h1>Creators export</h1>
<div class="meta"><strong>${rows.length.toLocaleString()}</strong> creators &nbsp;·&nbsp;
  ${escapeHtml(filterSummary.join(' · ') || 'no filters applied')} &nbsp;·&nbsp;
  generated ${new Date().toLocaleString()}</div>
<table><thead><tr>${cols.map((c) => `<th>${c}</th>`).join('')}</tr></thead>
<tbody>${body}</tbody></table>
</body></html>`

  const win = window.open('', '_blank')
  if (!win) {
    throw new Error('The print window was blocked. Allow pop-ups for this page and retry.')
  }
  win.document.write(html)
  win.document.close()
  // Wait for layout before printing, otherwise the dialog can open on a blank page.
  win.onload = () => setTimeout(() => win.print(), 250)
}
