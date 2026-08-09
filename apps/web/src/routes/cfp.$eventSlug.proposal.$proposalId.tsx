import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Show, SignInButton, useUser } from '@clerk/tanstack-react-start'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import {
  Button,
  Callout,
  Card,
  DescriptionList,
  Dialog,
  PageHeader,
  StatusPill,
} from '~/ds'
import { PageBody } from '~/components/PageBody'
import { pushToast } from '~/components/toast'
import { formatDateTime } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'
import { useProvisioning } from '~/lib/useProvisioning'
import {
  CfpRouteError,
  CfpWindowBanner,
  Mono,
  SaveIndicator,
  useNow,
} from '~/components/cfp/CfpChrome'
import { CfpAnswersSummary, CfpForm } from '~/components/cfp/CfpForm'
import {
  SpeakersEditor,
  SpeakersSummary,
  incompleteSpeakers,
  speakersFromDocs,
} from '~/components/cfp/SpeakersEditor'
import {
  useAnswersDraft,
  useSpeakersDraft,
} from '~/components/cfp/useProposalDrafts'
import {
  PROPOSAL_STATUS_LABEL,
  cfpWindowState,
  fieldDomId,
  missingAnswers,
} from '~/components/cfp/model'
import { saveStatusLabel } from '~/components/cfp/useAutosave'

// The submitter's home for one proposal: state, the edit surface while the
// window is open, resubmit, and withdraw. Organizers never see this page.

export const Route = createFileRoute('/cfp/$eventSlug/proposal/$proposalId')({
  component: ManageRoute,
  errorComponent: CfpRouteError,
})

type MyProposalView = FunctionReturnType<typeof api.cfp.getMyProposal>

function ManageRoute() {
  const { eventSlug, proposalId } = Route.useParams()
  const { isLoading, provisioned, error, retry } = useProvisioning()

  const data = useQuery(
    api.cfp.getMyProposal,
    provisioned ? { proposalId: proposalId as Id<'proposals'> } : 'skip',
  )

  if (isLoading) {
    return (
      <PageBody narrow>
        <p style={{ color: 'var(--text-tertiary)' }}>Checking your session…</p>
      </PageBody>
    )
  }

  return (
    <>
      <Show when="signed-out">
        <PageBody narrow>
          <Card
            title="Sign in to open your proposal"
            subtitle="Proposals are private to the person who submitted them."
            footer={
              <SignInButton mode="modal">
                <Button variant="primary">Sign in</Button>
              </SignInButton>
            }
          >
            <p style={{ color: 'var(--text-secondary)' }}>
              Use the same account you used to submit. If you are not sure
              which, the confirmation email names it.
            </p>
          </Card>
        </PageBody>
      </Show>
      <Show when="signed-in">
        {error !== null ? (
          <PageBody narrow>
            <Callout
              tone="blocked"
              title="Could not load your account"
              actions={
                <Button variant="primary" onClick={retry}>
                  Try again
                </Button>
              }
            >
              {error}
            </Callout>
          </PageBody>
        ) : data === undefined ? (
          <PageBody narrow>
            <p style={{ color: 'var(--text-tertiary)' }}>
              Loading your proposal…
            </p>
          </PageBody>
        ) : (
          <ManageProposal
            key={data.proposal._id}
            eventSlug={eventSlug}
            data={data}
          />
        )}
      </Show>
    </>
  )
}

