import { Fragment, useEffect, useRef, useState } from 'react'
import { Link, createFileRoute } from '@tanstack/react-router'
import { Show, SignInButton, SignUpButton, useUser } from '@clerk/tanstack-react-start'
import { useMutation, useQuery } from 'convex/react'
import { api } from '@convex/_generated/api'
import { allFields } from '@convex/shared/formDef'
import type { FormDef } from '@convex/shared/formDef'
import type { Id } from '@convex/_generated/dataModel'
import type { FunctionReturnType } from 'convex/server'
import type * as React from 'react'
import type { WindowState } from '~/components/cfp/model'
import {
  Button,
  Callout,
  Card,
  DescriptionList,
  PageHeader,
  StatusPill,
} from '~/ds'
import { PageBody } from '~/components/PageBody'
import { formatDateRange, formatDateTime } from '~/lib/datetime'
import { usePending } from '~/lib/usePending'
import { useProvisioning } from '~/lib/useProvisioning'
import {
  CfpNotOpen,
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
} from '~/components/cfp/SpeakersEditor'
import {
  useAnswersDraft,
  useSpeakersDraft,
} from '~/components/cfp/useProposalDrafts'
import { cfpWindowState, fieldDomId, missingAnswers } from '~/components/cfp/model'
import { saveStatusLabel } from '~/components/cfp/useAutosave'

// The submission wizard: Welcome → Account → Submission → Participants →
// Review. The account is created before the submission on purpose — it is what
// lets a submitter come back and edit until the call closes.

export const Route = createFileRoute('/cfp/$eventSlug/submit')({
  component: SubmitRoute,
  errorComponent: CfpRouteError,
})

type StepId = 'welcome' | 'account' | 'submission' | 'participants' | 'review'

const STEPS: Array<{ id: StepId; label: string }> = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'account', label: 'Account' },
  { id: 'submission', label: 'Submission' },
  { id: 'participants', label: 'Participants' },
  { id: 'review', label: 'Review' },
]

const stepIndex = (id: StepId) => STEPS.findIndex((s) => s.id === id)

// ── Draft handoff across a reload ────────────────────────────────────────

const storageKey = (eventSlug: string) => `stagestack.cfp.${eventSlug}.proposal`

function readStoredProposal(eventSlug: string): string | null {
  try {
    return window.sessionStorage.getItem(storageKey(eventSlug))
  } catch {
    return null
  }
}

function writeStoredProposal(eventSlug: string, id: string) {
  try {
    window.sessionStorage.setItem(storageKey(eventSlug), id)
  } catch {
    // Private browsing with storage disabled: the draft still exists server
    // side, it just cannot be resumed automatically.
  }
}

function clearStoredProposal(eventSlug: string) {
  try {
    window.sessionStorage.removeItem(storageKey(eventSlug))
  } catch {
    // See writeStoredProposal.
  }
}

// ── Route ────────────────────────────────────────────────────────────────

function SubmitRoute() {
  const { eventSlug } = Route.useParams()
  const cfp = useQuery(api.cfpPublic.get, { eventSlug })

  if (cfp === undefined) {
    return (
      <PageBody narrow>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading the call…</p>
      </PageBody>
    )
  }
  if (cfp === null) return <CfpNotOpen />
  return <Wizard eventSlug={eventSlug} cfp={cfp} />
}

type PublicCfp = {
  event: {
    name: string
    startsAt: number
    endsAt: number
    timezone: string
    location?: string
  }
  form: FormDef
  cfpOpenAt?: number
  cfpCloseAt?: number
}

