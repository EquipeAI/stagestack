import { useState } from 'react'
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router'
import { Show, SignInButton, useUser } from '@clerk/tanstack-react-start'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import type { FunctionReturnType } from 'convex/server'
import type { Id } from '@convex/_generated/dataModel'
import type { Answers, UploadedNames } from '~/components/cfp/model'
import type { SpeakerDraft } from '~/components/cfp/SpeakersEditor'
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
  speakersToInput,
} from '~/components/cfp/SpeakersEditor'
import {
  useAnswersDraft,
  useSpeakersDraft,
} from '~/components/cfp/useProposalDrafts'
import {
  PROPOSAL_STATUS_LABEL,
  answerSummary,
  cfpWindowState,
  fieldDomId,
  isBlankAnswer,
  missingAnswers,
  proposalEditAccess,
  speakerName,
} from '~/components/cfp/model'
import { saveStatusLabel } from '~/components/cfp/useAutosave'
import { deepEqual } from '~/lib/cfpForm'

// The submitter's home for one proposal: state, the edit surface while the
// window is open, resubmit, and withdraw. Organizers never see this page.

export const Route = createFileRoute('/cfp/$eventSlug/proposal/$proposalId')({
  component: ManageRoute,
  errorComponent: CfpRouteError,
  // Auth-gated, so a crawler sees nothing — but there is no reason for one
  // submitter's proposal URL to be indexable at all. Same meta the embed,
  // invite and portal routes use.
  head: () => ({ meta: [{ name: 'robots', content: 'noindex' }] }),
})

type MyProposalView = FunctionReturnType<typeof api.cfp.getMyProposal>

/**
 * A content-changing resubmit is the server's identity-reconciliation point:
 * newly added speakers now have proposalSpeakerIds. Remount the local editor
 * from that authoritative snapshot, but never on ordinary reactive metadata
 * changes (which could discard unsent edits) or draft autosaves.
 */
export function manageProposalKey(data: MyProposalView): string {
  const revision =
    data.proposal.status === 'draft'
      ? 'draft'
      : `submitted-${data.proposal.contentVersion ?? 0}`
  return `${data.proposal._id}:${revision}`
}

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
            key={manageProposalKey(data)}
            eventSlug={eventSlug}
            data={data}
          />
        )}
      </Show>
    </>
  )
}