function ManageProposal({
  eventSlug,
  data,
}: {
  eventSlug: string
  data: MyProposalView
}) {
  const now = useNow()
  const navigate = useNavigate()
  const { user } = useUser()
  const proposalId = data.proposal._id
  const zone = data.event.timezone
  const status = data.proposal.status

  const windowState = cfpWindowState({
    openAt: data.event.cfpOpenAt,
    closeAt: data.event.cfpCloseAt,
    reopenedUntil: data.proposal.reopenedUntil,
    now,
  })
  const statusEditable = status === 'draft' || status === 'pending'
  const editable = statusEditable && windowState === 'open'

  return (
    <PageBody narrow>
      <PageHeader
        title={data.proposal.title}
        description={`${data.event.name} · your proposal`}
        meta={<StatusPill status={PROPOSAL_STATUS_LABEL[status]} />}
        actions={
          <Link to="/cfp/$eventSlug" params={{ eventSlug }}>
            <Button variant="ghost" iconLeft="chevron-left">
              The call
            </Button>
          </Link>
        }
      />

      <CfpWindowBanner
        state={windowState}
        openAt={data.event.cfpOpenAt}
        closeAt={data.event.cfpCloseAt}
        zone={zone}
        reopenedUntil={data.proposal.reopenedUntil}
      />

      <Card title="Status">
        <DescriptionList
          items={[
            { term: 'State', value: PROPOSAL_STATUS_LABEL[status] },
            {
              term: 'Submitted',
              value:
                data.proposal.submittedAt === undefined ? (
                  'Not submitted yet'
                ) : (
                  <Mono>{formatDateTime(data.proposal.submittedAt, zone)}</Mono>
                ),
            },
            {
              term: 'Last change',
              value: <Mono>{formatDateTime(data.proposal.updatedAt, zone)}</Mono>,
            },
          ]}
        />
      </Card>

      {editable ? (
        <ProposalEditor
          data={data}
          proposalId={proposalId}
          self={
            user === null || user === undefined
              ? undefined
              : {
                  firstName: user.firstName ?? '',
                  lastName: user.lastName ?? '',
                  email: user.primaryEmailAddress?.emailAddress ?? '',
                }
          }
        />
      ) : (
        <ReadOnlyProposal data={data} statusEditable={statusEditable} />
      )}

      <WithdrawCard
        proposalId={proposalId}
        status={status}
        title={data.proposal.title}
        onWithdrawn={() => {
          void navigate({ to: '/cfp/$eventSlug', params: { eventSlug } })
        }}
      />
    </PageBody>
  )
}

// ── Editable ─────────────────────────────────────────────────────────────

function ProposalEditor({
  data,
  proposalId,
  self,
}: {
  data: MyProposalView
  proposalId: Id<'proposals'>
  self?: { firstName: string; lastName: string; email: string }
}) {
  const answersDraft = useAnswersDraft(proposalId, data.proposal.answers)
  const speakersDraft = useSpeakersDraft(proposalId, data.speakers)
  const submitProposal = useMutation(api.cfp.submitProposal)
  const submit = usePending()
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(() => new Set())

  const isResubmit = data.proposal.status === 'pending'
  const missing = missingAnswers(data.form, answersDraft.answers)
  const nameless = incompleteSpeakers(speakersDraft.speakers)
  const blockers = missing.length + nameless.length

  const doSubmit = () => {
    setFlagged(new Set(missing.map((m) => m.field.id)))
    if (blockers > 0) return
    void submit.run(async () => {
      await answersDraft.saveNow()
      await speakersDraft.saveNow()
      await submitProposal({ proposalId })
      pushToast(
        isResubmit ? 'Proposal resubmitted' : 'Proposal submitted',
        'The organizers have been notified.',
      )
    })
  }

  const jumpToField = (fieldId: string) => {
    setTimeout(() => {
      const el = document.getElementById(fieldDomId(fieldId))
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el?.focus()
    }, 0)
  }

  const saveLabel =
    answersDraft.autosave.status === 'idle'
      ? saveStatusLabel(speakersDraft.autosave.status)
      : saveStatusLabel(answersDraft.autosave.status)

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      <PageHeader
        title="Your submission"
        description="Changes save as you type. Nothing reaches the organizers until you resubmit."
      />
      {answersDraft.autosave.error !== null ? (
        <Callout tone="blocked" title="Your last change was not saved">
          {answersDraft.autosave.error}
        </Callout>
      ) : null}
      <CfpForm
        form={data.form}
        answers={answersDraft.answers}
        onChange={answersDraft.setAnswer}
        proposalId={proposalId}
        flagged={flagged}
        uploadedNames={answersDraft.uploadedNames}
        onUploaded={answersDraft.noteUpload}
      />

      <PageHeader
        title="Speakers"
        description="At least one speaker is required. The primary contact hears from the organizers first."
      />
      {speakersDraft.autosave.error !== null ? (
        <Callout tone="blocked" title="Your last change was not saved">
          {speakersDraft.autosave.error}
        </Callout>
      ) : null}
      <SpeakersEditor
        speakers={speakersDraft.speakers}
        onChange={speakersDraft.setSpeakers}
        self={self}
      />

      {submit.error !== null ? (
        <Callout tone="blocked" title="This proposal was not submitted">
          {submit.error}
        </Callout>
      ) : null}
      {blockers > 0 ? (
        <Callout
          tone="attention"
          title={`${blockers} thing${blockers === 1 ? '' : 's'} still needed`}
        >
          <ul
            style={{
              paddingLeft: 'var(--space-5)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
              marginTop: 'var(--space-2)',
            }}
          >
            {missing.map((item) => (
              <li key={item.field.id}>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    jumpToField(item.field.id)
                  }}
                >
                  {item.field.label}
                </Button>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>
                  {item.reason}
                </span>
              </li>
            ))}
            {nameless.map((index) => (
              <li key={`speaker-${index}`}>
                Speaker {index + 1} needs a first and last name.
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          flexWrap: 'wrap',
          padding: 'var(--space-4) var(--space-0)',
          borderTop: 'var(--space-px) solid var(--border-subtle)',
        }}
      >
        <Button
          iconLeft="download"
          onClick={() => {
            void answersDraft.saveNow()
            void speakersDraft.saveNow()
          }}
        >
          Save draft
        </Button>
        <div
          style={{
            marginLeft: 'auto',
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--space-3)',
          }}
        >
          <SaveIndicator
            label={saveLabel}
            tone={
              answersDraft.autosave.status === 'error' ||
              speakersDraft.autosave.status === 'error'
                ? 'danger'
                : 'muted'
            }
          />
          <Button
            variant="primary"
            onClick={doSubmit}
            disabled={submit.pending}
          >
            {submit.pending
              ? 'Sending…'
              : isResubmit
                ? 'Save & resubmit'
                : 'Submit proposal'}
          </Button>
        </div>
      </div>
      <p
        style={{
          font: 'var(--type-caption)',
          color: 'var(--text-tertiary)',
          margin: 'var(--space-0)',
        }}
      >
        {isResubmit
          ? 'Resubmitting notifies the organizers that your proposal changed.'
          : 'Submitting notifies the organizers and sends you a confirmation email.'}
      </p>
    </div>
  )
}

