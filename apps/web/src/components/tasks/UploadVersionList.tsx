import { formatDateTime } from '~/lib/datetime'

export type UploadVersionItem = {
  uploadId?: string
  filename: string
  version: number
  uploadedAt: number
  url: string | null
  approvedAt?: number
}

/** Shared by the organizer and speaker views so version history cannot drift:
 * every historical file stays reachable, while the newest one is explicit. */
export function UploadVersionList({
  uploads,
  timezone,
  rowSize = 'sm',
}: {
  uploads: ReadonlyArray<UploadVersionItem>
  timezone: string
  rowSize?: 'sm' | 'md'
}) {
  const currentVersion = Math.max(...uploads.map((file) => file.version))
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
      {uploads.map((file) => {
        const current = file.version === currentVersion
        return (
          <li
            key={
              file.uploadId ??
              `${file.version}-${file.filename}-${file.uploadedAt}`
            }
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-3)',
              flexWrap: 'wrap',
              minHeight: `var(--row-height-${rowSize})`,
              borderBottom:
                rowSize === 'md'
                  ? 'var(--space-px) solid var(--border-subtle)'
                  : undefined,
            }}
          >
            <span
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-tertiary)',
              }}
            >
              v{file.version}
            </span>
            {current ? (
              <span
                style={{
                  font: 'var(--type-caption)',
                  fontWeight: 'var(--weight-medium)',
                  color: 'var(--text-success)',
                }}
              >
                Current
              </span>
            ) : null}
            {file.url === null ? (
              <span style={{ color: 'var(--text-tertiary)' }}>
                {file.filename} (unavailable)
              </span>
            ) : (
              <a
                href={file.url}
                target="_blank"
                rel="noreferrer"
                style={{ color: 'var(--text-link)' }}
              >
                {file.filename}
              </a>
            )}
            <time
              dateTime={new Date(file.uploadedAt).toISOString()}
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 'var(--text-xs)',
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-tertiary)',
              }}
            >
              {formatDateTime(file.uploadedAt, timezone)}
            </time>
            {file.approvedAt === undefined ? null : (
              <span
                style={{
                  font: 'var(--type-caption)',
                  color: 'var(--text-success)',
                }}
              >
                Approved
              </span>
            )}
          </li>
        )
      })}
    </ul>
  )
}