export function ManageProposal({
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
  const editAccess = proposalEditAccess({
    status,
    reopenedUntil: data.proposal.reopenedUntil,
    archivedAt: data.event.archivedAt,
    now,
  })
  const statusEditable = editAccess === 'eligible'
  const editable = statusEditable && windowState === 'open'

  // Once the editor is up, the window expiring must not unmount it: in
  // resubmit mode every edit lives only in its state, so swapping to the
  // read-only view would silently destroy them. The editor handles its own
  // expired presentation instead.
  const [hadOpenWindow, setHadOpenWindow] = useState(editable)
  if (editable && !hadOpenWindow) setHadOpenWindow(true)
  const keepEditorMounted = editAccess !== 'locked' && hadOpenWindow

  // When the reopen grant is what holds the window open, it is also what ends
  // it — the countdown has to look at the deadline actually in force.
  const reopenedUntil = data.proposal.reopenedUntil ?? null
  const deadline =
    reopenedUntil !== null && reopenedUntil > now
      ? reopenedUntil
      : (data.event.cfpCloseAt ?? null)

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
              value: (
                <Mono>{formatDateTime(data.proposal.updatedAt, zone)}</Mono>
              ),
            },
          ]}
        />
      </Card>

      {editable || keepEditorMounted ? (
        <ProposalEditor
          data={data}
          proposalId={proposalId}
          expired={!editable}
          deadline={deadline}
          now={now}
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
        <ReadOnlyProposal
          data={data}
          statusEditable={editAccess !== 'locked'}
        />
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
  expired,
  deadline,
  now,
  self,
}: {
  data: MyProposalView
  proposalId: Id<'proposals'>
  /** The window closed while this editor was open. Render, never unmount. */
  expired: boolean
  /** When the window in force closes; null when no close is announced. */
  deadline: number | null
  now: number
  self?: { firstName: string; lastName: string; email: string }
}) {
  // A draft is the submitter's alone, so it saves as it is typed. Anything
  // already submitted is on an organizer's screen: it may only change at the
  // moment the submitter says "resubmit", never a keystroke at a time.
  const isResubmit = data.proposal.status !== 'draft'
  const autosave = !isResubmit

  const answersDraft = useAnswersDraft(proposalId, data.proposal.answers, {
    autosave,
  })
  const speakersDraft = useSpeakersDraft(proposalId, data.speakers, {
    autosave,
  })
  const submitProposal = useMutation(api.cfp.submitProposal)
  const resubmitProposal = useMutation(api.cfp.resubmitProposal)
  const submit = usePending()
  const [awaitingServerRevision, setAwaitingServerRevision] = useState(false)
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(() => new Set())

  // Edits the server has not seen. In resubmit mode this is everything typed
  // since the page opened; in draft mode only the autosave tail.
  const unsent =
    !deepEqual(answersDraft.answers, data.proposal.answers) ||
    !deepEqual(
      speakersToInput(speakersDraft.speakers),
      speakersToInput(speakersFromDocs(data.speakers)),
    )

  if (expired) {
    // Nothing pending: the ordinary closed-window view is the honest one.
    if (!unsent) return <ReadOnlyProposal data={data} statusEditable />
    return (
      <ExpiredLocalEdits
        data={data}
        answers={answersDraft.answers}
        uploadedNames={answersDraft.uploadedNames}
        speakers={speakersDraft.speakers}
      />
    )
  }

  const missing = missingAnswers(data.form, answersDraft.answers)
  const nameless = incompleteSpeakers(speakersDraft.speakers)
  const blockers = missing.length + nameless.length

  const doSubmit = () => {
    setFlagged(new Set(missing.map((m) => m.field.id)))
    if (blockers > 0) return
    void submit.run(async () => {
      if (isResubmit) {
        await resubmitProposal({
          proposalId,
          expectedContentVersion: data.proposal.contentVersion ?? 0,
          answers: answersDraft.answers,
          speakers: speakersToInput(speakersDraft.speakers),
        })
        // A changed revision receives a new contentVersion and authoritative
        // proposalSpeakerIds. Keep this stale editor frozen until the reactive
        // result remounts it; otherwise a very fast second click can race the
        // subscription and resend a new co-author without their server id.
        if (unsent) setAwaitingServerRevision(true)
      } else {
        await answersDraft.saveNow()
        await speakersDraft.saveNow()
        await submitProposal({ proposalId })
      }
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

  const saveLabel = isResubmit
    ? 'Changes are local until you resubmit'
    : answersDraft.autosave.status === 'idle'
      ? saveStatusLabel(speakersDraft.autosave.status)
      : saveStatusLabel(answersDraft.autosave.status)
  const editorBusy = submit.pending || awaitingServerRevision

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <PageHeader
        title="Your submission"
        description={
          isResubmit
            ? 'Your edits stay on this page until you resubmit — the organizers keep reading the version you sent them.'
            : 'Changes save as you type. Nothing reaches the organizers until you resubmit.'
        }
      />
      {isResubmit && deadline !== null && deadline - now <= CLOSING_SOON_MS ? (
        <Callout tone="attention" title="The window is about to close">
          Resubmit before{' '}
          <Mono>{formatDateTime(deadline, data.event.timezone)}</Mono>. Edits on
          this page are saved nowhere else — if the window closes first they
          stay on this screen for you to copy, but they cannot be submitted.
        </Callout>
      ) : null}
      {!isResubmit && answersDraft.autosave.error !== null ? (
        <Callout tone="blocked" title="Your last change was not saved">
          {answersDraft.autosave.error}
        </Callout>
      ) : null}
      <CfpForm
        form={data.form}
        answers={answersDraft.answers}
        onChange={answersDraft.setAnswer}
        proposalId={proposalId}
        disabled={editorBusy}
        flagged={flagged}
        uploadedNames={answersDraft.uploadedNames}
        onUploaded={answersDraft.noteUpload}
      />

      <PageHeader
        title="Speakers"
        description="At least one speaker is required. Everything about this proposal goes to your account email."
      />
      {!isResubmit && speakersDraft.autosave.error !== null ? (
        <Callout tone="blocked" title="Your last change was not saved">
          {speakersDraft.autosave.error}
        </Callout>
      ) : null}
      <SpeakersEditor
        speakers={speakersDraft.speakers}
        onChange={speakersDraft.setSpeakers}
        disabled={editorBusy}
        lockExistingRemoval={data.proposal.status === 'accepted'}
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
        {isResubmit ? null : (
          <Button
            iconLeft="download"
            disabled={editorBusy}
            onClick={() => {
              // The indicator already carries the outcome of these.
              void answersDraft.saveNow().catch(() => {})
              void speakersDraft.saveNow().catch(() => {})
            }}
          >
            Save draft
          </Button>
        )}
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
          <Button variant="primary" onClick={doSubmit} disabled={editorBusy}>
            {awaitingServerRevision
              ? 'Refreshing…'
              : submit.pending
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
          ? 'Resubmitting saves your changes and notifies the organizers that your proposal changed.'
          : 'Submitting notifies the organizers and sends you a confirmation email.'}
      </p>
    </div>
  )
}

/** How close the deadline gets before the resubmit editor starts warning. */
const CLOSING_SOON_MS = 15 * 60_000

// ── Expired with unsent edits ────────────────────────────────────────────

/**
 * The window closed while unsent edits were on screen. They exist nowhere but
 * in this component's props, so the one job here is to keep them visible and
 * copyable — the organizers still see the previously submitted version.
 */
function ExpiredLocalEdits({
  data,
  answers,
  uploadedNames,
  speakers,
}: {
  data: MyProposalView
  answers: Answers
  uploadedNames: UploadedNames
  speakers: Array<SpeakerDraft>
}) {
  const copyText = () => {
    const lines: Array<string> = [`${data.proposal.title} — unsent edits`, '']
    for (const section of data.form.sections) {
      for (const field of section.fields) {
        const value = answers[field.id]
        if (isBlankAnswer(value)) continue
        lines.push(
          `${field.label}:`,
          answerSummary(field, value, uploadedNames[field.id]),
          '',
        )
      }
    }
    lines.push('Speakers:')
    for (const speaker of speakers) {
      const parts = [speakerName(speaker), speaker.email, speaker.tagline]
        .map((part) => part.trim())
        .filter((part) => part !== '')
      lines.push(`- ${parts.join(' · ')}`)
      if (speaker.bio.trim() !== '') lines.push(`  ${speaker.bio.trim()}`)
    }
    return lines.join('\n')
  }

  const copy = () => {
    void navigator.clipboard.writeText(copyText()).then(
      () => pushToast('Copied', 'Your unsent edits are on the clipboard.'),
      () =>
        pushToast('Copy failed', 'Select the text below and copy it by hand.'),
    )
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Callout
        tone="blocked"
        title="The window closed with unsent edits"
        actions={<Button onClick={copy}>Copy my edits</Button>}
      >
        The changes below were never sent — the organizers still see the version
        you submitted before. They live only on this screen: copy what you need,
        and ask the organizers to reopen the proposal if you want to submit
        them. Leaving this page discards them.
      </Callout>
      <PageHeader title="Your unsent edits" />
      <CfpAnswersSummary
        form={data.form}
        answers={answers}
        uploadedNames={uploadedNames}
      />
      <PageHeader title="Speakers" />
      <SpeakersSummary speakers={speakers} />
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
  const acceptedRevisionExpired =
    data.proposal.status === 'accepted' &&
    data.proposal.reopenedUntil !== undefined
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-5)',
      }}
    >
      <Callout
        tone="neutral"
        title={
          acceptedRevisionExpired
            ? 'The revision window has closed'
            : statusEditable
              ? 'This proposal can no longer be edited'
              : 'A decision has been recorded'
        }
      >
        {acceptedRevisionExpired
          ? 'Your acceptance remains in place. Ask the organizers to reopen this proposal again if another revision is needed.'
          : statusEditable
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

  if (
    status === 'withdrawn' ||
    status === 'accepted' ||
    status === 'declined'
  ) {
    return null
  }

  const isDraft = status === 'draft'
  const actionLabel = isDraft ? 'Delete draft' : 'Withdraw proposal'

  const apply = () => {
    void run(async () => {
      await withdraw({ proposalId })
      pushToast(isDraft ? 'Draft deleted' : 'Proposal withdrawn', title)
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
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
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
