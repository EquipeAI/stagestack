import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { Show, SignInButton } from '@clerk/tanstack-react-start'
import { Badge, Button, Icon, Logo, StatusPill } from '~/ds'
import githubIcon from '~/ds/assets/brand-icons/github.svg'

// The stagestack.dev homepage, adapted from the marketing-site UI kit in the
// StageStack Design System project. Marketing is the only surface where
// variant="brand" (amber fill) and the radial amber glow are allowed.

const GITHUB_URL = 'https://github.com/EquipeAI/stagestack'

function Nav() {
  return (
    <div className="mkt-nav">
      <div className="mkt-nav__inner">
        <Link to="/" aria-label="StageStack" style={{ display: 'flex', alignItems: 'center' }}>
          <Logo size={19} />
        </Link>
        <nav className="mkt-nav__links" aria-label="Site">
          <a className="mkt-nav__link" href="#product">
            Product
          </a>
          <a className="mkt-nav__link" href="#workflow">
            Workflow
          </a>
          <a className="mkt-nav__link" href="#open-source">
            Open source
          </a>
          <a className="mkt-nav__link" href={GITHUB_URL} target="_blank" rel="noreferrer">
            <img
              src={githubIcon}
              alt=""
              // Intrinsic size as attributes so the box is reserved before CSS
              // resolves, and async decoding so a 16px icon never blocks the
              // frame that paints the nav.
              width={16}
              height={16}
              decoding="async"
              style={{ width: 'var(--space-4)', height: 'var(--space-4)', opacity: 0.8 }}
            />
            GitHub
          </a>
        </nav>
        <div className="mkt-nav__auth">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button size="sm" variant="secondary">
                Sign in
              </Button>
            </SignInButton>
            <SignInButton mode="modal">
              <Button size="sm" variant="brand">
                Start free
              </Button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link to="/app">
              <Button size="sm" variant="brand" iconRight="arrow-right">
                Open StageStack
              </Button>
            </Link>
          </Show>
        </div>
      </div>
    </div>
  )
}

// In-app screenshot composed from the same components the product uses —
// fixture numbers, not customer claims.
const SHOT_NAV: Array<[string, string, string]> = [
  ['layout-grid', 'Dashboard', ''],
  ['file-text', 'Proposals', '512'],
  ['list-checks', 'Reviews', '128'],
  ['presentation', 'Sessions', '68'],
  ['clock', 'Tasks', '17'],
  ['calendar-days', 'Agenda', ''],
]

const SHOT_ROWS: Array<[string, string, string, string]> = [
  ['Shipping agents at scale', 'Ana Ruiz · Latent Labs', 'Accepted', '4.6'],
  ['Evals that survive contact with users', 'Kai Chen · Formal', 'Under Review', '4.1'],
  ['Prompt caching at 40M tokens a day', 'Nadia Haq · Perch', 'Submitted', '—'],
  ['Retrieval is not a vector database', 'Jo Park · Northwind', 'Declined', '2.8'],
]

function ProductShot() {
  return (
    <div className="mkt-shot">
      <div className="ss-card mkt-shot__frame" style={{ boxShadow: 'var(--shadow-xl)', overflow: 'hidden' }}>
        <div className="mkt-shot__bar" aria-hidden>
          <span className="mkt-shot__dot" style={{ background: 'var(--gray-300)' }} />
          <span className="mkt-shot__dot" style={{ background: 'var(--gray-200)' }} />
          <span className="mkt-shot__dot" style={{ background: 'var(--gray-200)' }} />
          <span className="mkt-shot__url">stagestack.dev/app/e/wf26/proposals</span>
        </div>
        <div className="mkt-shot__grid">
          <div className="mkt-shot__side">
            {SHOT_NAV.map(([icon, label, count], i) => (
              <span
                key={label}
                className="ss-navitem"
                data-active={i === 1}
                style={{ pointerEvents: 'none' }}
              >
                <Icon name={icon} size={14} />
                {label}
                {count === '' ? null : <span className="ss-navitem__count">{count}</span>}
              </span>
            ))}
          </div>
          <div style={{ padding: 'var(--space-4)' }}>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--space-3)',
                marginBottom: 'var(--space-3)',
                flexWrap: 'wrap',
              }}
            >
              <span style={{ font: 'var(--type-title-3)' }}>Proposals</span>
              <Badge>512</Badge>
              <span style={{ flex: 1 }} />
              <span className="mkt-shot__actions" style={{ display: 'flex', gap: 'var(--space-2)' }}>
                <Button size="sm" variant="secondary" iconLeft="download">
                  Export
                </Button>
                <Button size="sm" variant="primary">
                  Release 12 decisions
                </Button>
              </span>
            </div>
            {SHOT_ROWS.map(([title, who, status, score]) => (
              <div
                key={title}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--space-3)',
                  padding: 'var(--space-3) var(--space-1)',
                  borderTop: 'var(--space-px) solid var(--border-subtle)',
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontWeight: 'var(--weight-medium)',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                    }}
                  >
                    {title}
                  </div>
                  <div className="ss-table__sub">{who}</div>
                </div>
                <StatusPill status={status} />
                <span
                  className="ss-table__num"
                  style={{ width: 'var(--space-8)', textAlign: 'right', flex: 'none' }}
                >
                  {score}
                </span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

