// The publish center's wire vocabulary (W10), typed once.
//
// Every string in these shapes was composed in the model layer
// (convex/model/publish.ts, convex/model/publishBulk.ts,
// convex/model/readiness.ts, convex/model/controlCenter.ts). The components
// below print them; they do not re-word, re-count, or re-derive them.

export type ChannelId = 'lineup' | 'agenda'

export type ChangeField =
  | 'title'
  | 'format'
  | 'track'
  | 'description'
  | 'speakers'
  | 'slot'
  | 'details'

export type DiffEntry = {
  id: string
  title: string
  changes: Array<ChangeField>
}

export type ChannelDiff = {
  added: Array<DiffEntry>
  changed: Array<DiffEntry>
  removed: Array<DiffEntry>
  empty: boolean
  /** The action would have no effect at all — the only honest reason to
   * disable it. An empty diff on a channel that is still off is NOT this. */
  doesNothing: boolean
  servedCount: number
  wouldBeCount: number
  sentence: string
  unpublishSentence: string
}

export type ProgramDiff = {
  neverPublished: boolean
  lineup: ChannelDiff
  agenda: ChannelDiff
}

export type BulkPlan = {
  channel: ChannelId
  enablesChannel: boolean
  targets: Array<{
    kind: 'session' | 'agendaItem'
    id: string
    title: string
    alreadyPublished: boolean
  }>
  eligible: number
  alreadyPublished: number
  excluded: Array<{ sessionId: string; title: string; sentence: string }>
  sentence: string
}

export type PublicationReason = {
  code: string
  blocks: 'both' | 'lineup' | 'agenda'
  sentence: string
  repair: {
    tab: 'sessions' | 'agenda' | 'publish'
    params?: { sessionId?: string }
    sessionTab?: 'overview' | 'content'
  }
}

export type PublicationRow = {
  sessionId: string
  title: string
  publication: {
    inLineup: boolean
    inAgenda: boolean
    toBeAnnounced: boolean
    reasons: Array<PublicationReason>
    summary: string
  }
}

/** The blockers holding ONE channel back, per session.
 *
 * Selection, not derivation: `blocks` is the model's own field, so this filters
 * rows the model already classified rather than deciding for itself what blocks
 * what. A session whose only reasons belong to the other channel is not listed. */
export function channelBlockers(
  rows: Array<PublicationRow>,
  channel: ChannelId,
): Array<{ sessionId: string; title: string; reasons: Array<PublicationReason> }> {
  return rows
    .map((row) => ({
      sessionId: row.sessionId,
      title: row.title,
      reasons: row.publication.reasons.filter(
        (reason) => reason.blocks === 'both' || reason.blocks === channel,
      ),
    }))
    .filter((row) => row.reasons.length > 0)
}