function Wizard({ eventSlug, cfp }: { eventSlug: string; cfp: PublicCfp }) {
  const now = useNow()
  const zone = cfp.event.timezone
  const windowState = cfpWindowState({
    openAt: cfp.cfpOpenAt,
    closeAt: cfp.cfpCloseAt,
    now,
  })

  const { isLoading, provisioned, error: authError, retry } = useProvisioning()
  const [step, setStep] = useState<StepId>('welcome')
  const [proposalId, setProposalId] = useState<Id<'proposals'> | null>(null)
  const [success, setSuccess] = useState<{ message: string | null } | null>(null)
  const [flagged, setFlagged] = useState<ReadonlySet<string>>(() => new Set())

  // sessionStorage is read after mount so the server and client render the
  // same first frame.
  useEffect(() => {
    const stored = readStoredProposal(eventSlug)
    if (stored !== null) setProposalId(stored as Id<'proposals'>)
  }, [eventSlug])

  const mine = useQuery(api.cfp.myProposals, provisioned ? {} : 'skip')
  const existingDraft =
    mine?.find(
      (row) => row.eventSlug === eventSlug && row.proposal.status === 'draft',
    ) ?? null

  // A stored id can point at a draft that was withdrawn from another tab.
  const validated = useRef(false)
  useEffect(() => {
    if (mine === undefined || proposalId === null || validated.current) return
    validated.current = true
    if (!mine.some((row) => row.proposal._id === proposalId)) {
      setProposalId(null)
      clearStoredProposal(eventSlug)
    }
  }, [mine, proposalId, eventSlug])

  const startProposal = useMutation(api.cfp.startProposal)
  const start = usePending()
  const starting = useRef(false)

  const adoptProposal = (id: Id<'proposals'>) => {
    setProposalId(id)
    writeStoredProposal(eventSlug, id)
    setStep('submission')
  }

  const beginProposal = () => {
    if (proposalId !== null) {
      setStep('submission')
      return
    }
    if (starting.current) return
    starting.current = true
    void start
      .run(async () => {
        const id = await startProposal({ eventSlug })
        adoptProposal(id)
      })
      .finally(() => {
        starting.current = false
      })
  }

  if (success !== null) {
    return (
      <SuccessScreen
        eventSlug={eventSlug}
        eventName={cfp.event.name}
        proposalId={proposalId}
        message={success.message}
      />
    )
  }

  const currentIndex = stepIndex(step)
  const reachableIndex = proposalId !== null ? STEPS.length - 1 : 1

  return (
    <PageBody narrow>
      <Stepper
        currentIndex={currentIndex}
        reachableIndex={reachableIndex}
        onSelect={(id) => {
          setStep(id)
        }}
      />

      {windowState !== 'open' ? (
        <CfpWindowBanner
          state={windowState}
          openAt={cfp.cfpOpenAt}
          closeAt={cfp.cfpCloseAt}
          zone={zone}
        />
      ) : null}

      {step === 'welcome' ? (
        <WelcomeStep
          cfp={cfp}
          windowState={windowState}
          onStart={() => {
            setStep('account')
          }}
        />
      ) : null}

      {step === 'account' ? (
        <AccountStep
          isLoading={isLoading}
          provisioned={provisioned}
          authError={authError}
          onRetryAuth={retry}
          startError={start.error}
          startPending={start.pending}
          windowState={windowState}
          hasDraft={existingDraft !== null}
          onResume={() => {
            if (existingDraft !== null) adoptProposal(existingDraft.proposal._id)
          }}
          onContinue={beginProposal}
          onBack={() => {
            setStep('welcome')
          }}
        />
      ) : null}

      {proposalId !== null &&
      (step === 'submission' || step === 'participants' || step === 'review') ? (
        <ProposalSteps
          key={proposalId}
          proposalId={proposalId}
          eventSlug={eventSlug}
          zone={zone}
          step={step}
          setStep={setStep}
          flagged={flagged}
          setFlagged={setFlagged}
          windowState={windowState}
          onSubmitted={(message) => {
            clearStoredProposal(eventSlug)
            setSuccess({ message })
          }}
        />
      ) : null}
    </PageBody>
  )
}

// ── Stepper ──────────────────────────────────────────────────────────────