// ── Read only ────────────────────────────────────────────────────────────

function ReadOnlyProposal({
  data,
  statusEditable,
}: {
  data: MyProposalView
  statusEditable: boolean
}) {
  const speakers = speakersFromDocs(data.speakers)
  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}
    >
      <Callout
        tone="neutral"
        title={
          statusEditable
            ? 'This proposal can no longer be edited'
            : 'A decision has been recorded'
        }
      >
        {statusEditable
          ? 'The call for speakers is closed. Ask the organizers to reopen your proposal if you need to change something.'
          : 'Editing is closed once organizers act on a proposal. Contact them directly if something needs to change.'}
      </Callout>
      <PageHeader title="Your submission" />
      <CfpAnswersSummary form={data.form} answers={data.proposal.answers} />
      <PageHeader title="Speakers" />
      <SpeakersSummary speakers={speakers} />
    </div>
  )
}

// ── Withdraw ─────────────────────────────────────────────────────────────

function WithdrawCard({
  proposalId,
  status,
  title,
  onWithdrawn,
}: {
  proposalId: Id<'proposals'>
  status: MyProposalView['proposal']['status']
  title: string
  onWithdrawn: () => void
}) {
  const withdraw = useMutation(api.cfp.withdrawProposal)
  const { pending, error, run } = usePending()
  const [confirming, setConfirming] = useState(false)

  if (status === 'withdrawn' || status === 'accepted' || status === 'declined') {
    return null
  }

  const isDraft = status === 'draft'
  const actionLabel = isDraft ? 'Delete draft' : 'Withdraw proposal'

  const apply = () => {
    void run(async () => {
      await withdraw({ proposalId })
      pushToast(
        isDraft ? 'Draft deleted' : 'Proposal withdrawn',
        title,
      )
      setConfirming(false)
      onWithdrawn()
    })
  }

  return (
    <Card
      title={isDraft ? 'Delete this draft' : 'Withdraw this proposal'}
      subtitle={
        isDraft
          ? 'Nobody has seen this draft. Deleting it removes it completely.'
          : 'The organizers are notified and stop reviewing it.'
      }
    >
      <div
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
      >
        {error !== null ? <Callout tone="blocked">{error}</Callout> : null}
        <div>
          <Button
            variant="danger"
            disabled={pending}
            onClick={() => {
              setConfirming(true)
            }}
          >
            {actionLabel}
          </Button>
        </div>
      </div>
      {confirming ? (
        <Dialog
          open
          title={`${actionLabel}?`}
          description={
            isDraft
              ? `"${title}" and its speakers are deleted. This cannot be undone.`
              : `"${title}" is withdrawn from review. The organizers are notified immediately, and you cannot undo this from here.`
          }
          onClose={
            pending
              ? undefined
              : () => {
                  setConfirming(false)
                }
          }
          footer={
            <>
              <Button
                onClick={() => {
                  setConfirming(false)
                }}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button variant="danger" onClick={apply} disabled={pending}>
                {pending ? 'Working…' : actionLabel}
              </Button>
            </>
          }
        />
      ) : null}
    </Card>
  )
}
