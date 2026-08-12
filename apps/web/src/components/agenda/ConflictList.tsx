import type { BoardConflict } from './model'
import { Badge } from '~/ds'

/**
 * The one rendering of a block's conflicts.
 *
 * The sentences themselves are produced server-side by `conflictsFor` in
 * convex/model/agenda.ts and are printed verbatim — this component only decides
 * how they look. It exists because sessions and agenda items had two different
 * answers to "where do I read the conflict?": a session's clash was written out
 * in `SessionDetailDialog`, an agenda item's existed only in a hover tooltip on
 * the board, which a touch device never triggers. Both dialogs render this now.
 */
export function ConflictList({ conflicts }: { conflicts: Array<BoardConflict> }) {
  if (conflicts.length === 0) return null
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}
    >
      {conflicts.map((c, i) => (
        <div
          key={`${c.kind}-${c.withId}-${i}`}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-2)',
          }}
        >
          {/* The word, not just the tone: "blocker" and "warning" differ by
              colour on the board, and colour is not an answer on its own. */}
          <Badge tone={c.level === 'blocker' ? 'blocked' : 'attention'} dot>
            {c.level === 'blocker' ? 'Blocker' : 'Warning'}
          </Badge>
          <span style={{ color: 'var(--text-secondary)' }}>{c.message}</span>
        </div>
      ))}
    </div>
  )
}

/**
 * The same conflicts as one sentence, for an accessible name or a summary line.
 * Screen-reader users get the level and the reason from the mark on the block
 * itself, not only from opening the dialog.
 */
export function conflictSummary(conflicts: Array<BoardConflict>): string {
  if (conflicts.length === 0) return ''
  const blockers = conflicts.filter((c) => c.level === 'blocker')
  const lead = blockers.length > 0 ? 'Blocker' : 'Warning'
  const rest = conflicts.length > 1 ? ` (${conflicts.length} conflicts)` : ''
  const source = blockers.length > 0 ? blockers : conflicts
  return `${lead}${rest}: ${source.map((c) => c.message).join(' ')}`
}