function Stepper({
  currentIndex,
  reachableIndex,
  onSelect,
}: {
  currentIndex: number
  reachableIndex: number
  onSelect: (id: StepId) => void
}) {
  return (
    <nav
      aria-label="Submission steps"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-2)',
      }}
    >
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-2)' }}
      >
        {STEPS.map((s, index) => {
          const reachable = index <= reachableIndex
          const done = index < currentIndex
          const current = index === currentIndex
          return (
            <Fragment key={s.id}>
              {index > 0 ? (
                <span
                  style={{
                    flex: 1,
                    height: 'var(--space-px)',
                    background:
                      index <= currentIndex
                        ? 'var(--border-strong)'
                        : 'var(--border-subtle)',
                  }}
                />
              ) : null}
              <button
                type="button"
                disabled={!reachable}
                aria-current={current ? 'step' : undefined}
                onClick={() => {
                  onSelect(s.id)
                }}
                title={s.label}
                style={{
                  width: 'var(--space-7)',
                  height: 'var(--space-7)',
                  flex: 'none',
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 'var(--radius-full)',
                  border: `var(--space-px) solid ${
                    current ? 'var(--border-brand)' : 'var(--border-default)'
                  }`,
                  background:
                    done || current
                      ? 'var(--surface-inverse)'
                      : 'var(--surface-card)',
                  color:
                    done || current
                      ? 'var(--text-inverse)'
                      : 'var(--text-tertiary)',
                  font: 'var(--type-mono)',
                  cursor: reachable ? 'pointer' : 'not-allowed',
                  opacity: reachable ? 1 : 0.45,
                  boxShadow: current ? 'var(--shadow-focus)' : 'none',
                }}
              >
                {index + 1}
              </button>
            </Fragment>
          )
        })}
      </div>
      <span style={{ font: 'var(--type-caption)', color: 'var(--text-secondary)' }}>
        Step {currentIndex + 1} of {STEPS.length} · {STEPS[currentIndex].label}
      </span>
    </nav>
  )
}

// ── Steps ────────────────────────────────────────────────────────────────

function WelcomeStep({
  cfp,
  windowState,
  onStart,
}: {
  cfp: PublicCfp
  windowState: WindowState
  onStart: () => void
}) {
  const zone = cfp.event.timezone
  const questionCount = allFields(cfp.form).length

  return (
    <Card
      title={`Submit to ${cfp.event.name}`}
      subtitle="Here is what to expect before you start."
      footer={
        <Button
          variant="primary"
          onClick={onStart}
          disabled={windowState !== 'open'}
        >
          Start
        </Button>
      }
    >
      <DescriptionList
        items={[
          {
            term: 'Event',
            value: (
              <Mono>
                {formatDateRange(
                  cfp.event.startsAt,
                  cfp.event.endsAt,
                  zone,
                )}
              </Mono>
            ),
          },
          ...(cfp.event.location !== undefined
            ? [{ term: 'Location', value: cfp.event.location }]
            : []),
          {
            term: 'The form',
            value: `${cfp.form.sections.length} section${
              cfp.form.sections.length === 1 ? '' : 's'
            }, ${questionCount} question${questionCount === 1 ? '' : 's'}`,
          },
          {
            term: 'Closes',
            value:
              cfp.cfpCloseAt === undefined ? (
                'No closing date announced'
              ) : (
                <Mono>{formatDateTime(cfp.cfpCloseAt, zone)}</Mono>
              ),
          },
        ]}
      />
      <ul
        style={{
          marginTop: 'var(--space-4)',
          paddingLeft: 'var(--space-5)',
          color: 'var(--text-secondary)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-2)',
        }}
      >
        <li>
          Your answers save as you type. You can leave and come back at any
          point before the call closes.
        </li>
        <li>
          You will create a StageStack account first — that account is how you
          edit or withdraw the proposal later.
        </li>
        <li>
          You can list up to 10 speakers. One of them is the primary contact.
        </li>
      </ul>
    </Card>
  )
}

