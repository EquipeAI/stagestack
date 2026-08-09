import { Link } from '@tanstack/react-router'
import type { ErrorComponentProps } from '@tanstack/react-router'
import { Button, Callout, Card, EmptyState, Logo } from '~/ds'
import { PageBody } from '~/components/PageBody'
import { errorMessage } from '~/lib/errors'

// The router's default route boundaries. They matter most on the surfaces
// organizers hand out publicly — /e/<slug>, /embed/<slug>, /invite/<token>,
// the speaker portal — none of which declare their own errorComponent, so a
// Convex outage there is a stranger's first impression of the event. It has to
// look like the product, not like a browser error page.
//
// What is rendered is deliberately narrow: `errorMessage()` (which itself only
// forwards a raw Error.message in DEV) and, in DEV only, the stack. A stack
// names internal modules, ids and query paths, so production always shows one
// fixed sentence instead.

export function RouteError({ error, reset }: ErrorComponentProps) {
  return (
    <PageBody narrow>
      <Callout
        tone="blocked"
        title="This page could not be loaded"
        actions={
          <>
            <Button variant="primary" iconLeft="refresh-cw" onClick={reset}>
              Try again
            </Button>
            <Link to="/">
              <Button>Go to StageStack</Button>
            </Link>
          </>
        }
      >
        {errorMessage(
          error,
          'Something went wrong while loading this page. Nothing you did caused it — try again in a moment.',
        )}
      </Callout>
      {import.meta.env.DEV ? <DevDetail error={error} /> : null}
    </PageBody>
  )
}

/** DEV-only. Never rendered in a production build — see the note above. */
function DevDetail({ error }: { error: Error }) {
  const detail = error.stack ?? error.message
  if (!detail) return null
  return (
    <Card title="Stack trace" subtitle="Development builds only.">
      <pre
        style={{
          font: 'var(--type-mono)',
          color: 'var(--text-secondary)',
          whiteSpace: 'pre-wrap',
          overflowX: 'auto',
          margin: 'var(--space-0)',
        }}
      >
        {detail}
      </pre>
    </Card>
  )
}

export function RouteNotFound() {
  return (
    <PageBody narrow>
      <Card>
        <div
          style={{
            display: 'flex',
            justifyContent: 'center',
            paddingBottom: 'var(--space-4)',
          }}
        >
          <Logo size={24} />
        </div>
        <EmptyState
          icon="search"
          title="This page does not exist"
          description="The link may be out of date, or the page has moved. Check the address, or start again from StageStack."
          action={
            <Link to="/">
              <Button>Go to StageStack</Button>
            </Link>
          }
        />
      </Card>
    </PageBody>
  )
}