function Hero() {
  return (
    <section className="mkt-hero">
      <div className="mkt-hero__inner">
        <span className="mkt-hero__badge">
          <span className="mkt-hero__badge-dot" />
          Open source · self-hostable · no per-event pricing
        </span>
        <h1>
          Everything between{' '}
          <em className="mkt-hl">&ldquo;we&rsquo;re running an event&rdquo;</em> and
          &ldquo;attendees show up&rdquo;.
        </h1>
        <p className="mkt-hero__sub">
          StageStack runs your call for speakers, review, speaker operations and agenda in
          one place — then publishes the program everywhere it needs to go. Not another
          registration platform.
        </p>
        <div className="mkt-hero__ctas">
          <Show when="signed-out">
            <SignInButton mode="modal">
              <Button size="lg" variant="brand" iconRight="arrow-right">
                Create your event
              </Button>
            </SignInButton>
          </Show>
          <Show when="signed-in">
            <Link to="/app">
              <Button size="lg" variant="brand" iconRight="arrow-right">
                Open StageStack
              </Button>
            </Link>
          </Show>
          <a href="#open-source">
            <Button size="lg" variant="secondary" iconLeft="download">
              Self-host it
            </Button>
          </a>
        </div>
        <div className="mkt-hero__note">
          Hosted and self-hosted run the same code. Self-hosting brings your own Clerk and
          Resend keys.
        </div>
      </div>
      <ProductShot />
    </section>
  )
}

