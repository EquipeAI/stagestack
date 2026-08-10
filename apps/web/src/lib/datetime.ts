import { DateTime, Settings } from 'luxon'

// Event time is authoritative and always labelled with its zone
// (design system: "State the timezone").

// Month and day names, and the digits themselves, are locale-dependent. The
// public pages are server-rendered, so a visitor whose browser locale is not
// the server's would hydrate onto different text — the copy is English, so the
// formatting is pinned to English everywhere, on both sides of the render.
export const DATE_LOCALE = 'en'
Settings.defaultLocale = DATE_LOCALE

/** Every DateTime this module builds is zone- and locale-pinned. */
function at(ms: number, zone: string) {
  return DateTime.fromMillis(ms, { zone, locale: DATE_LOCALE })
}

const FALLBACK_ZONES = [
  'UTC',
  'America/Los_Angeles',
  'America/Denver',
  'America/Chicago',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/London',
  'Europe/Berlin',
  'Europe/Lisbon',
  'Asia/Tokyo',
  'Australia/Sydney',
]

export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

let cachedZones: Array<string> | null = null

/** Every IANA zone the runtime knows, with the browser's zone hoisted first. */
export function timezoneOptions(current?: string): Array<string> {
  if (cachedZones === null) {
    const supported = (
      Intl as unknown as { supportedValuesOf?: (key: string) => Array<string> }
    ).supportedValuesOf
    cachedZones =
      typeof supported === 'function'
        ? supported.call(Intl, 'timeZone')
        : FALLBACK_ZONES
  }
  const zones = cachedZones
  const head = [browserTimezone(), current].filter(
    (z): z is string => typeof z === 'string' && z.length > 0,
  )
  const seen = new Set<string>()
  return [...head, ...zones].filter((z) => {
    if (seen.has(z)) return false
    seen.add(z)
    return true
  })
}

/** Epoch ms → the wall-clock string an <input type="datetime-local"> wants. */
export function toInputValue(ms: number | undefined | null, zone: string) {
  if (ms === undefined || ms === null) return ''
  const dt = at(ms, zone)
  return dt.isValid ? dt.toFormat("yyyy-MM-dd'T'HH:mm") : ''
}

/** Wall-clock string in `zone` → epoch ms. Null when the field is unusable.
 *
 * The happy path is the ISO-ish `yyyy-MM-ddTHH:mm` a real browser puts in a
 * datetime-local input — but automation drivers (and some webviews) deliver
 * localized strings to the controlled state instead, so fall through common
 * localized shapes before giving up. */
export function fromInputValue(value: string, zone: string): number | null {
  const raw = value.trim()
  if (!raw) return null
  const iso = DateTime.fromISO(raw, { zone, locale: DATE_LOCALE })
  if (iso.isValid) return iso.toMillis()
  const formats = [
    "yyyy-MM-dd HH:mm", // ISO with the T dropped
    'M/d/yyyy, h:mm a', // en-US datetime-local display shape
    'M/d/yyyy h:mm a',
    'MM/dd/yyyy HH:mm',
    'dd/MM/yyyy HH:mm', // day-first locales
    'dd/MM/yyyy, HH:mm',
    'd.M.yyyy HH:mm',
    'yyyy/MM/dd HH:mm',
  ]
  for (const format of formats) {
    const dt = DateTime.fromFormat(raw, format, { zone })
    if (dt.isValid) return dt.toMillis()
  }
  // Last resort: whatever Date can make of it, re-anchored to `zone` keeping
  // the wall-clock fields the driver intended.
  const parsed = new Date(raw)
  if (!Number.isNaN(parsed.getTime())) {
    const dt = DateTime.fromObject(
      {
        year: parsed.getFullYear(),
        month: parsed.getMonth() + 1,
        day: parsed.getDate(),
        hour: parsed.getHours(),
        minute: parsed.getMinutes(),
      },
      { zone },
    )
    if (dt.isValid) return dt.toMillis()
  }
  return null
}

export function formatDateTime(ms: number, zone: string) {
  const dt = at(ms, zone)
  return dt.isValid ? dt.toFormat('d LLL yyyy, HH:mm ZZZZ') : '—'
}

/** "14–16 Apr 2026" · "14 Apr 2026, 09:00–17:00" — always in the event zone. */
export function formatDateRange(startsAt: number, endsAt: number, zone: string) {
  const start = at(startsAt, zone)
  const end = at(endsAt, zone)
  if (!start.isValid || !end.isValid) return '—'
  if (start.hasSame(end, 'day')) {
    return `${start.toFormat('d LLL yyyy')}, ${start.toFormat('HH:mm')}–${end.toFormat('HH:mm')}`
  }
  if (start.hasSame(end, 'year')) {
    const sameMonth = start.hasSame(end, 'month')
    return `${start.toFormat(sameMonth ? 'd' : 'd LLL')}–${end.toFormat('d LLL yyyy')}`
  }
  return `${start.toFormat('d LLL yyyy')} – ${end.toFormat('d LLL yyyy')}`
}
