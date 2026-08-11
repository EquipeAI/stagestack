import { readableAnswers, speakerName } from './model'
import type { Assignment } from './model'
import { Avatar, Card } from '~/ds'

// The proposal as a reviewer reads it: answers first, then who is proposing
// it. Nothing here is editable, and nothing here carries contact details.

export function ProposalReadout({ assignment }: { assignment: Assignment }) {
  const { proposal } = assignment
  const answers = readableAnswers(proposal, proposal.title)

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Card title={proposal.title} subtitle="The proposal, as submitted">
        {answers.length === 0 ? (
          <p
            style={{ color: 'var(--text-tertiary)', margin: 'var(--space-0)' }}
          >
            This proposal has no answers beyond its title.
          </p>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-5)',
            }}
          >
            {answers.map((answer) => (
              <section key={answer.fieldId}>
                <h3
                  style={{
                    font: 'var(--type-eyebrow)',
                    color: 'var(--text-tertiary)',
                    margin: 'var(--space-0)',
                  }}
                >
                  {answer.label}
                </h3>
                <p
                  style={{
                    font: 'var(--type-body)',
                    color: 'var(--text-primary)',
                    whiteSpace: 'pre-wrap',
                    margin: 'var(--space-2) var(--space-0) var(--space-0)',
                  }}
                >
                  {answer.href !== undefined ? (
                    <a
                      href={answer.href}
                      target="_blank"
                      rel="noreferrer"
                      style={{ color: 'var(--text-link)' }}
                    >
                      {answer.text}
                    </a>
                  ) : (
                    answer.text
                  )}
                </p>
              </section>
            ))}
          </div>
        )}
      </Card>

      {assignment.round.anonymized ? (
        <Card
          title="Blind review"
          subtitle="Speaker identities are hidden for this round."
        >
          <p
            style={{ color: 'var(--text-tertiary)', margin: 'var(--space-0)' }}
          >
            Evaluate only the proposal content shown above.
          </p>
        </Card>
      ) : (
        <Card
          title={proposal.speakers.length === 1 ? 'Speaker' : 'Speakers'}
          subtitle="Reviewers see professional identity only — never contact details."
        >
          {proposal.speakers.length === 0 ? (
            <p
              style={{
                color: 'var(--text-tertiary)',
                margin: 'var(--space-0)',
              }}
            >
              No speaker was recorded on this proposal.
            </p>
          ) : (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                gap: 'var(--space-5)',
              }}
            >
              {proposal.speakers.map((speaker, index) => (
                <div
                  key={`${speaker.firstName}-${speaker.lastName}-${index}`}
                  style={{ display: 'flex', gap: 'var(--space-3)' }}
                >
                  <Avatar name={speakerName(speaker) || 'Speaker'} size={32} />
                  <div style={{ minWidth: 0 }}>
                    <p
                      style={{
                        font: 'var(--type-label)',
                        color: 'var(--text-primary)',
                        margin: 'var(--space-0)',
                      }}
                    >
                      {speakerName(speaker) || 'Speaker to be announced'}
                    </p>
                    {speaker.tagline === undefined ? null : (
                      <p
                        style={{
                          font: 'var(--type-caption)',
                          color: 'var(--text-secondary)',
                          margin:
                            'var(--space-1) var(--space-0) var(--space-0)',
                        }}
                      >
                        {speaker.tagline}
                      </p>
                    )}
                    {speaker.bio === undefined ? null : (
                      <p
                        style={{
                          font: 'var(--type-body)',
                          color: 'var(--text-secondary)',
                          whiteSpace: 'pre-wrap',
                          margin:
                            'var(--space-2) var(--space-0) var(--space-0)',
                        }}
                      >
                        {speaker.bio}
                      </p>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  )
}