function Feature({
  icon,
  title,
  children,
}: {
  icon: string
  title: string
  children: React.ReactNode
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <span
        style={{
          width: 'var(--space-8)',
          height: 'var(--space-8)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--surface-brand-subtle)',
          color: 'var(--text-brand)',
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <Icon name={icon} size={16} />
      </span>
      <div style={{ font: 'var(--type-heading)' }}>{title}</div>
      <p
        style={{
          color: 'var(--text-secondary)',
          lineHeight: 'var(--leading-relaxed)',
          margin: 0,
        }}
      >
        {children}
      </p>
    </div>
  )
}

function Features() {
  return (
    <section id="product" className="mkt-section">
      <div className="mkt-features">
        <Feature icon="file-text" title="One source of truth">
          Speakers, proposals, sessions, rooms and the schedule live in one record set. The
          public page, the embed and the JSON API are projections of it — they cannot
          disagree.
        </Feature>
        <Feature icon="list-checks" title="Post-acceptance is half the product">
          Bios, headshots, decks and confirmations are tracked per speaker and per session,
          chased by one consolidated reminder email, and rolled up into readiness that is
          derived from facts — never a manual green tick.
        </Feature>
        <Feature icon="lock" title="Nothing leaks by accident">
          Decisions stage in a queue submitters cannot see and release in one explicit step.
          Reviewers see only what they are assigned, and never contact details. The public
          page names only Confirmed speakers — everyone else is &ldquo;Speaker to be
          announced&rdquo;.
        </Feature>
      </div>
    </section>
  )
}

type Step = {
  id: string
  label: string
  body: string
  statuses: Array<string>
}

const STEPS: Array<Step> = [
  {
    id: 'cfp',
    label: 'Call for speakers',
    body: 'Build the form with sections, conditional fields and a live preview, then publish a versioned copy. Submitters get an autosaving wizard with file uploads; drafts survive; the form locks itself at the deadline.',
    statuses: ['Draft', 'Submitted'],
  },
  {
    id: 'review',
    label: 'Review & decisions',
    body: 'Assign reviewers individually or in bulk. One autosaving screen with Submit & Next. Stage accepts and declines privately, then release them in one step — sessions are created, speakers are invited, and the emails send.',
    statuses: ['Under Review', 'Accepted', 'Declined'],
  },
  {
    id: 'ops',
    label: 'Speaker ops',
    body: 'Speakers confirm, decline or hand off to a manager in a portal claimed by their verified email — no extra passwords. Requirements instantiate per speaker and per session, and one reminder digest does the chasing.',
    statuses: ['Awaiting Response', 'Confirmed', 'Overdue'],
  },
  {
    id: 'agenda',
    label: 'Agenda',
    body: 'Drag sessions across rooms and tracks with 15-minute snapping. Room clashes and speaker double-bookings block release. Released slots email each speaker an .ics invite; a date change asks them to acknowledge again.',
    statuses: ['Awaiting Acknowledgement', 'Acknowledged', 'Conflict'],
  },
  {
    id: 'publish',
    label: 'Publish',
    body: 'One published projection feeds the public event page, the embed and the JSON API. Republish is the only thing that writes it; unpublish is one flip. Lineup and agenda publish independently.',
    statuses: ['Published', 'Unpublished'],
  },
]

function Workflow() {
  const [stepId, setStepId] = React.useState('cfp')
  const active = STEPS.find((s) => s.id === stepId) ?? STEPS[0]
  return (
    <section id="workflow" className="mkt-band">
      <div className="mkt-section">
        <h2 style={{ font: 'var(--type-title-1)', maxWidth: '20ch', margin: 0 }}>
          The whole workflow, not just the inbox
        </h2>
        <div className="mkt-workflow">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
            {STEPS.map((s, i) => (
              <button
                key={s.id}
                type="button"
                onClick={() => setStepId(s.id)}
                className="ss-navitem"
                data-active={stepId === s.id}
                style={{ height: 'var(--space-10)' }}
              >
                <span
                  style={{
                    fontFamily: 'var(--font-mono)',
                    color: 'var(--text-tertiary)',
                    fontSize: 'var(--text-xs)',
                  }}
                >
                  {String(i + 1).padStart(2, '0')}
                </span>
                {s.label}
              </button>
            ))}
          </div>
          <div className="ss-card" style={{ padding: 'var(--space-7)', minHeight: 190 }}>
            <div style={{ font: 'var(--type-title-3)' }}>{active.label}</div>
            <p
              style={{
                fontSize: 'var(--text-lg)',
                color: 'var(--text-secondary)',
                marginTop: 'var(--space-3)',
                marginBottom: 0,
                lineHeight: 'var(--leading-relaxed)',
                maxWidth: '58ch',
              }}
            >
              {active.body}
            </p>
            <div
              style={{
                display: 'flex',
                gap: 'var(--space-2)',
                marginTop: 'var(--space-5)',
                flexWrap: 'wrap',
              }}
            >
              {active.statuses.map((status) => (
                <StatusPill key={status} status={status} />
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

function SelfHost() {
  return (
    <section id="open-source" className="mkt-section">
      <div className="mkt-selfhost">
        <div>
          <h2 style={{ font: 'var(--type-title-1)', margin: 0 }}>Run it yourself. Forever.</h2>
          <p
            style={{
              fontSize: 'var(--text-lg)',
              color: 'var(--text-secondary)',
              marginTop: 'var(--space-4)',
              marginBottom: 0,
              lineHeight: 'var(--leading-relaxed)',
            }}
          >
            The application is open source and self-hostable. Hosted StageStack is the same
            code with the operational bits handled. No per-event pricing, no seat maths at
            renewal.
          </p>
          <div style={{ display: 'flex', gap: 'var(--space-3)', marginTop: 'var(--space-6)', flexWrap: 'wrap' }}>
            <a href={GITHUB_URL} target="_blank" rel="noreferrer">
              <Button variant="primary" iconRight="arrow-up-right">
                View on GitHub
              </Button>
            </a>
            <a
              href={`${GITHUB_URL}/blob/main/docs/ARCHITECTURE.md`}
              target="_blank"
              rel="noreferrer"
            >
              <Button variant="secondary">Architecture docs</Button>
            </a>
          </div>
        </div>
        <div className="ss-theme-dark mkt-terminal">
          <div>
            <span style={{ color: 'var(--amber-500)' }}>$</span> git clone
            https://github.com/EquipeAI/stagestack
          </div>
          <div>
            <span style={{ color: 'var(--amber-500)' }}>$</span> npm install &amp;&amp; npm
            run dev
          </div>
          <div style={{ color: 'var(--gray-500)' }}>
            # set CLERK_SECRET_KEY, RESEND_API_KEY
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}>
            <span style={{ color: 'var(--jade-500)', display: 'inline-flex' }}>
              <Icon name="check" size={14} />
            </span>
            {/* --gray-900, not --text-primary: inside .ss-theme-dark only
                palette tokens flip (see marketing.css note) */}
            <span style={{ color: 'var(--gray-900)' }}>ready on http://localhost:3000</span>
          </div>
        </div>
      </div>
    </section>
  )
}

function Footer() {
  return (
    <footer className="ss-theme-dark mkt-footer">
      <div className="mkt-footer__inner">
        <Logo size={18} />
        <span style={{ font: 'var(--type-caption)' }}>
          Event content, speaker &amp; abstract management.
        </span>
        <span style={{ flex: 1 }} />
        <a className="mkt-footer__link" href={GITHUB_URL} target="_blank" rel="noreferrer">
          <img
            src={githubIcon}
            alt=""
            width={16}
            height={16}
            // Footer, six screens down: never contend with the hero for
            // bandwidth on a phone.
            loading="lazy"
            decoding="async"
            style={{
              width: 'var(--space-4)',
              height: 'var(--space-4)',
              filter: 'invert(1)',
              opacity: 0.8,
            }}
          />
          GitHub
        </a>
      </div>
    </footer>
  )
}

export function Landing() {
  return (
    <div className="mkt">
      <Nav />
      <main>
        <Hero />
        <Features />
        <Workflow />
        <SelfHost />
      </main>
      <Footer />
    </div>
  )
}