function AccountStep({
  isLoading,
  provisioned,
  authError,
  onRetryAuth,
  startError,
  startPending,
  windowState,
  hasDraft,
  onResume,
  onContinue,
  onBack,
}: {
  isLoading: boolean
  provisioned: boolean
  authError: string | null
  onRetryAuth: () => void
  startError: string | null
  startPending: boolean
  windowState: WindowState
  hasDraft: boolean
  onResume: () => void
  onContinue: () => void
  onBack: () => void
}) {
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? null

  if (isLoading) {
    return (
      <Card title="Your account">
        <p style={{ color: 'var(--text-tertiary)' }}>Checking your session…</p>
      </Card>
    )
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <Show when="signed-out">
        <Card
          title="Create your account first"
          subtitle="It takes a moment and it is what makes the rest of this possible."
          footer={
            <>
              <Button onClick={onBack}>Back</Button>
              <SignInButton mode="modal">
                <Button variant="primary">Sign in to continue</Button>
              </SignInButton>
            </>
          }
        >
          <ul
            style={{
              paddingLeft: 'var(--space-5)',
              color: 'var(--text-secondary)',
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-2)',
            }}
          >
            <li>Your draft is saved as you type, on any device.</li>
            <li>You can come back and edit until the call closes.</li>
            <li>
              You can withdraw the proposal yourself, without emailing anyone.
            </li>
          </ul>
          <p
            style={{
              marginTop: 'var(--space-4)',
              font: 'var(--type-caption)',
              color: 'var(--text-tertiary)',
            }}
          >
            New to StageStack?{' '}
            <SignUpButton mode="modal">
              <Button variant="ghost" size="sm">
                Create an account
              </Button>
            </SignUpButton>
          </p>
        </Card>
      </Show>

      <Show when="signed-in">
        <Card
          title="You are signed in"
          subtitle={
            email === null
              ? 'Everything about this proposal goes to your account.'
              : `Everything about this proposal goes to ${email}.`
          }
          footer={
            <>
              <Button onClick={onBack} disabled={startPending}>
                Back
              </Button>
              <Button
                variant="primary"
                onClick={onContinue}
                disabled={!provisioned || startPending || windowState !== 'open'}
              >
                {startPending ? 'Starting…' : 'Continue'}
              </Button>
            </>
          }
        >
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 'var(--space-4)',
            }}
          >
            {authError !== null ? (
              <Callout
                tone="blocked"
                title="Could not prepare your account"
                actions={
                  <Button variant="primary" onClick={onRetryAuth}>
                    Try again
                  </Button>
                }
              >
                {authError}
              </Callout>
            ) : null}
            {startError !== null ? (
              <Callout tone="blocked" title="This proposal could not be started">
                {startError}
              </Callout>
            ) : null}
            {hasDraft ? (
              <Callout
                tone="info"
                title="You already have a draft for this event"
                actions={
                  <>
                    <Button variant="primary" onClick={onResume}>
                      Resume draft
                    </Button>
                    <Button onClick={onContinue} disabled={startPending}>
                      Start another proposal
                    </Button>
                  </>
                }
              >
                Resuming keeps everything you have already written.
              </Callout>
            ) : (
              <p style={{ color: 'var(--text-secondary)' }}>
                Continue to the form. Nothing is sent to the organizers until
                you submit on the last step.
              </p>
            )}
          </div>
        </Card>
      </Show>
    </div>
  )
}

// ── Proposal-backed steps ────────────────────────────────────────────────

function ProposalSteps(props: {
  proposalId: Id<'proposals'>
  eventSlug: string
  zone: string
  step: StepId
  setStep: (id: StepId) => void
  flagged: ReadonlySet<string>
  setFlagged: (next: ReadonlySet<string>) => void
  windowState: WindowState
  onSubmitted: (message: string | null) => void
}) {
  const data = useQuery(api.cfp.getMyProposal, {
    proposalId: props.proposalId,
  })

  if (data === undefined) {
    return (
      <Card>
        <p style={{ color: 'var(--text-tertiary)' }}>Loading your draft…</p>
      </Card>
    )
  }

  return <ProposalStepsInner {...props} data={data} />
}

type MyProposalView = FunctionReturnType<typeof api.cfp.getMyProposal>

