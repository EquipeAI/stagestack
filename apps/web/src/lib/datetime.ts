import { DateTime } from 'luxon'

// Event time is authoritative and always labelled with its zone
// (design system: "State the timezone").

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
  const dt = DateTime.fromMillis(ms, { zone })
  return dt.isValid ? dt.toFormat("yyyy-MM-dd'T'HH:mm") : ''
}

/** Wall-clock string in `zone` → epoch ms. Null when the field is unusable. */
export function fromInputValue(value: string, zone: string): number | null {
  if (!value) return null
  const dt = DateTime.fromISO(value, { zone })
  return dt.isValid ? dt.toMillis() : null
}

export function formatDateTime(ms: number, zone: string) {
  const dt = DateTime.fromMillis(ms, { zone })
  return dt.isValid ? dt.toFormat('d LLL yyyy, HH:mm ZZZZ') : '—'
}

/** "14–16 Apr 2026" · "14 Apr 2026, 09:00–17:00" — always in the event zone. */
export function formatDateRange(startsAt: number, endsAt: number, zone: string) {
  const start = DateTime.fromMillis(startsAt, { zone })
  const end = DateTime.fromMillis(endsAt, { zone })
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
