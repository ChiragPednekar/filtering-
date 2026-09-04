/**
 * Row-level repairs for values the sheet puts in the wrong place or fills with a
 * placeholder. Mirrored in etl.py — keep the two in step, and re-run the parity test
 * in ../_tests/sync_sheet_test.ts after changing either.
 */

/** Values that mean "we don't know", not a real answer. */
const PLACEHOLDERS = new Set([
  'not shared', 'notshared', 'not share', 'n/a', 'na', 'n.a.', '-', '--',
  'unknown', 'not mentioned', 'not mention', 'none', 'nil', 'tbd', 'tba', '?',
])

export function nullIfPlaceholder(value: string | null | undefined): string | null {
  const v = (value ?? '').trim()
  if (!v) return null
  return PLACEHOLDERS.has(v.toLowerCase()) ? null : v
}

/** Languages seen in these sheets, plus the obvious others. */
const LANGUAGES = new Set([
  'english', 'spanish', 'german', 'french', 'portuguese', 'italian', 'dutch',
  'arabic', 'hindi', 'punjabi', 'urdu', 'bengali', 'tamil', 'telugu', 'marathi',
  'gujarati', 'malayalam', 'kannada', 'russian', 'polish', 'turkish', 'greek',
  'swedish', 'norwegian', 'danish', 'finnish', 'czech', 'romanian', 'hungarian',
  'ukrainian', 'hebrew', 'persian', 'farsi', 'thai', 'vietnamese', 'indonesian',
  'malay', 'filipino', 'tagalog', 'japanese', 'korean', 'chinese', 'mandarin',
  'cantonese', 'swahili', 'afrikaans', 'serbian', 'croatian', 'bulgarian',
  'slovak', 'slovenian', 'lithuanian', 'latvian', 'estonian', 'catalan',
])

/** Country and region names that show up in a "Category" cell by mistake. */
const COUNTRIES = new Set([
  'usa', 'us', 'u.s.', 'u.s.a.', 'united states', 'united states of america',
  'uk', 'u.k.', 'united kingdom', 'england', 'scotland', 'wales', 'ireland',
  'canada', 'australia', 'new zealand', 'india', 'pakistan', 'bangladesh',
  'sri lanka', 'nepal', 'germany', 'france', 'spain', 'italy', 'portugal',
  'netherlands', 'belgium', 'switzerland', 'austria', 'sweden', 'norway',
  'denmark', 'finland', 'poland', 'czech republic', 'czechia', 'slovakia',
  'hungary', 'romania', 'bulgaria', 'greece', 'turkey', 'russia', 'ukraine',
  'serbia', 'croatia', 'slovenia', 'lithuania', 'latvia', 'estonia', 'cyprus',
  'malta', 'iceland', 'luxembourg', 'uae', 'u.a.e.', 'united arab emirates',
  'dubai', 'abu dhabi', 'saudi arabia', 'qatar', 'kuwait', 'bahrain', 'oman',
  'jordan', 'lebanon', 'egypt', 'morocco', 'tunisia', 'algeria', 'nigeria',
  'ghana', 'kenya', 'south africa', 'ethiopia', 'uganda', 'tanzania',
  'brazil', 'argentina', 'chile', 'colombia', 'peru', 'mexico', 'venezuela',
  'ecuador', 'uruguay', 'paraguay', 'bolivia', 'panama', 'costa rica',
  'guatemala', 'dominican republic', 'puerto rico', 'jamaica', 'trinidad',
  'china', 'japan', 'south korea', 'korea', 'taiwan', 'hong kong', 'singapore',
  'malaysia', 'indonesia', 'thailand', 'vietnam', 'philippines', 'cambodia',
  'myanmar', 'kazakhstan', 'uzbekistan', 'kyrgyzstan', 'kyrgyztan', 'georgia',
  'armenia', 'azerbaijan', 'israel', 'palestine', 'iraq', 'iran', 'afghanistan',
])

const isLanguage = (v: string | null) => Boolean(v) && LANGUAGES.has(v!.trim().toLowerCase())
const isCountry = (v: string | null) => Boolean(v) && COUNTRIES.has(v!.trim().toLowerCase())

export interface GeoFields {
  category: string
  language: string | null
  country: string | null
}

export interface GeoRepair extends GeoFields {
  note: string | null
}

/**
 * Some rows have Category / Language / Country filled in the wrong order — Sheet8
 * rows 55-56 hold "Canada", "Graphic Desinger", "English" in those three columns.
 * Reading them literally files a country as a category and a language as a country,
 * which then pollutes every filter dropdown.
 *
 * Only rearranges when the values clearly identify themselves, so a genuine category
 * like "Tech" is never moved.
 */
export function repairGeoFields(raw: GeoFields): GeoRepair {
  const category = (raw.category ?? '').trim()
  const language = nullIfPlaceholder(raw.language)
  const country = nullIfPlaceholder(raw.country)

  // Three-way rotation: category holds a country, country holds a language.
  if (isCountry(category) && isLanguage(country) && !isLanguage(language)) {
    return {
      category: language ?? '',
      language: country,
      country: category,
      note: 'geo_rotated_category_language_country',
    }
  }

  // Straight swap: the language and country columns are the wrong way round.
  if (isLanguage(country) && isCountry(language)) {
    return {
      category,
      language: country,
      country: language,
      note: 'geo_swapped_language_country',
    }
  }

  return { category, language, country, note: null }
}

/**
 * A fee cell that holds deliverables text instead of a price (Sheet9 row 15 reads
 * "1 Instagram Reel + link in bio for 7 days"). Left alone the creator shows no fee
 * and the text is stranded in the wrong column.
 */
const DELIVERABLE_WORDS =
  /\b(reel|video|post|story|stories|short|shorts|integration|integrated|dedicated|carousel|collab|link in bio|usage rights|repost|tiktok|youtube|instagram)\b/i

export function looksLikeDeliverables(text: string | null | undefined): boolean {
  const v = (text ?? '').trim()
  if (!v) return false
  // A price would have a currency marker or be mostly digits.
  if (/[$€£₹]/.test(v)) return false
  if (/^\d[\d,. ]*$/.test(v)) return false
  return DELIVERABLE_WORDS.test(v)
}