function ProposalStepsInner({
  proposalId,
  eventSlug,
  zone,
  step,
  setStep,
  flagged,
  setFlagged,
  windowState,
  onSubmitted,
  data,
}: {
  proposalId: Id<'proposals'>
  eventSlug: string
  zone: string
  step: StepId
  setStep: (id: StepId) => void
  flagged: ReadonlySet<string>
  setFlagged: (next: ReadonlySet<string>) => void
  windowState: WindowState
  onSubmitted: (message: string | null) => void
  data: MyProposalView
}) {
  const answersDraft = useAnswersDraft(proposalId, data.proposal.answers)
  const speakersDraft = useSpeakersDraft(proposalId, data.speakers)
  const submitProposal = useMutation(api.cfp.submitProposal)
  const submit = usePending()
  const { user } = useUser()

  const editable = windowState === 'open'
  const missing = missingAnswers(data.form, answersDraft.answers)
  const nameless = incompleteSpeakers(speakersDraft.speakers)
  const blockers = missing.length + nameless.length

  const self =
    user === null || user === undefined
      ? undefined
      : {
          firstName: user.firstName ?? '',
          lastName: user.lastName ?? '',
          email: user.primaryEmailAddress?.emailAddress ?? '',
        }

  const goto = (next: StepId) => {
    void answersDraft.autosave.flush()
    void speakersDraft.autosave.flush()
    if (next === 'review') {
      setFlagged(new Set(missing.map((m) => m.field.id)))
    }
    setStep(next)
  }

  const jumpToField = (fieldId: string) => {
    setFlagged(new Set(missing.map((m) => m.field.id)))
    setStep('submission')
    setTimeout(() => {
      const el = document.getElementById(fieldDomId(fieldId))
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      el?.focus()
    }, 60)
  }

  const doSubmit = () => {
    void submit.run(async () => {
      await answersDraft.saveNow()
      await speakersDraft.saveNow()
      const result = await submitProposal({ proposalId })
      onSubmitted(result.successMessage)
    })
  }

  if (step === 'submission') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
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
          disabled={!editable}
          flagged={flagged}
          uploadedNames={answersDraft.uploadedNames}
          onUploaded={answersDraft.noteUpload}
        />
        <StepBar
          status={saveStatusLabel(answersDraft.autosave.status)}
          statusTone={answersDraft.autosave.status === 'error' ? 'danger' : 'muted'}
          left={
            <>
              <Button
                onClick={() => {
                  goto('account')
                }}
              >
                Back
              </Button>
              <Button
                iconLeft="download"
                onClick={() => {
                  void answersDraft.saveNow()
                }}
                disabled={!editable}
              >
                Save draft
              </Button>
            </>
          }
          right={
            <Button
              variant="primary"
              iconRight="arrow-right"
              onClick={() => {
                goto('participants')
              }}
            >
              Continue
            </Button>
          }
        />
      </div>
    )
  }

  if (step === 'participants') {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--space-4)',
        }}
      >
        <PageHeader
          title="Who is speaking?"
          description="At least one speaker is required. The primary contact receives everything about this proposal."
        />
        {speakersDraft.autosave.error !== null ? (
          <Callout tone="blocked" title="Your last change was not saved">
            {speakersDraft.autosave.error}
          </Callout>
        ) : null}
        <SpeakersEditor
          speakers={speakersDraft.speakers}
          onChange={speakersDraft.setSpeakers}
          disabled={!editable}
          self={self}
        />
        <StepBar
          status={
            speakersDraft.incomplete
              ? 'Add a first and last name to save'
              : saveStatusLabel(speakersDraft.autosave.status)
          }
          statusTone={
            speakersDraft.incomplete || speakersDraft.autosave.status === 'error'
              ? 'danger'
              : 'muted'
          }
          left={
            <Button
              onClick={() => {
                goto('submission')
              }}
            >
              Back
            </Button>
          }
          right={
            <Button
              variant="primary"
              iconRight="arrow-right"
              onClick={() => {
                goto('review')
              }}
            >
              Review
            </Button>
          }
        />
      </div>
    )
  }

  return (
    <div
      style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}
    >
      <PageHeader
        title="Review and submit"
        description={`Nothing has been sent to the organizers of ${data.event.name} yet.`}
      />
      {submit.error !== null ? (
        <Callout tone="blocked" title="This proposal was not submitted">
          {submit.error}
        </Callout>
      ) : null}
      {windowState !== 'open' ? (
        <Callout tone="attention" title="This call is not accepting submissions">
          You can still edit your draft, but it cannot be submitted until the
          organizers reopen the call.
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
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStep('participants')
                  }}
                >
                  Speaker {index + 1}
                </Button>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>
                  Needs a first and last name.
                </span>
              </li>
            ))}
          </ul>
        </Callout>
      ) : null}

      <CfpAnswersSummary
        form={data.form}
        answers={answersDraft.answers}
        uploadedNames={answersDraft.uploadedNames}
      />
      <Card title="Speakers">
        <SpeakersSummary speakers={speakersDraft.speakers} />
      </Card>

      <StepBar
        status={
          blockers === 0 ? 'Submitting notifies the organizers.' : null
        }
        statusTone="muted"
        left={
          <Button
            onClick={() => {
              goto('participants')
            }}
            disabled={submit.pending}
          >
            Back
          </Button>
        }
        right={
          <Button
            variant="primary"
            onClick={doSubmit}
            disabled={submit.pending || blockers > 0 || windowState !== 'open'}
          >
            {submit.pending ? 'Submitting…' : 'Submit proposal'}
          </Button>
        }
      />
      <p
        style={{
          font: 'var(--type-caption)',
          color: 'var(--text-tertiary)',
          margin: 'var(--space-0)',
        }}
      >
        After submitting you can keep editing from{' '}
        <Link
          to="/cfp/$eventSlug/proposal/$proposalId"
          params={{ eventSlug, proposalId }}
        >
          your proposal page
        </Link>{' '}
        until the call closes. Times are shown in <Mono>{zone}</Mono>.
      </p>
    </div>
  )
}

