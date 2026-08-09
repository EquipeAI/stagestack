import { Component } from 'react'
import type * as React from 'react'
import { Callout } from '~/ds'
import { errorMessage } from '~/lib/errors'

// Convex's useQuery throws when the backend refuses a subscription, and a
// refusal is a normal outcome for capability-gated data (a member with event
// access only, opening an org-wide tab). Without a boundary that throw takes
// the whole route with it — this keeps it inside the panel that asked, and
// shows the sentence the backend wrote.

type Props = {
  /** Changing this remounts the boundary, which retries the query. */
  resetKey?: string
  title?: string
  children: React.ReactNode
}

type State = { error: Error | null }

export class QueryBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidUpdate(previous: Props) {
    if (previous.resetKey !== this.props.resetKey && this.state.error !== null) {
      this.setState({ error: null })
    }
  }

  render() {
    const { error } = this.state
    if (error === null) return this.props.children
    return (
      <Callout
        tone="blocked"
        title={this.props.title ?? 'This could not be loaded'}
      >
        {errorMessage(error)}
      </Callout>
    )
  }
}
