import { useId, useState } from 'react'
import { useMutation } from 'convex/react'
import { api } from '@convex/_generated/api'
import { Modal } from './Modal'
import { Button, Field, IconButton, Input, Textarea } from '~/ds'
import { usePending } from '~/lib/usePending'
import { pushToast } from '~/components/toast'

// Manual add: the proposal an organizer took over email, or the invited
// keynote who was never going to fill in a CFP form. It lands as Submitted,
// exactly like a real submission, so the rest of the pipeline treats it alike.

type SpeakerInput = { firstName: string; lastName: string; email: string }

const BLANK: SpeakerInput = { firstName: '', lastName: '', email: '' }

export function AddProposalDialog({
  eventSlug,
  onClose,
}: {
  eventSlug: string
  onClose: () => void
}) {
  const create = useMutation(api.cfp.createManualProposal)
  // Speaker inputs need ids to be labelable, and the dialog can be mounted
  // beside other forms — a bare `speaker-0-first` would collide with them.
  const uid = useId()
  const { pending, error, setError, run } = usePending()
  const [title, setTitle] = useState('')
  const [abstract, setAbstract] = useState('')
  const [speakers, setSpeakers] = useState<Array<SpeakerInput>>([{ ...BLANK }])

  const patch = (index: number, next: Partial<SpeakerInput>) => {
    setSpeakers((list) =>
      list.map((s, i) => (i === index ? { ...s, ...next } : s)),
    )
  }

  const submit = () => {
    if (title.trim() === '') return setError('The proposal needs a title.')
    const cleaned = speakers
      .map((s) => ({
        firstName: s.firstName.trim(),
        lastName: s.lastName.trim(),
        email: s.email.trim() === '' ? undefined : s.email.trim(),
      }))
      .filter((s) => s.firstName !== '' || s.lastName !== '')
    if (cleaned.length === 0) return setError('Name at least one speaker.')
    void run(async () => {
      await create({
        eventSlug,
        title: title.trim(),
        abstract: abstract.trim() === '' ? undefined : abstract.trim(),
        speakers: cleaned,
      })
      pushToast('Proposal added', `${title.trim()} is now Submitted.`)
      onClose()
    })
  }

  return (
    <Modal
      title="Add proposal"
      description="Entered on a submitter's behalf. It arrives as Submitted and can be reviewed and decided like any other."
      width={640}
      onClose={onClose}
      footer={
        <>
          {error !== null ? (
            <span
              style={{
                color: 'var(--text-danger)',
                font: 'var(--type-caption)',
                marginRight: 'auto',
              }}
            >
              {error}
            </span>
          ) : null}
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={submit} disabled={pending}>
            {pending ? 'Adding…' : 'Add proposal'}
          </Button>
        </>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        <Field label="Title" htmlFor="add-title" required>
          <Input
            id="add-title"
            value={title}
            autoFocus
            placeholder="Shipping agents that survive contact with production"
            onChange={(e) => setTitle(e.target.value)}
          />
        </Field>
        <Field label="Abstract" htmlFor="add-abstract" optional>
          <Textarea
            id="add-abstract"
            rows={5}
            value={abstract}
            onChange={(e) => setAbstract(e.target.value)}
          />
        </Field>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          <span style={{ font: 'var(--type-label)' }}>Speakers</span>
          {speakers.map((speaker, index) => (
            <div
              key={index}
              style={{
                display: 'grid',
                gridTemplateColumns:
                  'minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.4fr) auto',
                gap: 'var(--space-2)',
                alignItems: 'end',
              }}
            >
              {/* Only the first row carries visible column headings, so every
                  later row names its own inputs instead. */}
              <Field
                label={index === 0 ? 'First name' : undefined}
                htmlFor={`${uid}-${index}-first`}
              >
                <Input
                  id={`${uid}-${index}-first`}
                  aria-label={
                    index === 0 ? undefined : `First name, speaker ${index + 1}`
                  }
                  value={speaker.firstName}
                  placeholder="First"
                  onChange={(e) => patch(index, { firstName: e.target.value })}
                />
              </Field>
              <Field
                label={index === 0 ? 'Last name' : undefined}
                htmlFor={`${uid}-${index}-last`}
              >
                <Input
                  id={`${uid}-${index}-last`}
                  aria-label={
                    index === 0 ? undefined : `Last name, speaker ${index + 1}`
                  }
                  value={speaker.lastName}
                  placeholder="Last"
                  onChange={(e) => patch(index, { lastName: e.target.value })}
                />
              </Field>
              <Field
                label={index === 0 ? 'Email' : undefined}
                htmlFor={`${uid}-${index}-email`}
              >
                <Input
                  id={`${uid}-${index}-email`}
                  type="email"
                  aria-label={
                    index === 0 ? undefined : `Email, speaker ${index + 1}`
                  }
                  value={speaker.email}
                  placeholder="speaker@example.com"
                  onChange={(e) => patch(index, { email: e.target.value })}
                />
              </Field>
              <IconButton
                icon="trash-2"
                label={`Remove speaker ${index + 1}`}
                disabled={speakers.length === 1}
                onClick={() =>
                  setSpeakers((list) => list.filter((_, i) => i !== index))
                }
              />
            </div>
          ))}
          <div>
            <Button
              size="sm"
              iconLeft="plus"
              disabled={speakers.length >= 10}
              onClick={() => setSpeakers((list) => [...list, { ...BLANK }])}
            >
              Add speaker
            </Button>
          </div>
        </div>
      </div>
    </Modal>
  )
}
