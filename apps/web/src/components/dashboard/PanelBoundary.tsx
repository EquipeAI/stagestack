import { Component, Fragment } from 'react'
import type * as React from 'react'
import { Button, Callout } from '~/ds'
import { errorCode, errorMessage } from '~/lib/errors'

// Panel-level containment (W8).
//
// Readiness reads REFUSE (`event_too_large`) rather than truncate, and
// `useQuery` reports that by throwing during render. Without a boundary per
// panel, one over-ceiling table would blank the entire control center — which
// is precisely the failure the plan says to design against. So each panel owns
// a boundary, and a refusal costs that panel and nothing else: the other
// questions still get answered.
//
// Unlike the navigation rail's quiet boundary, this one SPEAKS: the organizer
// asked this screen a question, and silently omitting the answer would be the
// worse failure.
//
// It also RECOVERS, which a naive boundary does not. A caught error is sticky
// by design in React — the subtree stays unmounted until something remounts
// it — so without the two escapes below, an event that dropped back under its
// ceiling (or a transient outage that ended) would leave the panel dead for
// the rest of the session, and switching to another event would carry the dead
// panel along with it:
//
//   • the caller keys the boundary by event, so a failure never outlives the
//     event it belonged to;
//   • "Try again" clears the flag and remounts the child, which re-subscribes.
//     The child is keyed by the attempt number, because clearing the error
//     without remounting would re-render the same failed subtree.

type Props = { title: string; children: React.ReactNode }
type State = { error: unknown | null; attempt: number }

export class PanelBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props)
    this.state = { error: null, attempt: 0 }
  }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error }
  }

  private retry = () => {
    this.setState((prev) => ({ error: null, attempt: prev.attempt + 1 }))
  }

  render() {
    const { error, attempt } = this.state
    if (error === null) {
      return <Fragment key={attempt}>{this.props.children}</Fragment>
    }
    const code = errorCode(error)
    return (
      <Callout
        tone="blocked"
        title={
          code === 'event_too_large'
            ? `${this.props.title} is too large to answer in one pass`
            : `${this.props.title} could not be loaded`
        }
        actions={
          <Button size="sm" iconLeft="refresh-cw" onClick={this.retry}>
            Try again
          </Button>
        }
      >
        {errorMessage(error)}
        {code === 'event_too_large'
          ? ' The rest of this screen is unaffected.'
          : ''}
      </Callout>
    )
  }
}