function StepBar({
  left,
  right,
  status,
  statusTone,
}: {
  left: React.ReactNode
  right: React.ReactNode
  status: string | null
  statusTone: 'muted' | 'danger'
}) {
  return (
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
      <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
        {left}
      </div>
      <div
        style={{
          marginLeft: 'auto',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
        }}
      >
        <SaveIndicator label={status} tone={statusTone} />
        {right}
      </div>
    </div>
  )
}

// ── Success ──────────────────────────────────────────────────────────────

function SuccessScreen({
  eventSlug,
  eventName,
  proposalId,
  message,
}: {
  eventSlug: string
  eventName: string
  proposalId: Id<'proposals'> | null
  message: string | null
}) {
  const { user } = useUser()
  const email = user?.primaryEmailAddress?.emailAddress ?? null

  return (
    <PageBody narrow>
      <Card
        title="Your proposal is in"
        subtitle={`Submitted to ${eventName}.`}
        actions={<StatusPill status="Submitted" />}
        footer={
          <>
            <Link to="/cfp/$eventSlug" params={{ eventSlug }}>
              <Button>Back to the call</Button>
            </Link>
            {proposalId !== null ? (
              <Link
                to="/cfp/$eventSlug/proposal/$proposalId"
                params={{ eventSlug, proposalId }}
              >
                <Button variant="primary" iconRight="arrow-right">
                  Manage your proposal
                </Button>
              </Link>
            ) : null}
          </>
        }
      >
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 'var(--space-4)',
          }}
        >
          <p
            style={{
              font: 'var(--type-body-lg)',
              color: 'var(--text-secondary)',
              whiteSpace: 'pre-wrap',
              margin: 'var(--space-0)',
            }}
          >
            {message ??
              'Thank you. The organizers have your proposal and will be in touch about their decision.'}
          </p>
          <p style={{ color: 'var(--text-tertiary)', margin: 'var(--space-0)' }}>
            {email === null
              ? 'A confirmation email is on its way.'
              : `A confirmation was sent to ${email}.`}
          </p>
        </div>
      </Card>
    </PageBody>
  )
}
