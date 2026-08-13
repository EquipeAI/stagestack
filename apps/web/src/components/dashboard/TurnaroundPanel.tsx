import { useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Panel } from '~/ds'

// ─────────────────────────────────────────────────────────────────────────
// Turnaround analytics (W4) — the fifth section, and deliberately the LAST.
//
// It sits BELOW the four questions and starts COLLAPSED, because "how long did
// things take" is a retrospective question and the four above it are the
// attention-first answer. An expanded analytics block above the fold would
// dilute exactly the thing the control center exists to protect.
//
// A STACKED LIST OF SENTENCES. No chart, no sparkline, no KPI tile grid — the
// last cycle's review objection to KPI grids stands, and it is really an
// objection to numbers that do not say what they are. Every line here states
// its own population and names what is still running, because it was composed
// in convex/model/analytics.ts. This file counts nothing and words nothing.
//
// The disclosure is the DS `Panel` (native <details>/<summary>), so the
// expanded state, the keyboard behaviour and the accessible name come from the
// platform rather than from hand-written ARIA — and the sentences inside are
// plain text a screen reader reads in order.
// ─────────────────────────────────────────────────────────────────────────

export function TurnaroundPanel({ eventSlug }: { eventSlug: string }) {
  // No `now`: medians over closed intervals need no clock, so this
  // subscription survives every tick of the panels above it.
  const panel = useQuery(api.analytics.turnaround, { eventSlug })

  if (panel === undefined) {
    return (
      <Panel title="How long things are taking" defaultOpen={false}>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading the history…</p>
      </Panel>
    )
  }

  return (
    <Panel
      title="How long things are taking"
      subtitle={panel.summary}
      defaultOpen={false}
    >
      <ul className="cc-turnaround">
        {panel.stats.map((stat) => (
          <li key={stat.id} className="cc-turnaround__item">
            <span className="cc-turnaround__label">{stat.label}</span>
            <span className="cc-turnaround__sentence">{stat.sentence}</span>
          </li>
        ))}
      </ul>
    </Panel>
  )
}
